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
 *   POST /api/reviews  { action: "getThumbsUpStatus", contractorId, homeownerId }
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
 *
 * Also keeps contractors.thumbs_up_count in sync -- that denormalized
 * counter is what the directory list actually reads (see rowToContractor
 * in contractors.js), so every contractor card can show a live count
 * without an extra per-card API call. The thumbs_up table remains the
 * source of truth for "who has thumbs-upped this contractor" and enforces
 * one-per-homeowner via its unique constraint; this counter is just a
 * fast-read cache of its count.
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
    await decrementThumbsUpCount(cId);
    return { thumbsUp: false };
  }

  const { error: insertError } = await supabase.from("thumbs_up").insert({ contractor_id: cId, homeowner_id: hId });
  if (insertError) throw new Error("Could not add thumbs up: " + insertError.message);
  await incrementThumbsUpCount(cId);
  return { thumbsUp: true };
}

/**
 * Small helpers that bump the denormalized counter. Read-then-write rather
 * than a single atomic SQL increment, since the Supabase JS client doesn't
 * expose raw SQL expressions for updates -- acceptable here because thumbs
 * up isn't a high-contention path (one click per homeowner per contractor,
 * not a hot counter being hit many times per second).
 */
async function incrementThumbsUpCount(contractorId) {
  const { data, error: readError } = await supabase
    .from("contractors")
    .select("thumbs_up_count")
    .eq("id", contractorId)
    .single();
  if (readError) throw new Error("Could not read thumbs up count: " + readError.message);
  const { error: writeError } = await supabase
    .from("contractors")
    .update({ thumbs_up_count: (data.thumbs_up_count || 0) + 1 })
    .eq("id", contractorId);
  if (writeError) throw new Error("Could not update thumbs up count: " + writeError.message);
}

async function decrementThumbsUpCount(contractorId) {
  const { data, error: readError } = await supabase
    .from("contractors")
    .select("thumbs_up_count")
    .eq("id", contractorId)
    .single();
  if (readError) throw new Error("Could not read thumbs up count: " + readError.message);
  const next = Math.max(0, (data.thumbs_up_count || 0) - 1);
  const { error: writeError } = await supabase.from("contractors").update({ thumbs_up_count: next }).eq("id", contractorId);
  if (writeError) throw new Error("Could not update thumbs up count: " + writeError.message);
}

/**
 * Returns whether a given homeowner has already thumbs-upped a contractor --
 * used to render the thumbs-up button as already-active. The COUNT itself
 * is no longer fetched here; it lives on contractors.thumbs_up_count and
 * comes back for free with the normal contractor list/profile fetch.
 */
async function getThumbsUpStatus(contractorId, homeownerId) {
  if (!homeownerId) return { alreadyThumbsUpped: false };
  const { data, error } = await supabase
    .from("thumbs_up")
    .select("id")
    .eq("contractor_id", toId(contractorId))
    .eq("homeowner_id", toId(homeownerId))
    .maybeSingle();
  if (error) throw new Error("Could not check thumbs up status: " + error.message);
  return { alreadyThumbsUpped: !!data };
}

async function getAuthedUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

async function handleReviewsRequest(body, req) {
  const { action } = body || {};

  try {
    // Public read -- no auth required.
    if (action === "listForContractor") {
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const reviews = await listReviewsForContractor(body.contractorId);
      return { statusCode: 200, body: { reviews } };
    }

    if (action === "getThumbsUpStatus") {
      if (!body.contractorId) {
        return { statusCode: 400, body: { error: "contractorId is required." } };
      }
      // Derive homeownerId from session -- don't trust client-supplied value
      const authUser = await getAuthedUser(req);
      let homeownerId = null;
      if (authUser) {
        const { data: homeownerRow } = await supabase
          .from("homeowners").select("id").eq("auth_user_id", authUser.id).maybeSingle();
        homeownerId = homeownerRow?.id ?? null;
      }
      if (!homeownerId) {
        return { statusCode: 200, body: { alreadyThumbsUpped: false } };
      }
      const status = await getThumbsUpStatus(body.contractorId, homeownerId);
      return { statusCode: 200, body: status };
    }

    // Write actions require a verified session.
    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return { statusCode: 401, body: { error: "You must be signed in." } };
    }

    // Derive homeownerId from the verified session.
    const { data: homeownerRow } = await supabase
      .from("homeowners").select("id").eq("auth_user_id", authUser.id).maybeSingle();
    const homeownerId = homeownerRow?.id ?? null;

    if (action === "create") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const { contractorId, jobId, rating } = body;
      if (!contractorId || !jobId || !rating) {
        return { statusCode: 400, body: { error: "contractorId, jobId, and rating are required." } };
      }
      if (rating < 1 || rating > 5) {
        return { statusCode: 400, body: { error: "rating must be between 1 and 5." } };
      }
      // homeownerId comes from the verified session, not the request body.
      const review = await createReview({ contractorId, homeownerId, jobId, rating, text: body.text });
      return { statusCode: 200, body: { review } };
    }

    if (action === "toggleThumbsUp") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      if (!body.contractorId) {
        return { statusCode: 400, body: { error: "contractorId is required." } };
      }
      // homeownerId comes from the verified session.
      const result = await toggleThumbsUp(body.contractorId, homeownerId);
      return { statusCode: 200, body: result };
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleReviewsRequest(req.body, req);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleReviewsRequest = handleReviewsRequest;
module.exports.rowToReview = rowToReview;
