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

// Escape user-controlled values before interpolating them into HTML email
// bodies. Prevents HTML injection / phishing markup in transactional emails
// (M-2). Numeric fields are already Number()-coerced and don't need this.
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
      <p>Hi ${esc(homeownerName)},</p>
      <p><strong>${esc(contractorName)}</strong> responded to your quote request${price ? ` with a price of <strong>$${Number(price).toLocaleString()}</strong>` : ""}.</p>
      ${message ? `<p>Their message: <em>"${esc(message)}"</em></p>` : ""}
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
      <p>Hi ${esc(homeownerName)},</p>
      <p><strong>${esc(contractorName)}</strong> reported that the following job is complete:</p>
      <p><strong>${esc(description)}</strong><br/>Reported amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong></p>
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
      <p>Hi ${esc(homeownerName)},</p>
      <p><strong>${esc(contractorName)}</strong> (${esc(contractorTrade)}) would like to visit in person before providing a quote.</p>
      ${message ? `<p>Their message: <em>"${esc(message)}"</em></p>` : ""}
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
      <p>Hi ${esc(contractorName)},</p>
      <p>A homeowner in your service area sent you a quote request:</p>
      <p>
        <strong>${esc(description)}</strong><br/>
        ${zip ? `Zip: ${esc(zip)}<br/>` : ""}
        ${budget ? `Budget: ${esc(budget)}<br/>` : ""}
        ${timeline ? `Timeline: ${esc(timeline)}` : ""}
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
      <p>Hi ${esc(contractorName)},</p>
      <p>The homeowner confirmed your job:</p>
      <p><strong>${esc(description)}</strong><br/>Reported amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong></p>
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
      <p>Hi ${esc(contractorName)},</p>
      <p>Your listing has been hidden from the homeowner directory because a platform fee is overdue:</p>
      <p><strong>${esc(description)}</strong><br/>Fee owed: <strong>$${Number(feeOwed).toFixed(2)}</strong></p>
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
      <p>Hi ${esc(contractorName)},</p>
      <p>A homeowner marked the following job as complete:</p>
      <p><strong>${esc(description)}</strong></p>
      <p>Please log in to report the final job amount. This starts the confirmation process.</p>
      <a href="${BASE_URL}/contractors" class="btn">Report job →</a>
    `),
  });
}

/** Reminder to homeowner 3 days after job reported — confirm or dispute */
async function emailHomeownerConfirmReminder({ homeownerEmail, homeownerName, contractorName, reportedAmount, description, daysLeft }) {
  await sendEmail({
    to: homeownerEmail,
    subject: `Reminder: confirm ${contractorName}'s job — ${daysLeft} days left`,
    html: baseTemplate(`
      <p>Hi ${esc(homeownerName)},</p>
      <p>This is a reminder that <strong>${esc(contractorName)}</strong> reported the following job complete ${7 - daysLeft} days ago:</p>
      <p><strong>${esc(description)}</strong><br/>Reported amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong></p>
      <p>You have <strong>${daysLeft} days</strong> to confirm or dispute this amount. If you take no action, it will be automatically confirmed.</p>
      <a href="https://harryslistdfw.com" class="btn">Confirm or dispute →</a>
    `),
  });
}

/** Auto-confirm notification to homeowner */
async function emailHomeownerAutoConfirmed({ homeownerEmail, homeownerName, contractorName, reportedAmount, description }) {
  await sendEmail({
    to: homeownerEmail,
    subject: `Job automatically confirmed — Harry's List`,
    html: baseTemplate(`
      <p>Hi ${esc(homeownerName)},</p>
      <p>The following job was automatically confirmed after 7 days with no dispute:</p>
      <p><strong>${esc(description)}</strong><br/>Amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong><br/>Contractor: ${esc(contractorName)}</p>
      <p>If you believe this is incorrect, please contact us at <a href="mailto:harry@harryslistdfw.com">harry@harryslistdfw.com</a>.</p>
    `),
  });
}

