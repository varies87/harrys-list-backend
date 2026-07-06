/**
 * api/quotes.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for quote requests: a homeowner sending a request to one
 * or more contractors, listing requests (scoped to a homeowner or a
 * contractor), and a contractor responding with a price/message or declining.
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/quotes  { action: "create", homeownerId, description, budget, timeline, zip, contractorIds: [...] }
 *   POST /api/quotes  { action: "listForHomeowner", homeownerId }
 *   POST /api/quotes  { action: "listForContractor", contractorId }
 *   POST /api/quotes  { action: "respond", quoteRequestId, contractorId, status, price, message }
 *   POST /api/quotes  { action: "markJobReported", quoteRequestId, contractorId }
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const {
  emailHomeownerQuoteReceived,
  emailHomeownerEstimateRequest,
  emailContractorNewQuote,
  emailContractorMarkComplete,
  emailContractorQuoteAccepted,
} = require("./email");
const {
  supabase,
  toId,
  getAuthedUser,
  setCors,
  rateLimit,
  clientIp,
  validateImageUpload,
} = require("./_shared");

function rowToRecipient(row) {
  return {
    contractorId: row.contractor_id,
    status: row.status,
    jobReported: !!row.job_reported,
    homeownerMarkedComplete: !!row.homeowner_marked_complete,
    homeownerAccepted: !!row.homeowner_accepted,
    quote:
      row.quote_price != null
        ? {
            price: Number(row.quote_price),
            message: row.quote_message || "",
            lineItems: row.quote_line_items || null,
          }
        : undefined,
  };
}

function rowToQuoteRequest(row, recipients) {
  return {
    id: row.id,
    homeownerId: row.homeowner_id,
    description: row.description,
    budget: row.budget,
    timeline: row.timeline,
    zip: row.zip,
    address: row.address || null,
    createdAt: row.created_at,
    recipients: recipients.map(rowToRecipient),
  };
}

async function createQuoteRequest({ homeownerId, description, budget, timeline, zip, address, contractorIds }) {
  // Check for existing open requests from this homeowner to any of the same contractors.
  // Two-step: first get all this homeowner's open quote request IDs, then check recipients.
  const { data: openRequests } = await supabase
    .from("quote_requests")
    .select("id")
    .eq("homeowner_id", toId(homeownerId));

  if (openRequests && openRequests.length > 0) {
    const openIds = openRequests.map((r) => r.id);
    const { data: existingRecipients } = await supabase
      .from("quote_recipients")
      .select("contractor_id")
      .in("quote_request_id", openIds)
      .in("contractor_id", contractorIds.map(toId))
      .in("status", ["sent", "responded"]);

    if (existingRecipients && existingRecipients.length > 0) {
      throw new Error("You already have an open quote request with one or more of these contractors. Check your existing requests before sending a new one.");
    }
  }

  const { data: qr, error: qrError } = await supabase
    .from("quote_requests")
    .insert({ homeowner_id: toId(homeownerId), description, budget, timeline, zip, address: address || null })
    .select()
    .single();
  if (qrError) throw new Error("Could not create quote request: " + qrError.message);

  const recipientRows = contractorIds.map((contractorId) => ({
    quote_request_id: qr.id,
    contractor_id: toId(contractorId),
    status: "sent",
  }));

  const { data: recipients, error: recipientsError } = await supabase
    .from("quote_recipients")
    .insert(recipientRows)
    .select();
  if (recipientsError) throw new Error("Could not create quote recipients: " + recipientsError.message);

  // Email each contractor about the new request
  const { data: contractorRows } = await supabase
    .from("contractors")
    .select("business_name, email")
    .in("id", contractorIds.map(toId));
  if (contractorRows) {
    contractorRows.forEach((c) => {
      if (c.email) {
        emailContractorNewQuote({
          contractorEmail: c.email,
          contractorName: c.business_name,
          description: qr.description,
          zip: qr.zip,
          budget: qr.budget,
          timeline: qr.timeline,
        }).catch(() => {});
      }
    });
  }

  return rowToQuoteRequest(qr, recipients);
}

async function listQuoteRequestsForHomeowner(homeownerId) {
  const { data: requests, error: reqError } = await supabase
    .from("quote_requests")
    .select("*")
    .eq("homeowner_id", toId(homeownerId))
    .order("created_at", { ascending: false });
  if (reqError) throw new Error("Could not list quote requests: " + reqError.message);

  return attachRecipients(requests);
}

async function listQuoteRequestsForContractor(contractorId) {
  const { data: recipientRows, error: recError } = await supabase
    .from("quote_recipients")
    .select("quote_request_id")
    .eq("contractor_id", toId(contractorId));
  if (recError) throw new Error("Could not list recipient rows: " + recError.message);

  const requestIds = [...new Set(recipientRows.map((r) => r.quote_request_id))];
  if (requestIds.length === 0) return [];

  const { data: requests, error: reqError } = await supabase
    .from("quote_requests")
    .select("*")
    .in("id", requestIds)
    .order("created_at", { ascending: false });
  if (reqError) throw new Error("Could not list quote requests: " + reqError.message);

  const result = await attachRecipients(requests);

  // For confirmed jobs OR accepted quotes, fetch homeowner phone
  const confirmedRequests = result.filter((qr) =>
    qr.recipients.some((r) => r.contractorId === contractorId && (r.homeownerMarkedComplete || r.homeownerAccepted))
  );
  if (confirmedRequests.length > 0) {
    const homeownerIds = [...new Set(confirmedRequests.map((qr) => qr.homeownerId).filter(Boolean))];
    if (homeownerIds.length > 0) {
      const { data: homeowners } = await supabase
        .from("homeowners")
        .select("id, phone")
        .in("id", homeownerIds.map(toId));
      const phoneMap = new Map((homeowners || []).map((h) => [String(h.id), h.phone]));
      return result.map((qr) => {
        const phone = phoneMap.get(String(qr.homeownerId));
        return phone ? { ...qr, homeownerPhone: phone } : qr;
      });
    }
  }

  return result;
}

async function attachRecipients(requests) {
  if (requests.length === 0) return [];
  const requestIds = requests.map((r) => toId(r.id));
  const { data: allRecipients, error } = await supabase
    .from("quote_recipients")
    .select("*")
    .in("quote_request_id", requestIds);
  if (error) throw new Error("Could not list recipients: " + error.message);

  return requests.map((r) =>
    rowToQuoteRequest(r, allRecipients.filter((rec) => toId(rec.quote_request_id) === toId(r.id)))
  );
}

async function respondToQuote(quoteRequestId, contractorId, status, price, message, lineItems) {
  // Only allow responding if currently in 'sent' status
  // Prevents un-declining or overwriting an existing quote
  const { data: existing } = await supabase
    .from("quote_recipients")
    .select("status")
    .eq("quote_request_id", toId(quoteRequestId))
    .eq("contractor_id", toId(contractorId))
    .maybeSingle();

  if (!existing) throw new Error("Quote recipient not found.");
  if (existing.status !== "sent") {
    throw new Error("This quote request has already been responded to or declined.");
  }

  const updates = { status };
  if (status === "responded") {
    updates.quote_price = price;
    updates.quote_message = message || "";
    if (lineItems && lineItems.length > 0) {
      updates.quote_line_items = lineItems;
    }
  }

  const { error } = await supabase
    .from("quote_recipients")
    .update(updates)
    .eq("quote_request_id", toId(quoteRequestId))
    .eq("contractor_id", toId(contractorId));
  if (error) throw new Error("Could not update quote response: " + error.message);

  // Email homeowner when contractor responds with a quote
  if (status === "responded") {
    const { data: qr } = await supabase
      .from("quote_requests")
      .select("description, homeowner_id")
      .eq("id", toId(quoteRequestId))
      .maybeSingle();
    const { data: contractor } = await supabase
      .from("contractors")
      .select("business_name")
      .eq("id", toId(contractorId))
      .maybeSingle();
    if (qr?.homeowner_id) {
      const { data: homeowner } = await supabase
        .from("homeowners")
        .select("name, email")
        .eq("id", toId(qr.homeowner_id))
        .maybeSingle();
      if (homeowner?.email) {
        emailHomeownerQuoteReceived({
          homeownerEmail: homeowner.email,
          homeownerName: homeowner.name,
          contractorName: contractor?.business_name || "A contractor",
          price,
          message,
        }).catch(() => {});
      }
    }
  }

  return { success: true };
}

async function markJobReported(quoteRequestId, contractorId) {
  const { error } = await supabase
    .from("quote_recipients")
    .update({ job_reported: true })
    .eq("quote_request_id", toId(quoteRequestId))
    .eq("contractor_id", toId(contractorId));
  if (error) throw new Error("Could not mark job reported: " + error.message);
  return { success: true };
}

const MAX_QUOTE_PHOTOS = 5;

function rowToPhoto(row) {
  return {
    id: row.id,
    quoteRequestId: row.quote_request_id,
    publicUrl: row.public_url,
    thumbnailUrl: row.thumbnail_url || row.public_url,
    createdAt: row.created_at,
  };
}

/**
 * Uploads a photo for a quote request. Scoped to the homeowner who owns
 * the quote request -- verified via session token.
 */
