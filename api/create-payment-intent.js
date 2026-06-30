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
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

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

async function getJobReportedAmount(jobId) {
  const { data, error } = await supabase
    .from("completed_jobs")
    .select("reported_amount, status, fee_paid")
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
  return Number(data.reported_amount);
}

async function handleCreatePaymentIntent(body) {
  const { jobId, contractorId } = body || {};

  if (!jobId || !contractorId) {
    return { statusCode: 400, body: { error: "jobId and contractorId are required." } };
  }

  let reportedAmount;
  try {
    reportedAmount = await getJobReportedAmount(jobId);
  } catch (err) {
    return { statusCode: 404, body: { error: err.message } };
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
        automatic_payment_methods: { enabled: true },
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
  const result = await handleCreatePaymentIntent(req.body);
  res.status(result.statusCode).json(result.body);
};

module.exports.feeOwedForAmount = feeOwedForAmount;
module.exports.handleCreatePaymentIntent = handleCreatePaymentIntent;
module.exports.getJobReportedAmount = getJobReportedAmount;
