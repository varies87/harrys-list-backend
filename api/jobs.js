/**
 * api/jobs.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for completed jobs: a contractor reporting a job done
 * (with the final amount), a homeowner confirming or disputing that amount,
 * and marking a job's fee as paid (called after a successful Stripe charge,
 * via create-payment-intent.js's companion confirm step -- see note below).
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/jobs  { action: "report", contractorId, quoteRequestId, homeownerId, description, reportedAmount }
 *   POST /api/jobs  { action: "listForContractor", contractorId }
 *   POST /api/jobs  { action: "listForHomeowner", homeownerId }
 *   POST /api/jobs  { action: "confirm", jobId }
 *   POST /api/jobs  { action: "dispute", jobId, note }
 *   POST /api/jobs  { action: "markPaid", jobId }
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
 
function rowToJob(row) {
  return {
    id: row.id,
    contractorId: row.contractor_id,
    homeownerId: row.homeowner_id,
    quoteRequestId: row.quote_request_id,
    description: row.description,
    reportedAmount: Number(row.reported_amount),
    status: row.status,
    reportedAt: row.created_at,
    confirmedAt: row.confirmed_at || undefined,
    disputeNote: row.dispute_note || undefined,
    feePaid: !!row.fee_paid,
    feePaidAt: row.fee_paid_at || undefined,
  };
}
 
async function reportJob({ contractorId, quoteRequestId, homeownerId, description, reportedAmount }) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .insert({
      contractor_id: contractorId,
      quote_request_id: quoteRequestId,
      homeowner_id: homeownerId,
      description,
      reported_amount: reportedAmount,
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
    .eq("contractor_id", contractorId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list jobs: " + error.message);
  return data.map(rowToJob);
}
 
async function listJobsForHomeowner(homeownerId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .select("*")
    .eq("homeowner_id", homeownerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list jobs: " + error.message);
  return data.map(rowToJob);
}
 
async function confirmJob(jobId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
    .eq("id", jobId)
    .select()
    .single();
  if (error) throw new Error("Could not confirm job: " + error.message);
  return rowToJob(data);
}
 
async function disputeJob(jobId, note) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .update({ status: "disputed", dispute_note: note || "Homeowner disputed this amount." })
    .eq("id", jobId)
    .select()
    .single();
  if (error) throw new Error("Could not dispute job: " + error.message);
  return rowToJob(data);
}
 
async function markJobPaid(jobId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .update({ status: "paid", fee_paid: true, fee_paid_at: new Date().toISOString() })
    .eq("id", jobId)
    .select()
    .single();
  if (error) throw new Error("Could not mark job paid: " + error.message);
  return rowToJob(data);
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
 
    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("jobs handler error:", err);
    return { statusCode: 500, body: { error: err.message } };
  }
}
 
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleJobsRequest(req.body);
  res.status(result.statusCode).json(result.body);
};
 
module.exports.handleJobsRequest = handleJobsRequest;
module.exports.rowToJob = rowToJob;
 
