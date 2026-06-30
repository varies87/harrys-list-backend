/**
 * api/jobs.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for completed jobs: a contractor reporting a job done
 * (with the final amount), a homeowner confirming or disputing that amount,
 * and marking a job's fee as paid (called after a successful Stripe charge,
 * via create-payment-intent.js's companion confirm step -- see note below).
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/jobs  { action: "report", contractorId, quoteRequestId, homeownerId, description, reportedAmount, lowReportReason? }
 *   POST /api/jobs  { action: "listForContractor", contractorId }
 *   POST /api/jobs  { action: "listForHomeowner", homeownerId }
 *   POST /api/jobs  { action: "confirm", jobId }
 *   POST /api/jobs  { action: "dispute", jobId, note }
 *   POST /api/jobs  { action: "markPaid", jobId }
 *   POST /api/jobs  { action: "listLowReportContractors" }              <- new, admin only
 *   POST /api/jobs  { action: "setAdminReviewStatus", contractorId, status }  <- new, admin only
 *
 * NOTE on markPaid: this version marks a job paid directly when called. In
 * production, prefer driving this from a Stripe webhook (a notification
 * Stripe sends your server when a charge actually succeeds) rather than
 * letting the frontend call it directly -- a webhook can't be faked by
 * someone editing browser JavaScript, whereas a direct frontend call
 * technically could be. Wiring up a webhook is a reasonable next step once
 * the rest of this is live and tested.
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

/**
 * See the matching comment in quotes.js -- every id column here is int8,
 * not uuid, so ids must be converted to numbers before being used in a
 * query. IDs arrive as strings from the frontend over JSON.
 */
function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

/**
 * A report counts as "low" if the reported amount is more than 10% below
 * what the contractor originally quoted. This threshold was chosen to ignore
 * trivial rounding differences and only flag meaningful discrepancies.
 */
const LOW_REPORT_THRESHOLD = 0.10;

function isLowReport(quotedAmount, reportedAmount) {
  if (!quotedAmount || quotedAmount <= 0) return false;
  return reportedAmount < quotedAmount * (1 - LOW_REPORT_THRESHOLD);
}

function rowToJob(row) {
  return {
    id: row.id,
    contractorId: row.contractor_id,
    homeownerId: row.homeowner_id,
    quoteRequestId: row.quote_request_id,
    description: row.description,
    reportedAmount: Number(row.reported_amount),
    quotedAmount: row.quoted_amount != null ? Number(row.quoted_amount) : null,
    isLowReport: !!row.is_low_report,
    lowReportReason: row.low_report_reason || undefined,
    status: row.status,
    reportedAt: row.created_at,
    confirmedAt: row.confirmed_at || undefined,
    disputeNote: row.dispute_note || undefined,
    feePaid: !!row.fee_paid,
    feePaidAt: row.fee_paid_at || undefined,
  };
}

async function reportJob({ contractorId, quoteRequestId, homeownerId, description, reportedAmount, lowReportReason }) {
  // Look up the original quoted price so we can compare it to what's being reported.
  // We join quote_recipients on both quote_request_id AND contractor_id so we get
  // exactly the quote this contractor sent for this job -- not someone else's quote
  // on the same request.
  let quotedAmount = null;
  if (quoteRequestId && contractorId) {
    const { data: quoteRow } = await supabase
      .from("quote_recipients")
      .select("quote_price")
      .eq("quote_request_id", toId(quoteRequestId))
      .eq("contractor_id", toId(contractorId))
      .maybeSingle();
    if (quoteRow) quotedAmount = Number(quoteRow.quote_price);
  }

  const low = isLowReport(quotedAmount, Number(reportedAmount));

  // If the report is meaningfully lower than the quote, a reason is required.
  if (low && !lowReportReason) {
    throw new Error(
      "The reported amount is more than 10% below your original quote. Please provide a reason."
    );
  }

  const { data, error } = await supabase
    .from("completed_jobs")
    .insert({
      contractor_id: toId(contractorId),
      quote_request_id: toId(quoteRequestId),
      homeowner_id: toId(homeownerId),
      description,
      reported_amount: reportedAmount,
      quoted_amount: quotedAmount,
      is_low_report: low,
      low_report_reason: low ? lowReportReason : null,
      status: "pending_confirmation",
      fee_paid: false,
    })
    .select()
    .single();
  if (error) throw new Error("Could not report job: " + error.message);
  return rowToJob(data);
}

async function listJobsForContractor(contractorId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .select("*")
    .eq("contractor_id", toId(contractorId))
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list jobs: " + error.message);
  return data.map(rowToJob);
}

async function listJobsForHomeowner(homeownerId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .select("*")
    .eq("homeowner_id", toId(homeownerId))
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list jobs: " + error.message);
  return data.map(rowToJob);
}

async function confirmJob(jobId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", toId(jobId))
    .select()
    .single();
  if (error) throw new Error("Could not confirm job: " + error.message);
  return rowToJob(data);
}

