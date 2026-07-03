/**
 * email.js — Resend email helper for Harry's List
 * 
 * Used by quotes.js, jobs.js, estimates.js to send transactional emails
 * at key moments in the homeowner/contractor flow.
 * 
 * Requires RESEND_API_KEY environment variable in Vercel.
 * From address: harry@harryslistdfw.com
 */

const FROM = "Harry's List <harry@harryslistdfw.com>";
const BASE_URL = "https://harryslistdfw.com";

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY not set — email not sent:", subject);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Resend error:", err);
    }
  } catch (err) {
    console.error("Email send failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------
function baseTemplate(content) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { margin: 0; padding: 0; background: #FBF7F0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; border: 1px solid #EDE3D2; }
  .header { background: #1C2B22; padding: 24px 32px; }
  .header-title { font-family: Georgia, serif; font-size: 20px; font-weight: 600; color: #FDFBF6; margin: 0; }
  .header-sub { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #C1622A; margin-top: 4px; }
  .body { padding: 32px; }
  .body p { font-size: 15px; color: #3D4F42; line-height: 1.6; margin: 0 0 16px; }
  .body strong { color: #1C2B22; }
  .btn { display: inline-block; background: #C1622A; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; margin: 8px 0 16px; }
  .footer { padding: 20px 32px; border-top: 1px solid #EDE3D2; font-size: 12px; color: #8A7A65; }
  .footer a { color: #C1622A; text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="header-title">Harry's List</div>
    <div class="header-sub">DFW Trade Directory</div>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    <p>Harry's List · DFW Trade Directory · <a href="${BASE_URL}">${BASE_URL}</a></p>
    <p>No contractor here paid to be listed.</p>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Homeowner emails
// ---------------------------------------------------------------------------

/** Contractor responded to a quote request */
async function emailHomeownerQuoteReceived({ homeownerEmail, homeownerName, contractorName, price, message }) {
  await sendEmail({
    to: homeownerEmail,
    subject: `${contractorName} sent you a quote — Harry's List`,
    html: baseTemplate(`
      <p>Hi ${homeownerName},</p>
      <p><strong>${contractorName}</strong> responded to your quote request${price ? ` with a price of <strong>$${Number(price).toLocaleString()}</strong>` : ""}.</p>
      ${message ? `<p>Their message: <em>"${message}"</em></p>` : ""}
      <p>Log in to view their full quote and decide how to proceed.</p>
      <a href="${BASE_URL}" class="btn">View quote →</a>
      <p>If this job works out, you'll confirm the amount when it's done — that's what starts their fee clock, not you.</p>
    `),
  });
}

/** Contractor reported job complete — homeowner needs to confirm */
async function emailHomeownerConfirmJob({ homeownerEmail, homeownerName, contractorName, reportedAmount, description }) {
  await sendEmail({
    to: homeownerEmail,
    subject: `${contractorName} marked your job complete — please confirm`,
    html: baseTemplate(`
      <p>Hi ${homeownerName},</p>
      <p><strong>${contractorName}</strong> reported that the following job is complete:</p>
      <p><strong>${description}</strong><br/>Reported amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong></p>
      <p>Please log in to confirm the amount is correct — or dispute it if something's off. This triggers their platform fee, not a charge to you.</p>
      <a href="${BASE_URL}" class="btn">Confirm or dispute →</a>
    `),
  });
}

/** Contractor requested an in-person estimate */
async function emailHomeownerEstimateRequest({ homeownerEmail, homeownerName, contractorName, contractorTrade, message }) {
  await sendEmail({
    to: homeownerEmail,
    subject: `${contractorName} wants to visit before quoting — Harry's List`,
    html: baseTemplate(`
      <p>Hi ${homeownerName},</p>
      <p><strong>${contractorName}</strong> (${contractorTrade}) would like to visit in person before providing a quote.</p>
      ${message ? `<p>Their message: <em>"${message}"</em></p>` : ""}
      <p>If you accept, they'll receive your phone number to coordinate a visit. You're under no obligation to hire them.</p>
      <a href="${BASE_URL}" class="btn">Accept or decline →</a>
    `),
  });
}

// ---------------------------------------------------------------------------
// Contractor emails
// ---------------------------------------------------------------------------

/** New quote request received */
async function emailContractorNewQuote({ contractorEmail, contractorName, description, zip, budget, timeline }) {
  await sendEmail({
    to: contractorEmail,
    subject: `New quote request in your area — Harry's List`,
    html: baseTemplate(`
      <p>Hi ${contractorName},</p>
      <p>A homeowner in your service area sent you a quote request:</p>
      <p>
        <strong>${description}</strong><br/>
        ${zip ? `Zip: ${zip}<br/>` : ""}
        ${budget ? `Budget: ${budget}<br/>` : ""}
        ${timeline ? `Timeline: ${timeline}` : ""}
      </p>
      <p>Log in to respond with a quote or decline.</p>
      <a href="${BASE_URL}/contractors" class="btn">View request →</a>
      <p>You only pay a small platform fee after a job is completed and confirmed — never to receive leads.</p>
    `),
  });
}

/** Homeowner confirmed job — fee is now due */
async function emailContractorJobConfirmed({ contractorEmail, contractorName, description, reportedAmount, feeOwed, daysToPayment }) {
  await sendEmail({
    to: contractorEmail,
    subject: `Job confirmed — platform fee due in ${daysToPayment} days`,
    html: baseTemplate(`
      <p>Hi ${contractorName},</p>
      <p>The homeowner confirmed your job:</p>
      <p><strong>${description}</strong><br/>Reported amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong></p>
      <p>Platform fee owed: <strong>$${Number(feeOwed).toFixed(2)}</strong></p>
      <p>Please pay within <strong>${daysToPayment} days</strong> to keep your listing active in the directory.</p>
      <a href="${BASE_URL}/contractors" class="btn">Pay fee →</a>
    `),
  });
}

/** Payment overdue reminder */
async function emailContractorPaymentOverdue({ contractorEmail, contractorName, description, feeOwed }) {
  await sendEmail({
    to: contractorEmail,
    subject: `⚠ Your Harry's List listing is hidden — payment overdue`,
    html: baseTemplate(`
      <p>Hi ${contractorName},</p>
      <p>Your listing has been hidden from the homeowner directory because a platform fee is overdue:</p>
      <p><strong>${description}</strong><br/>Fee owed: <strong>$${Number(feeOwed).toFixed(2)}</strong></p>
      <p>Pay now to be immediately relisted. You won't receive new quote requests until payment is made.</p>
      <a href="${BASE_URL}/contractors" class="btn">Pay now →</a>
    `),
  });
}

/** Homeowner marked job complete — contractor needs to report */
async function emailContractorMarkComplete({ contractorEmail, contractorName, description }) {
  await sendEmail({
    to: contractorEmail,
    subject: `Homeowner marked your job complete — log in to report`,
    html: baseTemplate(`
      <p>Hi ${contractorName},</p>
      <p>A homeowner marked the following job as complete:</p>
      <p><strong>${description}</strong></p>
      <p>Please log in to report the final job amount. This starts the confirmation process.</p>
      <a href="${BASE_URL}/contractors" class="btn">Report job →</a>
    `),
  });
}

module.exports = {
  emailHomeownerQuoteReceived,
  emailHomeownerConfirmJob,
  emailHomeownerEstimateRequest,
  emailContractorNewQuote,
  emailContractorJobConfirmed,
  emailContractorPaymentOverdue,
  emailContractorMarkComplete,
};