/** Contractor approved — notify them to log in */
async function emailContractorApproved({ contractorEmail, contractorName }) {
  await sendEmail({
    to: contractorEmail,
    subject: `You're approved on Harry's List DFW 🎉`,
    html: baseTemplate(`
      <p>Hi ${esc(contractorName)},</p>
      <p>Great news — your Harry's List profile has been approved. You're now listed in the DFW trade directory and homeowners in your service area can find you and send quote requests.</p>
      <p><strong>What happens next:</strong></p>
      <ul style="margin: 12px 0 16px; padding-left: 20px; color: #3D4F42; font-size: 14px; line-height: 1.8;">
        <li>Log in to your contractor portal to check for quote requests</li>
        <li>Share your profile link with existing customers to collect reviews</li>
        <li>You only pay a small platform fee after a job is confirmed complete</li>
      </ul>
      <a href="${BASE_URL}/contractors" class="btn">Log in to your portal →</a>
      <p style="margin-top: 16px;">Remember — no contractor here paid to be listed. Your ranking is determined purely by your reviews and reputation.</p>
    `),
  });
}

/** Contractor notified when homeowner disputes their job report */
async function emailContractorJobDisputed({ contractorEmail, contractorName, description, reportedAmount, disputeNote }) {
  await sendEmail({
    to: contractorEmail,
    subject: `A homeowner disputed your job report — Harry's List`,
    html: baseTemplate(`
      <p>Hi ${esc(contractorName)},</p>
      <p>A homeowner has disputed the reported amount for the following job:</p>
      <p><strong>${esc(description)}</strong><br/>
      Your reported amount: <strong>$${Number(reportedAmount).toLocaleString()}</strong></p>
      ${disputeNote ? `<p>Homeowner's note: <em>"${esc(disputeNote)}"</em></p>` : ""}
      <p>Log in to your portal to view the dispute and edit your reported amount if needed. Once you update it, the homeowner will be prompted to confirm again.</p>
      <a href="${BASE_URL}/contractors" class="btn">View dispute →</a>
      <p>If you believe the amount is correct, contact us at <a href="mailto:harry@harryslistdfw.com">harry@harryslistdfw.com</a> and we'll help resolve it.</p>
    `),
  });
}

/** Homeowner notified when contractor updates disputed amount */
async function emailHomeownerDisputeUpdated({ homeownerEmail, homeownerName, contractorName, newAmount, description }) {
  await sendEmail({
    to: homeownerEmail,
    subject: `${contractorName} updated the job amount — please confirm`,
    html: baseTemplate(`
      <p>Hi ${esc(homeownerName)},</p>
      <p><strong>${esc(contractorName)}</strong> has updated the reported amount for your job:</p>
      <p><strong>${esc(description)}</strong><br/>
      Updated amount: <strong>$${Number(newAmount).toLocaleString()}</strong></p>
      <p>Please log in to confirm or dispute the updated amount.</p>
      <a href="${BASE_URL}" class="btn">Review updated amount →</a>
    `),
  });
}

/** Homeowner accepted contractor's quote */
async function emailContractorQuoteAccepted({ contractorEmail, contractorName, homeownerName, homeownerPhone, address, description, price }) {
  await sendEmail({
    to: contractorEmail,
    subject: `${homeownerName} accepted your quote — Harry's List`,
    html: baseTemplate(`
      <p>Hi ${esc(contractorName)},</p>
      <p>Great news — <strong>${esc(homeownerName)}</strong> accepted your quote of <strong>$${Number(price).toLocaleString()}</strong> for:</p>
      <p><strong>${esc(description)}</strong></p>
      <p>Here is their contact information:</p>
      <div style="background:#F2EDE6;border-radius:8px;padding:14px 18px;margin:16px 0;">
        ${address ? `<p style="margin:0 0 6px;font-size:14px;color:#1C2B22;">📍 <strong>${esc(address)}</strong></p>` : ""}
        ${homeownerPhone ? `<p style="margin:0;font-size:14px;color:#1C2B22;">📞 <strong>${esc(homeownerPhone)}</strong></p>` : ""}
      </div>
      <p>Reach out to coordinate timing and complete the job. Once done, submit your invoice through Harry's List.</p>
      <a href="${BASE_URL}/contractors" class="btn">Go to your portal →</a>
    `),
  });
}

module.exports = {
  emailHomeownerQuoteReceived,
  emailHomeownerConfirmJob,
  emailHomeownerConfirmReminder,
  emailHomeownerAutoConfirmed,
  emailHomeownerEstimateRequest,
  emailHomeownerDisputeUpdated,
  emailContractorNewQuote,
  emailContractorJobConfirmed,
  emailContractorJobDisputed,
  emailContractorPaymentOverdue,
  emailContractorMarkComplete,
  emailContractorApproved,
  emailContractorQuoteAccepted,
};
