/**
 * api/jobs.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for completed jobs: a contractor reporting a job done
 * (with the final amount), a homeowner confirming or disputing that amount.
 * Marking a job's fee as paid is handled separately by api/webhook.js, which
 * Stripe calls directly (server-to-server) once a payment genuinely
 * succeeds -- there is intentionally no "mark this job paid" action in this
 * file. A direct frontend-callable markPaid action used to exist here but
 * was removed: it could be called by anyone editing browser JavaScript to
 * fake a payment without ever charging a card, which defeats the entire
 * point of charging a platform fee. See api/webhook.js for how paid status
 * is actually set now, including signature verification that proves an
 * event genuinely came from Stripe.
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/jobs  { action: "report", contractorId, quoteRequestId, homeownerId, description, reportedAmount, lowReportReason? }
 *   POST /api/jobs  { action: "listForContractor", contractorId }
 *   POST /api/jobs  { action: "listForHomeowner", homeownerId }
 *   POST /api/jobs  { action: "confirm", jobId }
 *   POST /api/jobs  { action: "dispute", jobId, note }
 *   POST /api/jobs  { action: "listLowReportContractors" }              <- admin only
 *   POST /api/jobs  { action: "setAdminReviewStatus", contractorId, status }  <- admin only
 *   POST /api/jobs  { action: "editReportedAmount", jobId, newAmount, lowReportReason? }
 *   POST /api/jobs  { action: "listDisputedJobs" }                       <- admin only
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");
const {
  emailHomeownerConfirmJob,
  emailContractorJobConfirmed,
  emailContractorPaymentOverdue,
} = require("./email");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const adminAttempts = new Map();
const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 60 * 60 * 1000;

function checkAdminPassword(password, req) {
  const ip = (req && (req.headers["x-forwarded-for"] || req.socket?.remoteAddress)) || "unknown";
  const now = Date.now();
  const record = adminAttempts.get(ip);

  if (record && record.count >= MAX_ADMIN_ATTEMPTS && now < record.resetAt) {
    const minutesLeft = Math.ceil((record.resetAt - now) / 60000);
    throw new Error(`Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`);
  }

  if (record && now >= record.resetAt) adminAttempts.delete(ip);

  const realPassword = process.env.ADMIN_PASSWORD;
  if (!realPassword) {
    console.error("WARNING: ADMIN_PASSWORD environment variable is not set. Admin panel will be inaccessible.");
    return false;
  }

  if (password === realPassword) {
    adminAttempts.delete(ip);
    return true;
  }

  const current = adminAttempts.get(ip) || { count: 0, resetAt: now + ADMIN_LOCKOUT_MS };
  adminAttempts.set(ip, { count: current.count + 1, resetAt: current.resetAt });
  return false;
}


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

  // Prevent duplicate reports for the same quote request
  if (quoteRequestId) {
    const { data: existing } = await supabase
      .from("completed_jobs")
      .select("id")
      .eq("contractor_id", toId(contractorId))
      .eq("quote_request_id", toId(quoteRequestId))
      .maybeSingle();
    if (existing) throw new Error("You have already reported this job.");
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

  // Email homeowner to confirm the job amount
  if (homeownerId) {
    const { data: homeowner } = await supabase
      .from("homeowners").select("name, email").eq("id", toId(homeownerId)).maybeSingle();
    const { data: contractor } = await supabase
      .from("contractors").select("business_name").eq("id", toId(contractorId)).maybeSingle();
    if (homeowner?.email) {
      emailHomeownerConfirmJob({
        homeownerEmail: homeowner.email,
        homeownerName: homeowner.name,
        contractorName: contractor?.business_name || "Your contractor",
        reportedAmount,
        description,
      }).catch(() => {});
    }
  }

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

  // Email contractor that fee is now due
  const job = rowToJob(data);
  const { data: contractor } = await supabase
    .from("contractors").select("business_name, email").eq("id", toId(job.contractorId)).maybeSingle();
  if (contractor?.email) {
    const feeOwed = feeOwedForAmount(job.reportedAmount);
    emailContractorJobConfirmed({
      contractorEmail: contractor.email,
      contractorName: contractor.business_name,
      description: job.description,
      reportedAmount: job.reportedAmount,
      feeOwed,
      daysToPayment: PAYMENT_DUE_DAYS,
    }).catch(() => {});
  }

  return job;
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

/**
 * For the admin console. Returns every contractor who has 3 or more low-report
 * jobs, along with their current admin_review_status, their total low-report
 * count, and the individual low-report jobs so the admin can read the reasons.
 */
