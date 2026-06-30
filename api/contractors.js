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
 *   POST /api/contractors  { action: "listPending", adminPassword }
 *   POST /api/contractors  { action: "setStatus", adminPassword, contractorId, status }
 *
 * ENVIRONMENT VARIABLES (same ones already set in Vercel for the payment function)
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 *   ADMIN_PASSWORD   -- a password of your choosing, checked against the
 *                       "adminPassword" field on listPending/setStatus
 *                       requests. Set this in Vercel project settings, same
 *                       place as the other secrets -- never in code.
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

/**
 * See the matching comment in quotes.js -- ids are int8 (numbers) in the
 * database, but always arrive as strings from the frontend over JSON.
 */
function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

/**
 * Converts a DB row (snake_case) into the shape the frontend expects
 * (camelCase, with service area as a Set-friendly array).
 *
 * thumbsUp comes directly from contractors.thumbs_up_count -- a
 * denormalized counter kept in sync by reviews.js's toggleThumbsUp, so
 * every contractor in the directory list gets an accurate, live thumbs-up
 * count with zero extra queries. (Whether the CURRENT homeowner specifically
 * has thumbs-upped a given contractor is a separate, on-demand check --
 * see reviews.js's getThumbsUpStatus -- only needed when viewing one
 * contractor's profile, not for every card in the grid.)
 *
 * reviews is an optional second arg -- the directory listing (listContractors)
 * intentionally does NOT fetch full review text/ratings per-contractor to
 * keep that query fast; callers that need real review data (a contractor's
 * own profile, the profile modal) fetch it from reviews.js or
 * getContractorWithReviews below and merge it in. Defaults to [].
 */
function rowToContractor(row, reviews) {
  return {
    id: row.id,
    createdAt: row.created_at,
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
    thumbsUp: row.thumbs_up_count || 0,
    thumbsDown: row.thumbs_down || 0,
    logoUrl: row.logo_url || null,
    completedJobs: [], // populated separately by the jobs endpoint
    reviews: reviews || [], // populated separately by the reviews endpoint when needed
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
    // Defensive: a Set sent from a client silently becomes {} once it
    // crosses JSON (JSON.stringify(new Set()) === "{}"), which is not
    // iterable and would crash a naive [...zips]. The frontend should
    // always send a plain array, but never trust that blindly here --
    // fall back to an empty list for anything that isn't a real array.
    row.service_area_zips = Array.isArray(zips) ? zips.join(",") : "";
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
  return data.map((row) => rowToContractor(row));
}

/**
 * Returns ONLY contractors with status "pending" -- used by the admin
 * approval screen. Requires the correct admin password (see
 * checkAdminPassword below) since this could otherwise be used to see
 * every pending signup, including ones not yet vetted.
 */
async function listPendingContractors() {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list pending contractors: " + error.message);
  return data.map((row) => rowToContractor(row));
}

/**
 * Checks a password against ADMIN_PASSWORD, an environment variable set
 * directly in Vercel (never in code, same pattern as the Stripe/Supabase
 * secret keys). Returns true/false -- callers are responsible for returning
 * a 401 if this is false. This is intentionally simple (a single shared
 * password, not real per-admin accounts) since this is a one-person
 * operation right now; revisit if more than one person needs admin access.
 */
function checkAdminPassword(password) {
  const realPassword = process.env.ADMIN_PASSWORD;
  if (!realPassword) {
    // Fail closed: if the env var was never set, nobody should be able to
    // get in by guessing an empty string or similar.
    return false;
  }
  return password === realPassword;
}

async function createContractor(contractor) {
  const row = contractorToRow({ ...contractor, status: contractor.status || "pending" });
  const { data, error } = await supabase.from("contractors").insert(row).select().single();
  if (error) throw new Error("Could not create contractor: " + error.message);
  return rowToContractor(data);
}

async function updateContractor(contractorId, updates) {
  const row = contractorToRow(updates);
  const { data, error } = await supabase.from("contractors").update(row).eq("id", toId(contractorId)).select().single();
  if (error) throw new Error("Could not update contractor: " + error.message);
  return rowToContractor(data);
}

/**
 * Looks up a single contractor by id, with their real reviews attached --
 * used for the profile modal and a contractor's own "viewing as" screen,
 * where seeing actual review text/ratings matters (unlike the directory
 * list, which intentionally skips fetching full reviews for speed -- see
 * the comment on rowToContractor). Thumbs-up count comes along for free
 * since it's a column on the contractors row itself.
 */
async function getContractorWithReviews(contractorId) {
  const cId = toId(contractorId);

  const { data: row, error: rowError } = await supabase
    .from("contractors")
    .select("*")
    .eq("id", cId)
    .single();
  if (rowError) throw new Error("Could not find contractor: " + rowError.message);

  const { data: reviewRows, error: reviewsError } = await supabase
    .from("reviews")
    .select("*")
    .eq("contractor_id", cId)
    .order("created_at", { ascending: false });
  if (reviewsError) throw new Error("Could not load reviews: " + reviewsError.message);

  const reviews = (reviewRows || []).map((r) => ({
    id: r.id,
    contractorId: r.contractor_id,
    homeownerId: r.homeowner_id,
    jobId: r.job_id,
    rating: r.rating,
    text: r.text_review || "",
    createdAt: r.created_at,
  }));

  return rowToContractor(row, reviews);
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
    .eq("id", toId(contractorId))
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

    if (action === "listPending") {
      if (!checkAdminPassword(body.adminPassword)) {
        return { statusCode: 401, body: { error: "Incorrect admin password." } };
      }
      const contractors = await listPendingContractors();
      return { statusCode: 200, body: { contractors } };
    }

    if (action === "setStatus") {
      if (!checkAdminPassword(body.adminPassword)) {
        return { statusCode: 401, body: { error: "Incorrect admin password." } };
      }
      if (!body.contractorId || !body.status) {
        return { statusCode: 400, body: { error: "contractorId and status are required." } };
      }
      if (body.status !== "approved" && body.status !== "rejected") {
        return { statusCode: 400, body: { error: "status must be 'approved' or 'rejected'." } };
      }
      const contractor = await updateContractor(body.contractorId, { status: body.status });
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "getWithReviews") {
      if (!body.contractorId) {
        return { statusCode: 400, body: { error: "contractorId is required." } };
      }
      const contractor = await getContractorWithReviews(body.contractorId);
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
