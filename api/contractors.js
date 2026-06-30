/**
 * api/contractors.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for everything contractor-related. Real auth: a
 * contractor signs up against Supabase Auth directly from the frontend
 * (public anon key, see shared.js), which issues a session token. That
 * token is verified server-side here before any profile-editing action
 * runs -- "create my profile," "update my profile," and "upload my logo"
 * are all scoped to whoever the token proves you are, never to a
 * contractorId the client simply sends in the request body.
 *
 * Public/admin-only routes (list, listPending, setStatus) are unchanged --
 * those were never about "my own data" to begin with.
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/contractors  { action: "list" }                                   <- public, no auth needed
 *   POST /api/contractors  { action: "getMine" }                                <- auth required
 *   POST /api/contractors  { action: "create", contractor: {...} }              <- auth required, creates MY profile
 *   POST /api/contractors  { action: "update", updates: {...} }                 <- auth required, updates MY profile
 *   POST /api/contractors  { action: "uploadLogo", fileBase64, fileName }       <- auth required, for MY profile
 *   POST /api/contractors  { action: "listPending", adminPassword }             <- admin only
 *   POST /api/contractors  { action: "setStatus", adminPassword, contractorId, status }  <- admin only
 *   POST /api/contractors  { action: "getWithReviews", contractorId }           <- public, no auth needed
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 *   ADMIN_PASSWORD
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

async function getAuthedUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

function rowToContractor(row, reviews) {
  return {
    id: row.id,
    createdAt: row.created_at,
    businessName: row.business_name,
    trade: row.trade,
    yearsInBusiness: row.years_in_business,
    bio: row.bio,
    licenseInfo: row.license_info,
    email: row.email,
    serviceArea: {
      mode: row.service_area_mode,
      zipCodes: row.service_area_zips ? row.service_area_zips.split(",").filter(Boolean) : [],
    },
    status: row.status,
    thumbsUp: row.thumbs_up_count || 0,
    thumbsDown: row.thumbs_down || 0,
    logoUrl: row.logo_url || null,
    completedJobs: [],
    reviews: reviews || [],
  };
}

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
    row.service_area_zips = Array.isArray(zips) ? zips.join(",") : "";
  }
  if (contractor.status !== undefined) row.status = contractor.status;
  if (contractor.logoUrl !== undefined) row.logo_url = contractor.logoUrl;
  return row;
}

async function listContractors() {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list contractors: " + error.message);
  return data.map((row) => rowToContractor(row));
}

async function listPendingContractors() {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list pending contractors: " + error.message);
  return data.map((row) => rowToContractor(row));
}

function checkAdminPassword(password) {
  const realPassword = process.env.ADMIN_PASSWORD;
  if (!realPassword) return false;
  return password === realPassword;
}

async function findContractorByAuthId(authUserId) {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error) throw new Error("Could not look up contractor profile: " + error.message);
  return data ? rowToContractor(data) : null;
}

async function createContractorForAuthUser(authUser, contractor) {
  const existing = await findContractorByAuthId(authUser.id);
  if (existing) {
    throw new Error("You already have a contractor profile. Use 'update' to edit it.");
  }

  const row = {
    ...contractorToRow(contractor),
    auth_user_id: authUser.id,
    email: authUser.email,
    status: "pending",
  };
  const { data, error } = await supabase.from("contractors").insert(row).select().single();
  if (error) throw new Error("Could not create contractor profile: " + error.message);
  return rowToContractor(data);
}

async function updateMyContractor(authUserId, updates) {
  const row = contractorToRow(updates);
  const { data, error } = await supabase
    .from("contractors")
    .update(row)
    .eq("auth_user_id", authUserId)
    .select()
    .single();
  if (error) throw new Error("Could not update contractor: " + error.message);
  return rowToContractor(data);
}

async function setContractorStatus(contractorId, status) {
  const { data, error } = await supabase
    .from("contractors")
    .update({ status })
    .eq("id", toId(contractorId))
    .select()
    .single();
  if (error) throw new Error("Could not update contractor status: " + error.message);
  return rowToContractor(data);
}

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

async function uploadLogoForAuthUser(authUserId, fileBase64, fileName, contentType) {
  const { data: existing, error: lookupError } = await supabase
    .from("contractors")
    .select("id")
    .eq("auth_user_id", authUserId)
    .single();
  if (lookupError || !existing) throw new Error("You don't have a contractor profile yet.");

  const buffer = Buffer.from(fileBase64, "base64");
  const path = `${existing.id}/${Date.now()}-${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("contractor-logos")
    .upload(path, buffer, { contentType, upsert: true });
  if (uploadError) throw new Error("Could not upload logo: " + uploadError.message);

  const { data: publicUrlData } = supabase.storage.from("contractor-logos").getPublicUrl(path);
  const logoUrl = publicUrlData.publicUrl;

  const { data, error } = await supabase
    .from("contractors")
    .update({ logo_url: logoUrl })
    .eq("id", existing.id)
    .select()
    .single();
  if (error) throw new Error("Could not save logo URL: " + error.message);

  return rowToContractor(data);
}

async function handleContractorsRequest(body, req) {
  const { action } = body || {};

  try {
    if (action === "list") {
      const contractors = await listContractors();
      return { statusCode: 200, body: { contractors } };
    }

    if (action === "getWithReviews") {
      if (!body.contractorId) {
        return { statusCode: 400, body: { error: "contractorId is required." } };
      }
      const contractor = await getContractorWithReviews(body.contractorId);
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
      const contractor = await setContractorStatus(body.contractorId, body.status);
      return { statusCode: 200, body: { contractor } };
    }

    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return { statusCode: 401, body: { error: "You must be signed in." } };
    }

    if (action === "getMine") {
      const contractor = await findContractorByAuthId(authUser.id);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "create") {
      if (!body.contractor || !body.contractor.businessName) {
        return { statusCode: 400, body: { error: "contractor.businessName is required." } };
      }
      const contractor = await createContractorForAuthUser(authUser, body.contractor);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "update") {
      const contractor = await updateMyContractor(authUser.id, body.updates || {});
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "uploadLogo") {
      if (!body.fileBase64 || !body.fileName) {
        return { statusCode: 400, body: { error: "fileBase64 and fileName are required." } };
      }
      const contractor = await uploadLogoForAuthUser(
        authUser.id,
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
  const result = await handleContractorsRequest(req.body, req);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleContractorsRequest = handleContractorsRequest;
module.exports.rowToContractor = rowToContractor;
module.exports.contractorToRow = contractorToRow;
