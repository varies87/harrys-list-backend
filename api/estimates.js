/**
 * api/estimates.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for in-person estimate requests. A contractor can request
 * an in-person visit for a quote request they've received. The homeowner
 * sees the contractor's full profile and can accept or decline. On accept,
 * the homeowner's phone number is revealed to the contractor.
 *
 * Routes:
 *   POST /api/estimates  { action: "request", quoteRequestId, message }         <- contractor auth
 *   POST /api/estimates  { action: "listForHomeowner" }                          <- homeowner auth
 *   POST /api/estimates  { action: "listForContractor" }                         <- contractor auth
 *   POST /api/estimates  { action: "respond", estimateRequestId, status }        <- homeowner auth
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const { emailHomeownerEstimateRequest } = require("./email");
const {
  supabase,
  toId,
  getAuthedUser,
  setCors,
  rateLimit,
  clientIp,
} = require("./_shared");

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

function rowToEstimateRequest(row) {
  return {
    id: row.id,
    quoteRequestId: row.quote_request_id,
    contractorId: row.contractor_id,
    homeownerId: row.homeowner_id,
    message: row.message || null,
    status: row.status,
    createdAt: row.created_at,
    // Only included when status is accepted
    homeownerPhone: row.homeowner_phone || null,
    // Contractor info for homeowner view
    contractor: row.contractor || null,
    // Quote request description for context
    quoteDescription: row.quote_description || null,
  };
}

/**
 * Contractor requests an in-person estimate for a quote request they received.
 * Verifies the contractor is actually a recipient of that quote request.
 */
async function requestEstimate(contractorId, quoteRequestId, message) {
  // Verify contractor is a recipient of this quote request AND hasn't declined
  const { data: recipient, error: recipientError } = await supabase
    .from("quote_recipients")
    .select("id, quote_request_id, status")
    .eq("quote_request_id", toId(quoteRequestId))
    .eq("contractor_id", toId(contractorId))
    .maybeSingle();
  if (recipientError) throw new Error("Could not verify quote request: " + recipientError.message);
  if (!recipient) throw new Error("You are not a recipient of this quote request.");
  if (recipient.status === "declined") throw new Error("You cannot request an estimate after declining this job.");

  // Get homeowner id from the quote request
  const { data: qr, error: qrError } = await supabase
    .from("quote_requests")
    .select("homeowner_id")
    .eq("id", toId(quoteRequestId))
    .single();
  if (qrError || !qr) throw new Error("Quote request not found.");

  const { data, error } = await supabase
    .from("estimate_requests")
    .insert({
      quote_request_id: toId(quoteRequestId),
      contractor_id: toId(contractorId),
      homeowner_id: qr.homeowner_id,
      message: message || null,
      status: "pending",
    })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("You already requested an estimate for this job.");
    throw new Error("Could not create estimate request: " + error.message);
  }

  // Email homeowner about the estimate request
  const { data: homeowner } = await supabase
    .from("homeowners").select("name, email").eq("id", toId(data.homeowner_id)).maybeSingle();
  const { data: contractor } = await supabase
    .from("contractors").select("business_name, trade").eq("id", toId(contractorId)).maybeSingle();
  const { data: quoteReqData } = await supabase
    .from("quote_requests").select("description").eq("id", toId(quoteRequestId)).maybeSingle();
  if (homeowner?.email && contractor) {
    emailHomeownerEstimateRequest({
      homeownerEmail: homeowner.email,
      homeownerName: homeowner.name,
      contractorName: contractor.business_name,
      contractorTrade: contractor.trade,
      message,
    }).catch(() => {});
  }

  return rowToEstimateRequest(data);
}

/**
 * Lists estimate requests for the current homeowner, with contractor profile
 * info attached so the homeowner can see who's requesting.
 */
async function listEstimatesForHomeowner(homeownerId) {
  const { data, error } = await supabase
    .from("estimate_requests")
    .select("*, quote_requests(description)")
    .eq("homeowner_id", toId(homeownerId))
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list estimate requests: " + error.message);

  if (data.length === 0) return [];

  // Fetch contractor profiles for each estimate request
  const contractorIds = [...new Set(data.map((r) => r.contractor_id))];
  const { data: contractors, error: contractorsError } = await supabase
    .from("contractors")
    .select("id, business_name, trade, bio, years_in_business, license_info, logo_url, thumbs_up_count, service_area_mode, service_area_zips")
    .in("id", contractorIds);
  if (contractorsError) throw new Error("Could not fetch contractors: " + contractorsError.message);

  const contractorMap = new Map((contractors || []).map((c) => [c.id, c]));

  return data.map((row) => ({
    ...rowToEstimateRequest(row),
    quoteDescription: row.quote_requests?.description || null,
    contractor: contractorMap.get(row.contractor_id) ? {
      id: row.contractor_id,
      businessName: contractorMap.get(row.contractor_id).business_name,
      trade: contractorMap.get(row.contractor_id).trade,
      bio: contractorMap.get(row.contractor_id).bio,
      yearsInBusiness: contractorMap.get(row.contractor_id).years_in_business,
      licenseInfo: contractorMap.get(row.contractor_id).license_info,
      logoUrl: contractorMap.get(row.contractor_id).logo_url,
      thumbsUp: contractorMap.get(row.contractor_id).thumbs_up_count || 0,
    } : null,
  }));
}

