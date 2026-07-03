/**
 * api/webhook.js
 * ---------------------------------------------------------------------------
 * Stripe webhook endpoint. Stripe calls this directly, server-to-server,
 * whenever a payment event happens -- this is what actually marks a job's
 * platform fee as paid, replacing the old approach where the FRONTEND called
 * markPaid directly after Stripe Elements reported success client-side.
 *
 * Why this matters: a direct frontend call to markPaid can be faked by
 * anyone who opens devtools and calls the API themselves, without ever
 * entering real card details. A webhook can't be faked that way, because
 * Stripe cryptographically signs every event it sends, and this file
 * verifies that signature before trusting anything in the payload. If the
 * signature doesn't check out, the event is rejected.
 *
 * SETUP STEPS (do these once, in order):
 *
 * 1. Deploy this file (push to GitHub, let Vercel deploy it).
 *
 * 2. In the Stripe dashboard (test mode, since you're in sandbox):
 *    Developers -> Webhooks -> Add endpoint
 *      Endpoint URL: https://harrys-list-backend.vercel.app/api/webhook
 *      Events to send: payment_intent.succeeded
 *    Click "Add endpoint".
 *
 * 3. On the new endpoint's detail page, find "Signing secret" and click
 *    "Reveal". Copy the value (starts with whsec_...).
 *
 * 4. In Vercel: Project -> Settings -> Environment Variables, add:
 *      STRIPE_WEBHOOK_SECRET = whsec_... (the value from step 3)
 *    Redeploy after adding this -- env var changes need a redeploy to apply.
 *
 * 5. Test it: from the Stripe dashboard's webhook detail page, there's a
 *    "Send test webhook" button -- send a payment_intent.succeeded test
 *    event and confirm this endpoint returns 200, not an error.
 *
 * ENVIRONMENT VARIABLES
 *   STRIPE_SECRET_KEY        -- same one create-payment-intent.js uses
 *   STRIPE_WEBHOOK_SECRET    -- new, from step 3/4 above
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const Stripe = require("stripe");
const { supabase, toId } = require("./_shared");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

/**
 * Marks a job's fee as paid in Supabase. Mirrors markJobPaid in jobs.js --
 * duplicated here rather than imported, since Vercel serverless functions
 * are each their own isolated bundle and importing across api/ files adds
 * fragility for very little benefit at this scale.
 *
 * Idempotent on purpose: Stripe can and does occasionally send the same
 * webhook event more than once (network retries, etc.). Checking fee_paid
 * first means a duplicate delivery is a harmless no-op instead of an error
 * or a double-processed payment.
 */
async function markJobPaidFromWebhook(jobId) {
  const { data: job, error: lookupError } = await supabase
    .from("completed_jobs")
    .select("id, fee_paid")
    .eq("id", toId(jobId))
    .maybeSingle();

  if (lookupError) {
    throw new Error("Could not look up job: " + lookupError.message);
  }
  if (!job) {
    // Don't throw -- log and move on. Throwing here would make Stripe
    // retry forever for a job id that will never exist (e.g. a stale test
    // event), which just adds noise.
    console.error(`Webhook: job ${jobId} not found, skipping.`);
    return;
  }
  if (job.fee_paid) {
    console.log(`Webhook: job ${jobId} already marked paid, skipping (likely a duplicate event delivery).`);
    return;
  }

  const { error: updateError } = await supabase
    .from("completed_jobs")
    .update({ status: "paid", fee_paid: true, fee_paid_at: new Date().toISOString() })
    .eq("id", toId(jobId));

  if (updateError) {
    throw new Error("Could not mark job paid: " + updateError.message);
  }
  console.log(`Webhook: job ${jobId} marked paid.`);
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------
// IMPORTANT: this route needs Stripe's raw, unparsed request body to verify
// the signature -- Vercel's default behavior of automatically parsing JSON
// bodies would corrupt that verification (the signature is computed over
// the EXACT bytes Stripe sent, and JSON.parse + re-stringify doesn't
// reliably reproduce those exact bytes). This config block disables that
// default parsing for this one file only.
// NOTE: the `config` export (bodyParser: false) is set AFTER the handler
// assignment at the bottom of this file. Setting it here would be silently
// discarded, because `module.exports = handler` below replaces the entire
// exports object -- that was bug H-2, which broke Stripe signature verification.

/** Reads the raw request body as a Buffer -- needed since bodyParser is off. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const signature = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("Webhook: STRIPE_WEBHOOK_SECRET is not set in environment variables.");
    res.status(500).json({ error: "Webhook not configured." });
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Signature didn't verify -- this request did NOT genuinely come from
    // Stripe (or the secret is misconfigured). Reject it. This is the line
    // that makes the whole system trustworthy: nothing past this point
    // runs unless Stripe's signature checked out.
    console.error("Webhook signature verification failed:", err.message);
    res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    return;
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const jobId = paymentIntent.metadata && paymentIntent.metadata.jobId;
      if (!jobId) {
        console.error("Webhook: payment_intent.succeeded had no jobId in metadata, skipping.");
      } else {
        await markJobPaidFromWebhook(jobId);
      }
    }
    // Other event types (payment_intent.payment_failed, etc.) are
    // intentionally ignored for now -- only succeeded payments need to
    // change job state. Add more `if` blocks here later if you want to
    // react to failures (e.g. emailing the contractor) or other events.

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    // Returning a 500 here tells Stripe to retry this event later, which
    // is correct: this means OUR code failed (e.g. a transient Supabase
    // error), not that the event itself was invalid.
    res.status(500).json({ error: err.message });
  }
};

// Exported for testing.
module.exports.markJobPaidFromWebhook = markJobPaidFromWebhook;

// IMPORTANT: this MUST come after `module.exports = handler` above. Assigning
// module.exports to the handler replaces the whole exports object, so setting
// `.config` before that (as the original code did) silently dropped it and left
// Stripe's raw-body signature verification broken (H-2).
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
