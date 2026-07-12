/**
 * api/create-payment-intent.js
 * ---------------------------------------------------------------------------
 * Backend endpoint that creates a Stripe PaymentIntent for a contractor's
 * platform fee payment, with the amount verified against a real database
 * (Supabase) rather than trusted from the browser.
 *
 * ENVIRONMENT VARIABLES YOU MUST SET IN YOUR VERCEL PROJECT SETTINGS
 *   STRIPE_SECRET_KEY
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const Stripe = require("stripe");
const { supabase, toId, getAuthedUser, setCors } = require("./_shared");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const FEE_BRACKETS = [
  { upTo: 500, rate: 0.04 },
  { upTo: 2500, rate: 0.03 },
  { upTo: 10000, rate: 0.02 },
  { upTo: Infinity, rate: 0.01 },
];

function feeOwedForAmount(amount) {
  let owed = 0;
  let lowerBound = 0;
  for (const bracket of FEE_BRACKETS) {
    if (amount <= lowerBound) break;
    const slice = Math.min(amount, bracket.upTo) - lowerBound;
    owed += slice * bracket.rate;
    lowerBound = bracket.upTo;
  }
  return Math.round(owed * 100) / 100;
}

async function getJobForFee(jobId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .select("reported_amount, status, fee_paid, contractor_id")
    .eq("id", toId(jobId))
    .single();

  if (error || !data) {
    throw new Error("Job not found in database.");
  }
  if (data.status !== "confirmed" && data.status !== "paid") {
    throw new Error("This job hasn't been confirmed by the homeowner yet, so no fee is owed.");
  }
  if (data.fee_paid) {
    throw new Error("This job's fee has already been paid.");
  }
  return {
    reportedAmount: Number(data.reported_amount),
    contractorId: data.contractor_id,
  };
}

async function handleCreatePaymentIntent(body, req) {
  // Require a verified session and resolve the caller's contractor id
  // server-side. The endpoint was previously unauthenticated (M-8): anyone
  // could POST a jobId/contractorId to read the computed fee and spam
  // PaymentIntents for arbitrary jobs.
  const authUser = await getAuthedUser(req);
  if (!authUser) {
    return { statusCode: 401, body: { error: "Authentication required." } };
  }

  const { jobId } = body || {};
  if (!jobId) {
    return { statusCode: 400, body: { error: "jobId is required." } };
  }

  const { data: contractor, error: cErr } = await supabase
    .from("contractors")
    .select("id")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();
  if (cErr || !contractor) {
    return { statusCode: 403, body: { error: "No contractor profile for this account." } };
  }
  const contractorId = contractor.id;

  let job;
  try {
    job = await getJobForFee(jobId);
  } catch (err) {
    return { statusCode: 404, body: { error: err.message } };
  }

  // The job must belong to the authenticated contractor.
  if (toId(job.contractorId) !== toId(contractorId)) {
    return { statusCode: 403, body: { error: "This job does not belong to your account." } };
  }

  const reportedAmount = job.reportedAmount;

  // Founding-member perk: the first 50 contractors pay ZERO fee on their
  // first completed job. Check eligibility (founding member + under the
  // 1-job cap + this job not already waived).
  const { data: founder } = await supabase
    .from("contractors")
    .select("is_founding_member, founding_free_jobs_used")
    .eq("id", toId(contractorId))
    .maybeSingle();
  const { data: jobRow } = await supabase
    .from("completed_jobs")
    .select("fee_waived_founding")
    .eq("id", toId(jobId))
    .maybeSingle();

  const eligibleForWaiver =
    founder?.is_founding_member &&
    (founder.founding_free_jobs_used || 0) < 1 &&
    !jobRow?.fee_waived_founding;

  if (eligibleForWaiver) {
    // Mark the job as waived and increment the contractor's used-count, then
    // settle the job as paid with a $0 fee -- no Stripe charge needed.
    await supabase
      .from("completed_jobs")
      .update({ fee_waived_founding: true, fee_paid: true, fee_paid_at: new Date().toISOString(), status: "paid" })
      .eq("id", toId(jobId));
    await supabase
      .from("contractors")
      .update({ founding_free_jobs_used: (founder.founding_free_jobs_used || 0) + 1 })
      .eq("id", toId(contractorId));
    return {
      statusCode: 200,
      body: {
        feeWaived: true,
        foundingMember: true,
        freeJobsRemaining: 1 - ((founder.founding_free_jobs_used || 0) + 1),
        message: "Founding member — this job's fee is on the house.",
      },
    };
  }

  const feeOwed = feeOwedForAmount(reportedAmount);
  const amountInCents = Math.round(feeOwed * 100);

  if (amountInCents <= 0) {
    return { statusCode: 400, body: { error: "Computed fee is zero or negative -- nothing to charge." } };
  }

  try {
    // idempotency_key is NOT a body parameter -- it's a header, and the
    // Stripe Node SDK takes it as a SECOND argument (a request-options
    // object), not mixed into the first argument with amount/currency/
    // metadata. Passing it inside the first object causes Stripe to reject
    // the whole request with "Received unknown parameter: idempotency_key".
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountInCents,
        currency: "usd",
        // Restricted to card only (not automatic_payment_methods) so this
        // never depends on Stripe's live-mode domain registration step for
        // wallet methods (Apple Pay/Google Pay/Link) -- cards need zero
        // extra setup and cover the vast majority of real transactions.
        // Once harryslistdfw.com is registered as a payment method domain
        // in Stripe (Live mode -> Settings -> Payment methods -> Domains),
        // this can switch back to automatic_payment_methods to add those
        // wallet options.
        payment_method_types: ["card"],
        metadata: {
          jobId,
          contractorId,
          feeOwed: feeOwed.toFixed(2),
          reportedAmount: reportedAmount.toFixed(2),
        },
      },
      {
        idempotencyKey: `fee_${jobId}`,
      }
    );

    return {
      statusCode: 200,
      body: {
        clientSecret: paymentIntent.client_secret,
        amount: feeOwed,
      },
    };
  } catch (err) {
    console.error("Stripe PaymentIntent creation failed:", err);
    return { statusCode: 500, body: { error: "Could not create payment. Please try again." } };
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleCreatePaymentIntent(req.body, req);
  res.status(result.statusCode).json(result.body);
};

module.exports.feeOwedForAmount = feeOwedForAmount;
module.exports.handleCreatePaymentIntent = handleCreatePaymentIntent;
module.exports.getJobForFee = getJobForFee;