async function uploadQuotePhoto(homeownerId, quoteRequestId, fileBase64, fileName, contentType, thumbnailBase64) {
  // Verify this quote request belongs to this homeowner.
  const { data: qr, error: qrError } = await supabase
    .from("quote_requests")
    .select("id, homeowner_id")
    .eq("id", toId(quoteRequestId))
    .maybeSingle();
  if (qrError || !qr) throw new Error("Quote request not found.");
  if (String(qr.homeowner_id) !== String(homeownerId)) {
    throw new Error("This quote request doesn't belong to your account.");
  }

  // Check photo count limit.
  const { count, error: countError } = await supabase
    .from("quote_request_photos")
    .select("id", { count: "exact", head: true })
    .eq("quote_request_id", toId(quoteRequestId));
  if (countError) throw new Error("Could not check photo count: " + countError.message);
  if (count >= MAX_QUOTE_PHOTOS) {
    throw new Error(`Maximum ${MAX_QUOTE_PHOTOS} photos per quote request.`);
  }

  // Validate the upload by its actual bytes (PNG/JPEG/WebP only) and use a
  // sanitized filename. Rejects SVG/HTML and content-type confusion (M-1).
  const { buffer, contentType: safeType, safeName } = validateImageUpload(fileBase64, fileName);
  const ts = Date.now();
  const path = `quote-requests/${quoteRequestId}/${ts}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("portfolio-photos")
    .upload(path, buffer, { contentType: safeType, upsert: false });
  if (uploadError) throw new Error("Could not upload photo: " + uploadError.message);

  const { data: urlData } = supabase.storage.from("portfolio-photos").getPublicUrl(path);

  let thumbnailUrl = null;
  if (thumbnailBase64) {
    try {
      const { buffer: thumbBuffer, contentType: thumbType } = validateImageUpload(
        thumbnailBase64,
        `thumb-${safeName}`
      );
      const thumbPath = `quote-requests/${quoteRequestId}/${ts}-thumb-${safeName}`;
      const { error: thumbError } = await supabase.storage
        .from("portfolio-photos")
        .upload(thumbPath, thumbBuffer, { contentType: thumbType, upsert: false });
      if (!thumbError) {
        const { data: thumbUrlData } = supabase.storage.from("portfolio-photos").getPublicUrl(thumbPath);
        thumbnailUrl = thumbUrlData.publicUrl;
      }
    } catch (_) {
      /* invalid thumbnail -- skip it, keep the main photo */
    }
  }

  const { data, error } = await supabase
    .from("quote_request_photos")
    .insert({
      quote_request_id: toId(quoteRequestId),
      storage_path: path,
      public_url: urlData.publicUrl,
      thumbnail_url: thumbnailUrl,
    })
    .select()
    .single();
  if (error) throw new Error("Could not save photo record: " + error.message);
  return rowToPhoto(data);
}

async function listQuotePhotos(quoteRequestId) {
  const { data, error } = await supabase
    .from("quote_request_photos")
    .select("*")
    .eq("quote_request_id", toId(quoteRequestId))
    .order("created_at", { ascending: true });
  if (error) throw new Error("Could not list photos: " + error.message);
  return data.map(rowToPhoto);
}



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

async function handleQuotesRequest(body, req) {
  const { action } = body || {};

  try {
    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return { statusCode: 401, body: { error: "You must be signed in." } };
    }

    const { homeownerId, contractorId } = await getProfileIds(authUser.id);

    if (action === "create") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const { description, contractorIds } = body;
      if (!description || !contractorIds || contractorIds.length === 0) {
        return { statusCode: 400, body: { error: "description and at least one contractorId are required." } };
      }
      if (String(description).length > 5000) {
        return { statusCode: 400, body: { error: "Description must be 5000 characters or less." } };
      }
      if (contractorIds.length > 50) {
        return { statusCode: 400, body: { error: "Too many contractors selected." } };
      }
      if (!(await rateLimit(`quote-create:${clientIp(req)}`, { max: 20, windowMs: 60 * 60 * 1000 }))) {
        return { statusCode: 429, body: { error: "Too many requests. Please try again later." } };
      }
      // homeownerId comes from the verified session, not the request body.
      const quoteRequest = await createQuoteRequest({ ...body, homeownerId });
      return { statusCode: 200, body: { quoteRequest } };
    }

    if (action === "listForHomeowner") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const quoteRequests = await listQuoteRequestsForHomeowner(homeownerId);
      return { statusCode: 200, body: { quoteRequests } };
    }

    if (action === "listForContractor") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      const quoteRequests = await listQuoteRequestsForContractor(contractorId);
      return { statusCode: 200, body: { quoteRequests } };
    }

    if (action === "respond") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      const { quoteRequestId, status, price, message } = body;
      if (!quoteRequestId || !status) {
        return { statusCode: 400, body: { error: "quoteRequestId and status are required." } };
      }
      if (status !== "responded" && status !== "declined") {
        return { statusCode: 400, body: { error: "status must be 'responded' or 'declined'." } };
      }
      if (status === "responded") {
        const p = Number(price);
        if (!Number.isFinite(p) || p <= 0 || p > 10000000) {
          return { statusCode: 400, body: { error: "price must be a positive dollar amount." } };
        }
      }
      // contractorId comes from the verified session.
      const result = await respondToQuote(quoteRequestId, contractorId, status, price, message, body.lineItems || null);
      return { statusCode: 200, body: result };
    }

    if (action === "markJobReported") {
      if (!contractorId) return { statusCode: 403, body: { error: "No contractor profile found for this account." } };
      const { quoteRequestId } = body;
      if (!quoteRequestId) {
        return { statusCode: 400, body: { error: "quoteRequestId is required." } };
      }
      // contractorId comes from the verified session.
      const result = await markJobReported(quoteRequestId, contractorId);
      return { statusCode: 200, body: result };
    }

    if (action === "listPhotos") {
      if (!body.quoteRequestId) {
        return { statusCode: 400, body: { error: "quoteRequestId is required." } };
      }
      const photos = await listQuotePhotos(body.quoteRequestId);
      return { statusCode: 200, body: { photos } };
    }

    if (action === "uploadPhoto") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const { quoteRequestId, fileBase64, fileName, contentType, thumbnailBase64 } = body;
      if (!quoteRequestId || !fileBase64 || !fileName) {
        return { statusCode: 400, body: { error: "quoteRequestId, fileBase64, and fileName are required." } };
      }
      const photo = await uploadQuotePhoto(homeownerId, quoteRequestId, fileBase64, fileName, contentType || "image/jpeg", thumbnailBase64 || null);
      return { statusCode: 200, body: { photo } };
    }

    if (action === "acceptQuote") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found." } };
      const { quoteRequestId, contractorId: targetContractorId } = body;
      if (!quoteRequestId || !targetContractorId) {
        return { statusCode: 400, body: { error: "quoteRequestId and contractorId are required." } };
      }
      // Verify quote request belongs to this homeowner
      const { data: qr } = await supabase
        .from("quote_requests")
        .select("homeowner_id, description, address")
        .eq("id", toId(quoteRequestId))
        .maybeSingle();
      if (!qr || String(qr.homeowner_id) !== String(homeownerId)) {
        return { statusCode: 403, body: { error: "Not authorized." } };
      }
      // Verify recipient has responded with a quote
      const { data: recipient } = await supabase
        .from("quote_recipients")
        .select("status, quote_price, homeowner_accepted")
        .eq("quote_request_id", toId(quoteRequestId))
        .eq("contractor_id", toId(targetContractorId))
        .maybeSingle();
      if (!recipient) return { statusCode: 404, body: { error: "Recipient not found." } };
      if (recipient.status !== "responded") {
        return { statusCode: 400, body: { error: "Can only accept a quote after the contractor has responded." } };
      }
      if (recipient.homeowner_accepted) {
        return { statusCode: 400, body: { error: "You have already accepted this quote." } };
      }
      // Mark as accepted
      const { error } = await supabase
        .from("quote_recipients")
        .update({ homeowner_accepted: true, homeowner_accepted_at: new Date().toISOString() })
        .eq("quote_request_id", toId(quoteRequestId))
        .eq("contractor_id", toId(targetContractorId));
      if (error) throw new Error("Could not accept quote: " + error.message);

      // Reveal address + phone to contractor via email
      const { data: contractor } = await supabase
        .from("contractors").select("business_name, email").eq("id", toId(targetContractorId)).maybeSingle();
      const { data: homeowner } = await supabase
        .from("homeowners").select("name, phone").eq("id", toId(homeownerId)).maybeSingle();
      if (contractor?.email) {
        emailContractorQuoteAccepted({
          contractorEmail: contractor.email,
          contractorName: contractor.business_name,
          homeownerName: homeowner?.name || "The homeowner",
          homeownerPhone: homeowner?.phone || null,
          address: qr.address || null,
          description: qr.description,
          price: recipient.quote_price,
        }).catch(() => {});
      }
      return { statusCode: 200, body: { success: true } };
    }

    if (action === "markComplete") {
      if (!homeownerId) return { statusCode: 403, body: { error: "No homeowner profile found for this account." } };
      const { quoteRequestId, contractorId: targetContractorId } = body;
      if (!quoteRequestId || !targetContractorId) {
        return { statusCode: 400, body: { error: "quoteRequestId and contractorId are required." } };
      }
      // Verify this quote request belongs to this homeowner
      const { data: qr, error: qrError } = await supabase
        .from("quote_requests")
        .select("homeowner_id")
        .eq("id", toId(quoteRequestId))
        .maybeSingle();
      if (qrError || !qr) return { statusCode: 404, body: { error: "Quote request not found." } };
      if (String(qr.homeowner_id) !== String(homeownerId)) {
        return { statusCode: 403, body: { error: "This quote request doesn't belong to your account." } };
      }
      // Verify the contractor actually responded (not just received the request)
      const { data: recipient, error: recipientError } = await supabase
        .from("quote_recipients")
        .select("status, homeowner_marked_complete")
        .eq("quote_request_id", toId(quoteRequestId))
        .eq("contractor_id", toId(targetContractorId))
        .maybeSingle();
      if (recipientError || !recipient) return { statusCode: 404, body: { error: "Recipient not found." } };
      if (recipient.status !== "responded") {
        return { statusCode: 400, body: { error: "Can only mark a job complete after the contractor has responded with a quote." } };
      }
      if (recipient.homeowner_marked_complete) {
        return { statusCode: 400, body: { error: "You have already marked this job as complete." } };
      }
      const { error } = await supabase
        .from("quote_recipients")
        .update({
          homeowner_marked_complete: true,
          homeowner_marked_complete_at: new Date().toISOString(),
        })
        .eq("quote_request_id", toId(quoteRequestId))
        .eq("contractor_id", toId(targetContractorId));
      if (error) throw new Error("Could not mark complete: " + error.message);
      return { statusCode: 200, body: { success: true } };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("quotes handler error:", err);
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
  const result = await handleQuotesRequest(req.body, req);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleQuotesRequest = handleQuotesRequest;
module.exports.rowToQuoteRequest = rowToQuoteRequest;
module.exports.rowToRecipient = rowToRecipient;