async function listLowReportContractors() {
  const { data: jobs, error: jobsError } = await supabase
    .from("completed_jobs")
    .select("id, contractor_id, description, quoted_amount, reported_amount, low_report_reason, created_at")
    .eq("is_low_report", true)
    .order("created_at", { ascending: false });

  if (jobsError) throw new Error("Could not fetch low-report jobs: " + jobsError.message);
  if (!jobs || jobs.length === 0) return [];

  // Fetch contractor details separately -- avoids relying on a FK
  // relationship in Supabase's schema cache between completed_jobs and
  // contractors, which may not exist if the tables were created without
  // an explicit foreign key constraint.
  const contractorIds = [...new Set(jobs.map((j) => j.contractor_id))];
  const { data: contractors, error: contractorsError } = await supabase
    .from("contractors")
    .select("id, business_name, trade, email, admin_review_status")
    .in("id", contractorIds);
  if (contractorsError) throw new Error("Could not fetch contractors for low-report jobs: " + contractorsError.message);

  const contractorById = new Map((contractors || []).map((c) => [c.id, c]));

  // Group by contractor and only surface those with 3+ low reports.
  const byContractor = {};
  for (const job of jobs) {
    const cId = job.contractor_id;
    const c = contractorById.get(cId);
    if (!byContractor[cId]) {
      byContractor[cId] = {
        contractor: {
          id: cId,
          name: c?.business_name,
          trade: c?.trade,
          email: c?.email,
          adminReviewStatus: c?.admin_review_status || null,
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
 * Lets a contractor correct the reported amount on a job -- intentionally
 * scoped to ONLY "pending_confirmation" and "disputed" jobs, never
 * "confirmed" or "paid". This is the trust boundary: once a homeowner has
 * confirmed an amount (or money has moved), the number is locked. Before
 * that point, allowing an edit just fixes typos (an extra zero, a decimal
 * slip) or resolves a dispute by correcting the figure -- it can't be used
 * to quietly change an amount both parties already agreed to.
 *
 * Editing a disputed job clears the old dispute note and resets status
 * back to "pending_confirmation", sending it back to the homeowner for a
 * fresh look at the corrected number. Re-runs the same low-report check
 * used on the original report, since an edited amount could newly trip
 * (or newly clear) that threshold against the original quote.
 */
async function editReportedAmount(jobId, newAmount, lowReportReason) {
  const { data: existing, error: lookupError } = await supabase
    .from("completed_jobs")
    .select("id, status, quoted_amount")
    .eq("id", toId(jobId))
    .maybeSingle();
  if (lookupError) throw new Error("Could not look up job: " + lookupError.message);
  if (!existing) throw new Error("Job not found.");
  if (existing.status !== "pending_confirmation" && existing.status !== "disputed") {
    throw new Error("This job's amount can no longer be edited -- it has already been confirmed.");
  }

  const quotedAmount = existing.quoted_amount != null ? Number(existing.quoted_amount) : null;
  const low = isLowReport(quotedAmount, Number(newAmount));
  if (low && !lowReportReason) {
    throw new Error(
      "The corrected amount is more than 10% below your original quote. Please provide a reason."
    );
  }

  const { data, error } = await supabase
    .from("completed_jobs")
    .update({
      reported_amount: newAmount,
      is_low_report: low,
      low_report_reason: low ? lowReportReason : null,
      status: "pending_confirmation",
      dispute_note: null,
    })
    .eq("id", toId(jobId))
    .select()
    .single();
  if (error) throw new Error("Could not update reported amount: " + error.message);
  return rowToJob(data);
}

/**
 * For the admin console's Disputes tab. Returns every job currently in
 * "disputed" status, with contractor and homeowner info merged in, so an
 * admin can see the full picture (who, what was quoted, what was reported,
 * and the homeowner's note) without digging through Supabase directly.
 *
 * Does this as two separate queries plus a manual merge in code, rather
 * than a nested Supabase select across tables -- that nested-select syntax
 * (e.g. `homeowners ( id, name, email )` inside .select()) requires a
 * confirmed foreign-key relationship to exist between completed_jobs and
 * homeowners, which isn't guaranteed here. Two plain queries are slightly
 * more code but work regardless of whether that FK was ever set up.
 */
async function listDisputedJobs() {
  const { data: jobs, error: jobsError } = await supabase
    .from("completed_jobs")
    .select("id, description, quoted_amount, reported_amount, dispute_note, created_at, contractor_id, homeowner_id")
    .eq("status", "disputed")
    .order("created_at", { ascending: false });
  if (jobsError) throw new Error("Could not fetch disputed jobs: " + jobsError.message);
  if (jobs.length === 0) return [];

  const contractorIds = [...new Set(jobs.map((j) => j.contractor_id))];
  const homeownerIds = [...new Set(jobs.map((j) => j.homeowner_id))];

  const [{ data: contractors, error: contractorsError }, { data: homeowners, error: homeownersError }] =
    await Promise.all([
      supabase.from("contractors").select("id, business_name, trade").in("id", contractorIds),
      supabase.from("homeowners").select("id, name, email").in("id", homeownerIds),
    ]);
  if (contractorsError) throw new Error("Could not fetch contractors for disputes: " + contractorsError.message);
  if (homeownersError) throw new Error("Could not fetch homeowners for disputes: " + homeownersError.message);

  const contractorById = new Map((contractors || []).map((c) => [c.id, c]));
  const homeownerById = new Map((homeowners || []).map((h) => [h.id, h]));

  return jobs.map((row) => {
    const contractor = contractorById.get(row.contractor_id);
    const homeowner = homeownerById.get(row.homeowner_id);
    return {
      id: row.id,
      description: row.description,
      quotedAmount: row.quoted_amount != null ? Number(row.quoted_amount) : null,
      reportedAmount: Number(row.reported_amount),
      disputeNote: row.dispute_note,
      reportedAt: row.created_at,
      contractor: {
        id: row.contractor_id,
        businessName: contractor?.business_name,
        trade: contractor?.trade,
      },
      homeowner: {
        id: row.homeowner_id,
        name: homeowner?.name,
        email: homeowner?.email,
      },
    };
  });
}
async function listUnreportedCompletions() {
  // Find quote recipients where homeowner marked complete but contractor never reported
  const { data: recipients, error } = await supabase
    .from("quote_recipients")
    .select("quote_request_id, contractor_id, homeowner_marked_complete_at")
    .eq("homeowner_marked_complete", true)
    .eq("job_reported", false)
    .order("homeowner_marked_complete_at", { ascending: false });
  if (error) throw new Error("Could not fetch unreported completions: " + error.message);
  if (!recipients || recipients.length === 0) return [];

  const qrIds = [...new Set(recipients.map((r) => r.quote_request_id))];
  const contractorIds = [...new Set(recipients.map((r) => r.contractor_id))];

  const [{ data: qrs }, { data: contractors }] = await Promise.all([
    supabase.from("quote_requests").select("id, description, homeowner_id").in("id", qrIds),
    supabase.from("contractors").select("id, business_name, trade, email").in("id", contractorIds),
  ]);

  const homeownerIds = [...new Set((qrs || []).map((q) => q.homeowner_id))];
  const { data: homeowners } = await supabase
    .from("homeowners").select("id, name, email").in("id", homeownerIds);

  const qrById = new Map((qrs || []).map((q) => [q.id, q]));
  const contractorById = new Map((contractors || []).map((c) => [c.id, c]));
  const homeownerById = new Map((homeowners || []).map((h) => [h.id, h]));

  return recipients.map((r) => {
    const qr = qrById.get(r.quote_request_id);
    const contractor = contractorById.get(r.contractor_id);
    const homeowner = qr ? homeownerById.get(qr.homeowner_id) : null;
    return {
      quoteRequestId: r.quote_request_id,
      contractorId: r.contractor_id,
      markedCompleteAt: r.homeowner_marked_complete_at,
      description: qr?.description || "—",
      contractor: {
        businessName: contractor?.business_name,
        trade: contractor?.trade,
        email: contractor?.email,
      },
      homeowner: {
        name: homeowner?.name,
        email: homeowner?.email,
      },
    };
  });
}

async function getMetrics() {
  const [
    { count: totalContractors },
    { count: pendingContractors },
    { count: suspendedContractors },
    { count: totalHomeowners },
    { count: totalQuoteRequests },
    { data: jobs },
    { data: recentHomeowners },
    { data: recentContractors },
  ] = await Promise.all([
    supabase.from("contractors").select("*", { count: "exact", head: true }).eq("status", "approved"),
    supabase.from("contractors").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("contractors").select("*", { count: "exact", head: true }).eq("is_suspended", true),
    supabase.from("homeowners").select("*", { count: "exact", head: true }),
    supabase.from("quote_requests").select("*", { count: "exact", head: true }),
    supabase.from("completed_jobs").select("reported_amount, status, fee_paid, fee_paid_at, confirmed_at, created_at"),
    supabase.from("homeowners").select("created_at").gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    supabase.from("contractors").select("created_at").gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const allJobs = jobs || [];
  const confirmedJobs = allJobs.filter((j) => j.status === "confirmed" || j.status === "paid");
  const paidJobs = allJobs.filter((j) => j.status === "paid" && j.fee_paid);
  const overdueJobs = confirmedJobs.filter((j) => !j.fee_paid && j.confirmed_at && new Date(j.confirmed_at) < new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));

  // Calculate fees using the same bracket logic as create-payment-intent.js
  const FEE_BRACKETS = [
    { upTo: 500, rate: 0.04 },
    { upTo: 2500, rate: 0.03 },
    { upTo: 10000, rate: 0.02 },
    { upTo: Infinity, rate: 0.01 },
  ];
  function feeFor(amount) {
    let owed = 0; let lower = 0;
    for (const b of FEE_BRACKETS) {
      if (amount <= lower) break;
      owed += (Math.min(amount, b.upTo) - lower) * b.rate;
      lower = b.upTo;
    }
    return owed;
  }

  const feesCollected = paidJobs.reduce((s, j) => s + feeFor(Number(j.reported_amount)), 0);
  const feesPending = confirmedJobs.filter((j) => !j.fee_paid).reduce((s, j) => s + feeFor(Number(j.reported_amount)), 0);

  // This month fees
  const thisMonth = new Date(); thisMonth.setDate(1); thisMonth.setHours(0,0,0,0);
  const feesThisMonth = paidJobs
    .filter((j) => j.fee_paid_at && new Date(j.fee_paid_at) >= thisMonth)
    .reduce((s, j) => s + feeFor(Number(j.reported_amount)), 0);

  return {
    contractors: {
      total: totalContractors || 0,
      pending: pendingContractors || 0,
      suspended: suspendedContractors || 0,
      newThisMonth: (recentContractors || []).length,
    },
    homeowners: {
      total: totalHomeowners || 0,
      newThisMonth: (recentHomeowners || []).length,
    },
    transactions: {
      totalQuoteRequests: totalQuoteRequests || 0,
      completedJobs: confirmedJobs.length,
      paidJobs: paidJobs.length,
      overdueJobs: overdueJobs.length,
    },
    revenue: {
      feesCollected: Math.round(feesCollected * 100) / 100,
      feesPending: Math.round(feesPending * 100) / 100,
      feesThisMonth: Math.round(feesThisMonth * 100) / 100,
    },
  };
}

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

/**
 * Verifies the Authorization header against Supabase Auth.
 * Returns { id, email } for the authenticated user, or null if no valid session.
 */
async function getAuthedUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

/**
 * Given a verified Supabase auth user id, returns the matching homeowner
 * and contractor profile ids (if they exist). Used to scope job actions to
 * "my own jobs" without trusting any id the client sends in the body.
 */
async function getProfileIds(authUserId) {
  const [homeownerRes, contractorRes] = await Promise.allSettled([
    supabase.from("homeowners").select("id").eq("auth_user_id", authUserId).maybeSingle(),
    supabase.from("contractors").select("id").eq("auth_user_id", authUserId).maybeSingle(),
  ]);
  return {
    homeownerId: homeownerRes.status === "fulfilled" ? homeownerRes.value?.data?.id ?? null : null,
    contractorId: contractorRes.status === "fulfilled" ? contractorRes.value?.data?.id ?? null : null,
  };
}

async function handleJobsRequest(body, req) {
  const { action } = body || {};

  try {
    // Admin-only actions -- gated by ADMIN_PASSWORD, no session needed.
    if (action === "listLowReportContractors") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const flagged = await listLowReportContractors();
      return { statusCode: 200, body: { flagged } };
    }

    if (action === "setAdminReviewStatus") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const result = await setAdminReviewStatus(body.contractorId, body.status ?? null);
      return { statusCode: 200, body: result };
    }

    if (action === "listDisputedJobs") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const disputed = await listDisputedJobs();
      return { statusCode: 200, body: { disputed } };
    }

    if (action === "getMetrics") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const metrics = await getMetrics();
      return { statusCode: 200, body: { metrics } };
    }

    if (action === "listUnreportedCompletions") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const unreported = await listUnreportedCompletions();
      return { statusCode: 200, body: { unreported } };
    }

    // All other actions require a verified session.
    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return { statusCode: 401, body: { error: "You must be signed in." } };
    }

    const { homeownerId, contractorId } = await getProfileIds(authUser.id);

    if (action === "report") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      const { quoteRequestId, description, reportedAmount, lowReportReason } = body;
      if (!description || !reportedAmount) {
        return { statusCode: 400, body: { error: "description and reportedAmount are required." } };
      }
      // Derive homeownerId from the quote request server-side -- never trust client body
      let derivedHomeownerId = null;
      if (quoteRequestId) {
        const { data: qr } = await supabase
          .from("quote_requests")
          .select("homeowner_id")
          .eq("id", toId(quoteRequestId))
          .maybeSingle();
        derivedHomeownerId = qr?.homeowner_id ?? null;
      }
      if (!derivedHomeownerId) {
        return { statusCode: 400, body: { error: "Could not determine homeowner for this job. Make sure quoteRequestId is provided." } };
      }
      const job = await reportJob({ contractorId, quoteRequestId, homeownerId: derivedHomeownerId, description, reportedAmount, lowReportReason });
      return { statusCode: 200, body: { job } };
    }

    if (action === "listForContractor") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      const jobs = await listJobsForContractor(contractorId);
      return { statusCode: 200, body: { jobs } };
    }

    if (action === "listForHomeowner") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const jobs = await listJobsForHomeowner(homeownerId);
      return { statusCode: 200, body: { jobs } };
    }

    if (action === "confirm") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      if (!body.jobId) return { statusCode: 400, body: { error: "jobId is required." } };
      // Verify this job actually belongs to this homeowner before confirming.
      const { data: job, error: jobError } = await supabase
        .from("completed_jobs").select("homeowner_id").eq("id", toId(body.jobId)).maybeSingle();
      if (jobError || !job) return { statusCode: 404, body: { error: "Job not found." } };
      if (String(job.homeowner_id) !== String(homeownerId)) {
        return { statusCode: 403, body: { error: "This job doesn't belong to your account." } };
      }
      const confirmed = await confirmJob(body.jobId);
      return { statusCode: 200, body: { job: confirmed } };
    }

    if (action === "dispute") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      if (!body.jobId) return { statusCode: 400, body: { error: "jobId is required." } };
      const { data: job, error: jobError } = await supabase
        .from("completed_jobs").select("homeowner_id").eq("id", toId(body.jobId)).maybeSingle();
      if (jobError || !job) return { statusCode: 404, body: { error: "Job not found." } };
      if (String(job.homeowner_id) !== String(homeownerId)) {
        return { statusCode: 403, body: { error: "This job doesn't belong to your account." } };
      }
      const disputed = await disputeJob(body.jobId, body.note);
      return { statusCode: 200, body: { job: disputed } };
    }

    if (action === "editReportedAmount") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      if (!body.jobId || body.newAmount == null) {
        return { statusCode: 400, body: { error: "jobId and newAmount are required." } };
      }
      // Verify this job belongs to this contractor.
      const { data: job, error: jobError } = await supabase
        .from("completed_jobs").select("contractor_id").eq("id", toId(body.jobId)).maybeSingle();
      if (jobError || !job) return { statusCode: 404, body: { error: "Job not found." } };
      if (String(job.contractor_id) !== String(contractorId)) {
        return { statusCode: 403, body: { error: "This job doesn't belong to your account." } };
      }
      const edited = await editReportedAmount(body.jobId, body.newAmount, body.lowReportReason);
      return { statusCode: 200, body: { job: edited } };
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleJobsRequest(req.body, req);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleJobsRequest = handleJobsRequest;
module.exports.rowToJob = rowToJob;
