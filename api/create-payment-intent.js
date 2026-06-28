/**
 * api/create-payment-intent.js
 * ---------------------------------------------------------------------------
 * Backend endpoint that creates a Stripe PaymentIntent for a contractor's
 * platform fee payment, with the amount verified against a real database
 * (Supabase) rather than trusted from the browser.
 *
 * This file is written for Vercel specifically: placing it inside an "api"
 * folder at your project root is what tells Vercel to turn it into a live
 * web address automatically (e.g. api/create-payment-intent.js becomes
 * https://your-app.vercel.app/api/create-payment-intent).
 *
 * ENVIRONMENT VARIABLES YOU MUST SET IN YOUR VERCEL PROJECT SETTINGS
 * (Project -> Settings -> Environment Variables -- never put these in code)
 *   STRIPE_SECRET_KEY        -- starts with sk_test_... from your Stripe dashboard
 *   SUPABASE_URL              -- https://dmyuuqrdycgzvnduzmqx.supabase.co
 *   SUPABASE_SECRET_KEY       -- starts with sb_secret_... from your Supabase
 *                                 dashboard (Settings -> API Keys). This is
 *                                 DIFFERENT from the publishable key used in
 *                                 the frontend -- this one has full read/write
 *                                 access to your database and must never be
 *                                 shared, committed to GitHub, or pasted
 *                                 anywhere outside this environment-variable
 *                                 setting.
 *
 * NPM PACKAGES REQUIRED (listed in package.json, Vercel installs them automatically)
 *   stripe
 *   @supabase/supabase-js
 * ---------------------------------------------------------------------------
 */

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

/**
 * Ids are int8 (numbers) in the database, but arrive as strings from the
 * frontend over JSON. See the matching comment in api/quotes.js.
 */
function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

/**
 * Re-derives the platform fee owed for a job amount, using the SAME marginal
 * bracket logic as the frontend (feeOwedForAmount in App.jsx). This duplication
 * is intentional: the server computes its own answer rather than trusting any
 * number sent from the browser, so a tampered request can't pay $1 instead of
 * the real fee owed.
 *
 * If you ever change the fee brackets in App.jsx, update this to match.
 */
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

/**
 * Looks up the job's real reported amount directly from the completed_jobs
 * table in Supabase. This is the step that makes the whole system trustworthy:
 * the dollar figure used to create the Stripe charge comes from YOUR database,
 * not from anything the browser sent in the request.
 */
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

/**
 * Core handler logic.
 * @param {{ jobId: string, contractorId: string }} body
 * @returns {{ statusCode: number, body: object }}
 */
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
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      metadata: {
        jobId,
        contractorId,
        feeOwed: feeOwed.toFixed(2),
        reportedAmount: reportedAmount.toFixed(2),
      },
      idempotency_key: `fee_${jobId}`,
    });

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

// ---------------------------------------------------------------------------
// Vercel handler -- this is the part Vercel actually calls when someone
// visits https://your-app.vercel.app/api/create-payment-intent
// ---------------------------------------------------------------------------
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
  const result = await handleCreatePaymentIntent(req.body);
  res.status(result.statusCode).json(result.body);
};

// Exported for testing.
module.exports.feeOwedForAmount = feeOwedForAmount;
module.exports.handleCreatePaymentIntent = handleCreatePaymentIntent;
module.exports.getJobReportedAmount = getJobReportedAmount;
