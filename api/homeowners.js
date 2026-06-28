/**
 * api/homeowners.js
 * ---------------------------------------------------------------------------
 * Backend endpoint for homeowner accounts: signing in (by matching email to
 * an existing row) or signing up (creating a new one), updating profile
 * fields, and toggling favorite contractors.
 *
 * Routes (distinguished by `action` in the request body):
 *   POST /api/homeowners  { action: "authenticate", name, email, zip }
 *   POST /api/homeowners  { action: "update", homeownerId, updates: {...} }
 *   POST /api/homeowners  { action: "toggleFavorite", homeownerId, contractorId }
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
    favoriteContractorIds: row.favorite_contractor_ids
      ? row.favorite_contractor_ids.split(",").filter(Boolean)
      : [],
  };
}
 
/**
 * Signs in to an existing homeowner account if the email matches one already
 * in the database, otherwise creates a new one. This mirrors the original
 * in-memory behavior from the prototype: email is the unique identifier,
 * there's no password in this version.
 */
async function authenticateHomeowner(name, email, zip) {
  const normalizedEmail = email.trim().toLowerCase();
 
  const { data: existing, error: lookupError } = await supabase
    .from("homeowners")
    .select("*")
    .ilike("email", normalizedEmail)
    .maybeSingle();
 
  if (lookupError) throw new Error("Could not look up homeowner: " + lookupError.message);
 
  if (existing) {
    return rowToHomeowner(existing);
  }
 
  const { data: created, error: createError } = await supabase
    .from("homeowners")
    .insert({
      name: name.trim(),
      email: email.trim(),
      zip: zip.trim(),
      favorite_contractor_ids: "",
    })
    .select()
    .single();
 
  if (createError) throw new Error("Could not create homeowner: " + createError.message);
  return rowToHomeowner(created);
}
 
async function updateHomeowner(homeownerId, updates) {
  const row = {};
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.zip !== undefined) row.zip = updates.zip;
 
  const { data, error } = await supabase.from("homeowners").update(row).eq("id", homeownerId).select().single();
  if (error) throw new Error("Could not update homeowner: " + error.message);
  return rowToHomeowner(data);
}
 
async function toggleFavorite(homeownerId, contractorId) {
  const { data: current, error: fetchError } = await supabase
    .from("homeowners")
    .select("favorite_contractor_ids")
    .eq("id", homeownerId)
    .single();
  if (fetchError) throw new Error("Could not find homeowner: " + fetchError.message);
 
  const currentIds = current.favorite_contractor_ids
    ? current.favorite_contractor_ids.split(",").filter(Boolean)
    : [];
  const isFavorite = currentIds.includes(contractorId);
  const nextIds = isFavorite ? currentIds.filter((id) => id !== contractorId) : [...currentIds, contractorId];
 
  const { data, error } = await supabase
    .from("homeowners")
    .update({ favorite_contractor_ids: nextIds.join(",") })
    .eq("id", homeownerId)
    .select()
    .single();
  if (error) throw new Error("Could not update favorites: " + error.message);
  return rowToHomeowner(data);
}
 
async function handleHomeownersRequest(body) {
  const { action } = body || {};
 
  try {
    if (action === "authenticate") {
      if (!body.name || !body.email || !body.zip) {
        return { statusCode: 400, body: { error: "name, email, and zip are required." } };
      }
      const homeowner = await authenticateHomeowner(body.name, body.email, body.zip);
      return { statusCode: 200, body: { homeowner } };
    }
 
    if (action === "update") {
      if (!body.homeownerId) {
        return { statusCode: 400, body: { error: "homeownerId is required." } };
      }
      const homeowner = await updateHomeowner(body.homeownerId, body.updates || {});
      return { statusCode: 200, body: { homeowner } };
    }
 
    if (action === "toggleFavorite") {
      if (!body.homeownerId || !body.contractorId) {
        return { statusCode: 400, body: { error: "homeownerId and contractorId are required." } };
      }
      const homeowner = await toggleFavorite(body.homeownerId, body.contractorId);
      return { statusCode: 200, body: { homeowner } };
    }
 
    return { statusCode: 400, body: { error: `Unknown action: ${action}` } };
  } catch (err) {
    console.error("homeowners handler error:", err);
    return { statusCode: 500, body: { error: err.message } };
  }
}
 
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const result = await handleHomeownersRequest(req.body);
  res.status(result.statusCode).json(result.body);
};
 
module.exports.handleHomeownersRequest = handleHomeownersRequest;
module.exports.rowToHomeowner = rowToHomeowner;