/**
 * Lists estimate requests sent by the current contractor, with homeowner
 * phone revealed only when status is accepted.
 */
async function listEstimatesForContractor(contractorId) {
  const { data, error } = await supabase
    .from("estimate_requests")
    .select("*, quote_requests(description)")
    .eq("contractor_id", toId(contractorId))
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list estimate requests: " + error.message);

  if (data.length === 0) return [];

  // For accepted requests, fetch the homeowner's phone number
  const acceptedHomeownerIds = data
    .filter((r) => r.status === "accepted")
    .map((r) => r.homeowner_id);

  let phoneMap = new Map();
  if (acceptedHomeownerIds.length > 0) {
    const { data: homeowners } = await supabase
      .from("homeowners")
      .select("id, phone")
      .in("id", acceptedHomeownerIds);
    phoneMap = new Map((homeowners || []).map((h) => [h.id, h.phone]));
  }

  return data.map((row) => ({
    ...rowToEstimateRequest(row),
    quoteDescription: row.quote_requests?.description || null,
    homeownerPhone: row.status === "accepted" ? (phoneMap.get(row.homeowner_id) || null) : null,
  }));
}

/**
 * Homeowner accepts or declines an estimate request.
 * Verifies the estimate request belongs to this homeowner.
 */
async function respondToEstimate(homeownerId, estimateRequestId, status) {
  const { data: existing, error: lookupError } = await supabase
    .from("estimate_requests")
    .select("id, homeowner_id")
    .eq("id", toId(estimateRequestId))
    .maybeSingle();
  if (lookupError || !existing) throw new Error("Estimate request not found.");
  if (String(existing.homeowner_id) !== String(homeownerId)) {
    throw new Error("This estimate request doesn't belong to your account.");
  }

  const { data, error } = await supabase
    .from("estimate_requests")
    .update({ status })
    .eq("id", toId(estimateRequestId))
    .select()
    .single();
  if (error) throw new Error("Could not update estimate request: " + error.message);
  return rowToEstimateRequest(data);
}

async function handleEstimatesRequest(body, req) {
  const { action } = body || {};

  try {
    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return { statusCode: 401, body: { error: "You must be signed in." } };
    }

    const { homeownerId, contractorId } = await getProfileIds(authUser.id);

    if (action === "request") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      if (!body.quoteRequestId) return { statusCode: 400, body: { error: "quoteRequestId is required." } };
      if (body.message && String(body.message).length > 2000) {
        return { statusCode: 400, body: { error: "Message must be 2000 characters or less." } };
      }
      if (!(await rateLimit(`estimate-request:${clientIp(req)}`, { max: 30, windowMs: 60 * 60 * 1000 }))) {
        return { statusCode: 429, body: { error: "Too many requests. Please try again later." } };
      }
      const estimateRequest = await requestEstimate(contractorId, body.quoteRequestId, body.message || null);
      return { statusCode: 200, body: { estimateRequest } };
    }

    if (action === "listForHomeowner") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const estimateRequests = await listEstimatesForHomeowner(homeownerId);
      return { statusCode: 200, body: { estimateRequests } };
    }

    if (action === "listForContractor") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      const estimateRequests = await listEstimatesForContractor(contractorId);
      return { statusCode: 200, body: { estimateRequests } };
    }

    if (action === "respond") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      if (!body.estimateRequestId || !body.status) {
        return { statusCode: 400, body: { error: "estimateRequestId and status are required." } };
      }
      if (!["accepted", "declined"].includes(body.status)) {
        return { statusCode: 400, body: { error: "status must be accepted or declined." } };
      }
      const estimateRequest = await respondToEstimate(homeownerId, body.estimateRequestId, body.status);
      return { statusCode: 200, body: { estimateRequest } };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("estimates handler error:", err);
    return { statusCode: 500, body: { error: err.message } };
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

  const result = await handleEstimatesRequest(req.body, req);
  res.status(result.statusCode).json(result.body);
};
