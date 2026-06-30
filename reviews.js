/**
 * api/reviews.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for reviews (star rating + text, tied to a confirmed job)
 * and thumbs up (lightweight, toggleable, no job required).
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/reviews  { action: "create", contractorId, homeownerId, jobId, rating, text }
 *   POST /api/reviews  { action: "listForContractor", contractorId }
 *   POST /api/reviews  { action: "toggleThumbsUp", contractorId, homeownerId }
 *   POST /api/reviews  { action: "getThumbsUpSummary", contractorId, homeownerId? }
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

/** See the matching comment in jobs.js / quotes.js -- ids are int8 in the database. */
function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

function rowToReview(row) {
  return {
    id: row.id,
    contractorId: row.contractor_id,
    homeownerId: row.homeowner_id,
    jobId: row.job_id,
    rating: row.rating,
    text: row.text_review || "",
    createdAt: row.created_at,
  };
}

/**
 * Creates a review. Requires a confirmed job (status === "confirmed" or
 * "paid") belonging to BOTH the contractor and homeowner given -- this is
 * the server-side guarantee that reviews can't be faked for jobs that
 * never happened or weren't actually confirmed by the homeowner. The
 * database's unique constraint on job_id is the second layer of defense
 * against double-reviewing the same job.
 */
async function createReview({ contractorId, homeownerId, jobId, rating, text }) {
  const { data: job, error: jobError } = await supabase
    .from("completed_jobs")
    .select("id, contractor_id, homeowner_id, status")
    .eq("id", toId(jobId))
    .maybeSingle();

  if (jobError) throw new Error("Could not look up job: " + jobError.message);
  if (!job) throw new Error("Job not found.");
  if (!(job.status === "confirmed" || job.status === "paid")) {
    throw new Error("You can only review a job after confirming its completion.");
  }
  if (String(job.contractor_id) !== String(toId(contractorId)) || String(job.homeowner_id) !== String(toId(homeownerId))) {
    throw new Error("This job does not belong to this contractor/homeowner pair.");
  }

  const { data, error } = await supabase
    .from("reviews")
    .insert({
      contractor_id: toId(contractorId),
      homeowner_id: toId(homeownerId),
      job_id: toId(jobId),
      rating,
      text_review: text || null,
    })
    .select()
    .single();

  if (error) {
    // Postgres unique_violation code -- means this job already has a review.
    if (error.code === "23505") {
      throw new Error("You've already left a review for this job.");
    }
    throw new Error("Could not create review: " + error.message);
  }
  return rowToReview(data);
}

async function listReviewsForContractor(contractorId) {
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("contractor_id", toId(contractorId))
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list reviews: " + error.message);
  return data.map(rowToReview);
}

/**
 * Toggles a thumbs up for a contractor from a given homeowner. If one
 * already exists, removes it (un-thumbs-up). If not, creates it. No job
 * required -- this is intentionally open to anyone with a homeowner
 * account, even for work done off-platform, since there's no rating
 * attached that could be used to sabotage a contractor (only positive
 * signal, never negative).
 */
async function toggleThumbsUp(contractorId, homeownerId) {
  const cId = toId(contractorId);
  const hId = toId(homeownerId);

  const { data: existing, error: lookupError } = await supabase
    .from("thumbs_up")
    .select("id")
    .eq("contractor_id", cId)
    .eq("homeowner_id", hId)
    .maybeSingle();
  if (lookupError) throw new Error("Could not check thumbs up status: " + lookupError.message);

  if (existing) {
    const { error: deleteError } = await supabase.from("thumbs_up").delete().eq("id", existing.id);
    if (deleteError) throw new Error("Could not remove thumbs up: " + deleteError.message);
    return { thumbsUp: false };
  }

  const { error: insertError } = await supabase.from("thumbs_up").insert({ contractor_id: cId, homeowner_id: hId });
  if (insertError) throw new Error("Could not add thumbs up: " + insertError.message);
  return { thumbsUp: true };
}

/**
 * Returns the total thumbs up count for a contractor, plus -- if a
 * homeownerId is provided -- whether THAT homeowner has already thumbs-upped
 * them (so the frontend can render the button as already-active).
 */
async function getThumbsUpSummary(contractorId, homeownerId) {
  const cId = toId(contractorId);

  const { count, error: countError } = await supabase
    .from("thumbs_up")
    .select("id", { count: "exact", head: true })
    .eq("contractor_id", cId);
  if (countError) throw new Error("Could not count thumbs up: " + countError.message);

  let alreadyThumbsUpped = false;
  if (homeownerId) {
    const { data, error } = await supabase
      .from("thumbs_up")
      .select("id")
      .eq("contractor_id", cId)
      .eq("homeowner_id", toId(homeownerId))
      .maybeSingle();
    if (error) throw new Error("Could not check thumbs up status: " + error.message);
    alreadyThumbsUpped = !!data;
  }

  return { count: count || 0, alreadyThumbsUpped };
}

async function handleReviewsRequest(body) {
  const { action } = body || {};

  try {
    if (action === "create") {
      const { contractorId, homeownerId, jobId, rating } = body;
      if (!contractorId || !homeownerId || !jobId || !rating) {
        return { statusCode: 400, body: { error: "contractorId, homeownerId, jobId, and rating are required." } };
      }
      if (rating < 1 || rating > 5) {
        return { statusCode: 400, body: { error: "rating must be between 1 and 5." } };
      }
      const review = await createReview(body);
      return { statusCode: 200, body: { review } };
    }

    if (action === "listForContractor") {
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const reviews = await listReviewsForContractor(body.contractorId);
      return { statusCode: 200, body: { reviews } };
    }

    if (action === "toggleThumbsUp") {
      if (!body.contractorId || !body.homeownerId) {
        return { statusCode: 400, body: { error: "contractorId and homeownerId are required." } };
      }
      const result = await toggleThumbsUp(body.contractorId, body.homeownerId);
      return { statusCode: 200, body: result };
    }

    if (action === "getThumbsUpSummary") {
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const summary = await getThumbsUpSummary(body.contractorId, body.homeownerId);
      return { statusCode: 200, body: summary };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("reviews handler error:", err);
    return { statusCode: 500, body: { error: err.message } };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleReviewsRequest(req.body);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleReviewsRequest = handleReviewsRequest;
module.exports.rowToReview = rowToReview;
