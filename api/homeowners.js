/**
 * api/homeowners.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for homeowner accounts. Real auth: homeowners sign up
 * and sign in directly against Supabase Auth from the frontend (using the
 * public anon key -- see shared.js), which issues a session token. That
 * token is sent on every request as an Authorization header, and THIS file
 * verifies it server-side before trusting "who" is making the request.
 *
 * This replaces the old approach where the frontend simply sent a
 * homeownerId in the request body and the backend trusted it blindly.
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/homeowners  { action: "afterSignUp", name, zip }
 *   POST /api/homeowners  { action: "getCurrent" }
 *   POST /api/homeowners  { action: "update", updates: {...} }
 *   POST /api/homeowners  { action: "toggleFavorite", contractorId }
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

function rowToHomeowner(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    zip: row.zip,
    phone: row.phone || null,
    favoriteContractorIds: row.favorite_contractor_ids
      ? row.favorite_contractor_ids.split(",").filter(Boolean)
      : [],
  };
}

/**
 * Verifies the Authorization header against Supabase Auth and returns the
 * authenticated user's id (a uuid) and email -- or null if there's no
 * valid session. supabase.auth.getUser() cryptographically verifies the
 * token was genuinely issued by Supabase Auth for this project. A forged
 * or expired token fails here.
 */
async function getAuthedUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

async function findHomeownerByAuthId(authUserId) {
  const { data, error } = await supabase
    .from("homeowners")
    .select("*")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error) throw new Error("Could not look up homeowner: " + error.message);
  return data ? rowToHomeowner(data) : null;
}

async function createHomeownerForAuthUser(authUser, name, zip, phone) {
  const { data, error } = await supabase
    .from("homeowners")
    .insert({
      auth_user_id: authUser.id,
      name: name.trim(),
      email: authUser.email,
      zip: zip.trim(),
      phone: phone || null,
      favorite_contractor_ids: "",
    })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error("An account already exists for this email.");
    }
    throw new Error("Could not create homeowner profile: " + error.message);
  }
  return rowToHomeowner(data);
}

async function updateHomeowner(authUserId, updates) {
  const row = {};
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.zip !== undefined) row.zip = updates.zip;
  if (updates.phone !== undefined) row.phone = updates.phone || null;

  const { data, error } = await supabase
    .from("homeowners")
    .update(row)
    .eq("auth_user_id", authUserId)
    .select()
    .single();
  if (error) throw new Error("Could not update homeowner: " + error.message);
  return rowToHomeowner(data);
}

async function toggleFavorite(authUserId, contractorId) {
  const { data: current, error: fetchError } = await supabase
    .from("homeowners")
    .select("favorite_contractor_ids")
    .eq("auth_user_id", authUserId)
    .single();
  if (fetchError) throw new Error("Could not find homeowner: " + fetchError.message);

  const currentIds = current.favorite_contractor_ids
    ? current.favorite_contractor_ids.split(",").filter(Boolean)
    : [];
  const contractorIdStr = String(contractorId);
  const isFavorite = currentIds.includes(contractorIdStr);
  const nextIds = isFavorite ? currentIds.filter((id) => id !== contractorIdStr) : [...currentIds, contractorIdStr];

  const { data, error } = await supabase
    .from("homeowners")
    .update({ favorite_contractor_ids: nextIds.join(",") })
    .eq("auth_user_id", authUserId)
    .select()
    .single();
  if (error) throw new Error("Could not update favorites: " + error.message);
  return rowToHomeowner(data);
}

async function handleHomeownersRequest(body, req) {
  const { action } = body || {};

  try {
    const authUser = await getAuthedUser(req);
    if (!authUser) {
      return { statusCode: 401, body: { error: "You must be signed in." } };
    }

    if (action === "afterSignUp") {
      if (!body.name || !body.zip) {
        return { statusCode: 400, body: { error: "name and zip are required." } };
      }
      const existing = await findHomeownerByAuthId(authUser.id);
      if (existing) {
        return { statusCode: 200, body: { homeowner: existing } };
      }
      const homeowner = await createHomeownerForAuthUser(authUser, body.name, body.zip, body.phone || null);
      return { statusCode: 200, body: { homeowner } };
    }

    if (action === "getCurrent") {
      const homeowner = await findHomeownerByAuthId(authUser.id);
      return { statusCode: 200, body: { homeowner } };
    }

    if (action === "update") {
      const homeowner = await updateHomeowner(authUser.id, body.updates || {});
      return { statusCode: 200, body: { homeowner } };
    }

    if (action === "toggleFavorite") {
      if (!body.contractorId) {
        return { statusCode: 400, body: { error: "contractorId is required." } };
      }
      const homeowner = await toggleFavorite(authUser.id, body.contractorId);
      return { statusCode: 200, body: { homeowner } };
    }

    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("homeowners handler error:", err);
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
  const result = await handleHomeownersRequest(req.body, req);
  res.status(result.statusCode).json(result.body);
};

module.exports.handleHomeownersRequest = handleHomeownersRequest;
module.exports.rowToHomeowner = rowToHomeowner;
