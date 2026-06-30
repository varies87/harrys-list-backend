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

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

function rowToRecipient(row) {
  return {
    contractorId: row.contractor_id,
    status: row.status,
    jobReported: !!row.job_reported,
    quote:
      row.quote_price != null
        ? { price: Number(row.quote_price), message: row.quote_message || "" }
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
    createdAt: row.created_at,
    recipients: recipients.map(rowToRecipient),
  };
}

async function createQuoteRequest({ homeownerId, description, budget, timeline, zip, contractorIds }) {
  const { data: qr, error: qrError } = await supabase
    .from("quote_requests")
    .insert({ homeowner_id: toId(homeownerId), description, budget, timeline, zip })
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

  return attachRecipients(requests);
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

async function respondToQuote(quoteRequestId, contractorId, status, price, message) {
  const updates = { status };
  if (status === "responded") {
    updates.quote_price = price;
    updates.quote_message = message || "";
  }

  const { error } = await supabase
    .from("quote_recipients")
    .update(updates)
    .eq("quote_request_id", toId(quoteRequestId))
    .eq("contractor_id", toId(contractorId));
  if (error) throw new Error("Could not update quote response: " + error.message);

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

async function handleQuotesRequest(body) {
  const { action } = body || {};

  try {
    if (action === "create") {
      const { homeownerId, description, contractorIds } = body;
      if (!homeownerId || !description || !contractorIds || contractorIds.length === 0) {
        return {
          statusCode: 400,
          body: { error: "homeownerId, description, and at least one contractorId are required." },
        };
      }
      const quoteRequest = await createQuoteRequest(body);
      return { statusCode: 200, body: { quoteRequest } };
    }

    if (action === "listForHomeowner") {
      if (!body.homeownerId) return { statusCode: 400, body: { error: "homeownerId is required." } };
      const quoteRequests = await listQuoteRequestsForHomeowner(body.homeownerId);
      return { statusCode: 200, body: { quoteRequests } };
    }

    if (action === "listForContractor") {
      if (!body.contractorId) return { statusCode: 400, body: { error: "contractorId is required." } };
      const quoteRequests = await listQuoteRequestsForContractor(body.contractorId);
      return { statusCode: 200, body: { quoteRequests } };
    }

    if (action === "respond") {
      const { quoteRequestId, contractorId, status, price, message } = body;
      if (!quoteRequestId || !contractorId || !status) {
        return { statusCode: 400, body: { error: "quoteRequestId, contractorId, and status are required." } };
      }
      const result = await respondToQuote(quoteRequestId, contractorId, status, price, message);
      return { statusCode: 200, body: result };
    }

    if (action === "markJobReported") {
      const { quoteRequestId, contractorId } = body;
      if (!quoteRequestId || !contractorId) {
        return { statusCode: 400, body: { error: "quoteRequestId and contractorId are required." } };
      }
      const result = await markJobReported(quoteRequestId, contractorId);
      return { statusCode: 200, body: result };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("quotes handler error:", err);
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
  const result = await handleQuotesRequest(req.body);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleQuotesRequest = handleQuotesRequest;
module.exports.rowToQuoteRequest = rowToQuoteRequest;
module.exports.rowToRecipient = rowToRecipient;