async function disputeJob(jobId, note) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .update({ status: "disputed", dispute_note: note || "Homeowner disputed this amount." })
    .eq("id", toId(jobId))
    .select()
    .single();
  if (error) throw new Error("Could not dispute job: " + error.message);
  return rowToJob(data);
}

async function markJobPaid(jobId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .update({ status: "paid", fee_paid: true, fee_paid_at: new Date().toISOString() })
    .eq("id", toId(jobId))
    .select()
    .single();
  if (error) throw new Error("Could not mark job paid: " + error.message);
  return rowToJob(data);
}

/**
 * For the admin console. Returns every contractor who has 3 or more low-report
 * jobs, along with their current admin_review_status, their total low-report
 * count, and the individual low-report jobs so the admin can read the reasons.
 */
async function listLowReportContractors() {
  // Pull all low-report jobs with contractor info joined.
  const { data: jobs, error: jobsError } = await supabase
    .from("completed_jobs")
    .select(`
      id,
      contractor_id,
      description,
      quoted_amount,
      reported_amount,
      low_report_reason,
      created_at,
      contractors (
        id,
        name,
        trade,
        email,
        admin_review_status
      )
    `)
    .eq("is_low_report", true)
    .order("created_at", { ascending: false });

  if (jobsError) throw new Error("Could not fetch low-report jobs: " + jobsError.message);

  // Group by contractor and only surface those with 3+ low reports.
  const byContractor = {};
  for (const job of jobs) {
    const cId = job.contractor_id;
    if (!byContractor[cId]) {
      byContractor[cId] = {
        contractor: {
          id: cId,
          name: job.contractors?.name,
          trade: job.contractors?.trade,
          email: job.contractors?.email,
          adminReviewStatus: job.contractors?.admin_review_status || null,
        },
        lowReportCount: 0,
        jobs: [],
      };
    }
    byContractor[cId].lowReportCount += 1;
    byContractor[cId].jobs.push({
      id: job.id,
      description: job.description,
      quotedAmount: job.quoted_amount != null ? Number(job.quoted_amount) : null,
      reportedAmount: Number(job.reported_amount),
      lowReportReason: job.low_report_reason,
      reportedAt: job.created_at,
    });
  }

  const REPEAT_OFFENDER_THRESHOLD = 3;
  return Object.values(byContractor)
    .filter((c) => c.lowReportCount >= REPEAT_OFFENDER_THRESHOLD)
    .sort((a, b) => b.lowReportCount - a.lowReportCount);
}

/**
 * Admin sets a contractor's review status: null (clear), "warned", or "suspended".
 */
async function setAdminReviewStatus(contractorId, status) {
  const allowed = [null, "warned", "suspended"];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status "${status}". Must be null, "warned", or "suspended".`);
  }
  const { data, error } = await supabase
    .from("contractors")
    .update({ admin_review_status: status })
    .eq("id", toId(contractorId))
    .select()
    .single();
  if (error) throw new Error("Could not update admin review status: " + error.message);
  return { contractorId: data.id, adminReviewStatus: data.admin_review_status };
}

async function handleJobsRequest(body) {
  const { action } = body || {};

  try {
    if (action === "report") {
      const { contractorId, description, reportedAmount } = body;
      if (!contractorId || !description || !reportedAmount) {
        return { statusCode: 400, body: { error: "contractorId, description, and reportedAmount are required." } };
      }
      const job = await reportJob(body);
      return { statusCode: 200, body: { job } };
    }

    if (action === "listForContractor") {
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const jobs = await listJobsForContractor(body.contractorId);
      return { statusCode: 200, body: { jobs } };
    }

    if (action === "listForHomeowner") {
      if (!body.homeownerId) return { statusCode: 400, body: { error: "homeownerId is required." } };
      const jobs = await listJobsForHomeowner(body.homeownerId);
      return { statusCode: 200, body: { jobs } };
    }

    if (action === "confirm") {
      if (!body.jobId) return { statusCode: 400, body: { error: "jobId is required." } };
      const job = await confirmJob(body.jobId);
      return { statusCode: 200, body: { job } };
    }

    if (action === "dispute") {
      if (!body.jobId) return { statusCode: 400, body: { error: "jobId is required." } };
      const job = await disputeJob(body.jobId, body.note);
      return { statusCode: 200, body: { job } };
    }

    if (action === "markPaid") {
      if (!body.jobId) return { statusCode: 400, body: { error: "jobId is required." } };
      const job = await markJobPaid(body.jobId);
      return { statusCode: 200, body: { job } };
    }

    if (action === "listLowReportContractors") {
      const flagged = await listLowReportContractors();
      return { statusCode: 200, body: { flagged } };
    }

    if (action === "setAdminReviewStatus") {
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const result = await setAdminReviewStatus(body.contractorId, body.status ?? null);
      return { statusCode: 200, body: result };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("jobs handler error:", err);
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
  const result = await handleJobsRequest(req.body);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleJobsRequest = handleJobsRequest;
module.exports.rowToJob = rowToJob;
