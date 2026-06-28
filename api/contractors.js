/**
 * api/contractors.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for everything contractor-related: listing approved
 * contractors for the homeowner directory, creating a new contractor profile
 * (signup), updating an existing one, and uploading a logo image.
 *
 * Routes (all hit the same URL, distinguished by the `action` field in the
 * request body, since this keeps a single simple file instead of many tiny
 * ones -- a common pattern for small backends):
 *   POST /api/contractors  { action: "list" }
 *   POST /api/contractors  { action: "create", contractor: {...} }
 *   POST /api/contractors  { action: "update", contractorId, updates: {...} }
 *   POST /api/contractors  { action: "uploadLogo", contractorId, fileBase64, fileName }
 *
 * ENVIRONMENT VARIABLES (same ones already set in Vercel for the payment function)
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

/** Converts a DB row (snake_case) into the shape the frontend expects (camelCase, with service area as a Set-friendly array). */
function rowToContractor(row) {
  return {
    id: row.id,
    businessName: row.business_name,
    trade: row.trade,
    yearsInBusiness: row.years_in_business,
    bio: row.bio,
    licenseInfo: row.license_info,
    serviceArea: {
      mode: row.service_area_mode,
      zipCodes: row.service_area_zips ? row.service_area_zips.split(",").filter(Boolean) : [],
    },
    status: row.status,
    thumbsUp: row.thumbs_up || 0,
    thumbsDown: row.thumbs_down || 0,
    logoUrl: row.logo_url || null,
    completedJobs: [], // populated separately by the jobs endpoint
    reviews: [], // reserved for a future reviews table
  };
}

/** Converts the frontend's contractor shape into DB columns for insert/update. */
function contractorToRow(contractor) {
  const row = {};
  if (contractor.businessName !== undefined) row.business_name = contractor.businessName;
  if (contractor.trade !== undefined) row.trade = contractor.trade;
  if (contractor.yearsInBusiness !== undefined) row.years_in_business = contractor.yearsInBusiness;
  if (contractor.bio !== undefined) row.bio = contractor.bio;
  if (contractor.licenseInfo !== undefined) row.license_info = contractor.licenseInfo;
  if (contractor.serviceArea !== undefined) {
    row.service_area_mode = contractor.serviceArea.mode;
    const zips = contractor.serviceArea.zipCodes;
    row.service_area_zips = zips ? (Array.isArray(zips) ? zips.join(",") : [...zips].join(",")) : "";
  }
  if (contractor.status !== undefined) row.status = contractor.status;
  if (contractor.thumbsUp !== undefined) row.thumbs_up = contractor.thumbsUp;
  if (contractor.thumbsDown !== undefined) row.thumbs_down = contractor.thumbsDown;
  if (contractor.logoUrl !== undefined) row.logo_url = contractor.logoUrl;
  return row;
}

async function listContractors() {
  const { data, error } = await supabase.from("contractors").select("*").order("created_at", { ascending: false });
  if (error) throw new Error("Could not list contractors: " + error.message);
  return data.map(rowToContractor);
}

async function createContractor(contractor) {
  const row = contractorToRow({ ...contractor, status: contractor.status || "pending" });
  const { data, error } = await supabase.from("contractors").insert(row).select().single();
  if (error) throw new Error("Could not create contractor: " + error.message);
  return rowToContractor(data);
}

async function updateContractor(contractorId, updates) {
  const row = contractorToRow(updates);
  const { data, error } = await supabase.from("contractors").update(row).eq("id", contractorId).select().single();
  if (error) throw new Error("Could not update contractor: " + error.message);
  return rowToContractor(data);
}

/**
 * Uploads a logo image to Supabase Storage and saves its public URL onto
 * the contractor's row. fileBase64 should be a base64-encoded image (without
 * the "data:image/png;base64," prefix -- the frontend strips that before
 * sending, to keep the payload smaller and the backend simpler).
 */
async function uploadLogo(contractorId, fileBase64, fileName, contentType) {
  const buffer = Buffer.from(fileBase64, "base64");
  const path = `${contractorId}/${Date.now()}-${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("contractor-logos")
    .upload(path, buffer, { contentType, upsert: true });
  if (uploadError) throw new Error("Could not upload logo: " + uploadError.message);

  const { data: publicUrlData } = supabase.storage.from("contractor-logos").getPublicUrl(path);
  const logoUrl = publicUrlData.publicUrl;

  const { data, error } = await supabase
    .from("contractors")
    .update({ logo_url: logoUrl })
    .eq("id", contractorId)
    .select()
    .single();
  if (error) throw new Error("Could not save logo URL: " + error.message);

  return rowToContractor(data);
}

async function handleContractorsRequest(body) {
  const { action } = body || {};

  try {
    if (action === "list") {
      const contractors = await listContractors();
      return { statusCode: 200, body: { contractors } };
    }

    if (action === "create") {
      if (!body.contractor || !body.contractor.businessName) {
        return { statusCode: 400, body: { error: "contractor.businessName is required." } };
      }
      const contractor = await createContractor(body.contractor);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "update") {
      if (!body.contractorId) {
        return { statusCode: 400, body: { error: "contractorId is required." } };
      }
      const contractor = await updateContractor(body.contractorId, body.updates || {});
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "uploadLogo") {
      if (!body.contractorId || !body.fileBase64 || !body.fileName) {
        return { statusCode: 400, body: { error: "contractorId, fileBase64, and fileName are required." } };
      }
      const contractor = await uploadLogo(
        body.contractorId,
        body.fileBase64,
        body.fileName,
        body.contentType || "image/png"
      );
      return { statusCode: 200, body: { contractor } };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("contractors handler error:", err);
    return { statusCode: 500, body: { error: err.message } };
  }
}

module.exports = async function handler(req, res) {
  // CORS: allow this function to be called from any origin, including the
  // sandboxed iframe Claude's artifact viewer runs the frontend in. Without
  // these headers, browsers block the request before it even reaches this
  // code, often showing a generic "Load failed" or "Failed to fetch" error
  // with no further detail.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Browsers send a preflight OPTIONS request before the real POST to ask
  // "are you okay with this?" -- must answer it directly, not run real logic.
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleContractorsRequest(req.body);
  res.status(result.statusCode).json(result.body);
};

// Exported for testing.
module.exports.handleContractorsRequest = handleContractorsRequest;
module.exports.rowToContractor = rowToContractor;
module.exports.contractorToRow = contractorToRow;
module.exports.contractorToRow = contractorToRow;
