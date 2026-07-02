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
 *   POST /api/contractors  { action: "uploadPortfolioPhoto", fileBase64, fileName, caption? }  <- auth required
 *   POST /api/contractors  { action: "listPortfolioPhotos", contractorId }      <- public, no auth needed
 *   POST /api/contractors  { action: "deletePortfolioPhoto", photoId }          <- auth required
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

function generateSlug(businessName) {
  return businessName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function rowToContractor(row, reviews) {
  return {
    id: row.id,
    slug: row.slug || null,
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
    isSuspended: !!row.is_suspended,
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
    .eq("is_suspended", false)
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

// In-memory rate limiter for admin password attempts.
// Vercel serverless functions are stateless across requests, so this resets
// on cold starts -- but it still catches rapid brute-force attempts within
// the same function instance's lifetime, which covers the main attack vector.
const adminAttempts = new Map(); // ip -> { count, resetAt }
const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS = 60 * 60 * 1000; // 1 hour

function checkAdminPassword(password, req) {
  const ip = (req && (req.headers["x-forwarded-for"] || req.socket?.remoteAddress)) || "unknown";
  const now = Date.now();
  const record = adminAttempts.get(ip);

  // Check if currently locked out
  if (record && record.count >= MAX_ADMIN_ATTEMPTS && now < record.resetAt) {
    const minutesLeft = Math.ceil((record.resetAt - now) / 60000);
    throw new Error(`Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`);
  }

  // Reset if lockout period has expired
  if (record && now >= record.resetAt) {
    adminAttempts.delete(ip);
  }

  const realPassword = process.env.ADMIN_PASSWORD;
  if (!realPassword) return false;

  if (password === realPassword) {
    adminAttempts.delete(ip); // clear on success
    return true;
  }

  // Wrong password -- increment attempt count
  const current = adminAttempts.get(ip) || { count: 0, resetAt: now + ADMIN_LOCKOUT_MS };
  adminAttempts.set(ip, { count: current.count + 1, resetAt: current.resetAt });
  return false;
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

  // Generate a unique slug from the business name
  const baseSlug = generateSlug(contractor.businessName);
  let slug = baseSlug;
  let attempt = 0;
  while (true) {
    const { data: conflict } = await supabase
      .from("contractors").select("id").eq("slug", slug).maybeSingle();
    if (!conflict) break;
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  const row = {
    ...contractorToRow(contractor),
    auth_user_id: authUser.id,
    email: authUser.email,
    status: "pending",
    slug,
  };
  const { data, error } = await supabase.from("contractors").insert(row).select().single();
  if (error) throw new Error("Could not create contractor profile: " + error.message);
  return rowToContractor(data);
}

async function updateMyContractor(authUserId, updates) {
  const row = contractorToRow(updates);
  // If business name changed, regenerate slug
  if (updates.businessName) {
    const baseSlug = generateSlug(updates.businessName);
    let slug = baseSlug;
    let attempt = 0;
    while (true) {
      const { data: conflict } = await supabase
        .from("contractors").select("id").eq("slug", slug).maybeSingle();
      if (!conflict) break;
      attempt++;
      slug = `${baseSlug}-${attempt}`;
    }
    row.slug = slug;
  }
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

const MAX_PORTFOLIO_PHOTOS = 20;

/**
 * Uploads a portfolio photo to Supabase Storage and creates a row in
 * portfolio_photos. Scoped to the current auth user's contractor profile --
 * a contractor can only add photos to their own portfolio.
 */
async function uploadPortfolioPhoto(authUserId, fileBase64, fileName, contentType, caption, thumbnailBase64) {
  const { data: contractor, error: lookupError } = await supabase
    .from("contractors")
    .select("id")
    .eq("auth_user_id", authUserId)
    .single();
  if (lookupError || !contractor) throw new Error("You don't have a contractor profile yet.");

  const { count, error: countError } = await supabase
    .from("portfolio_photos")
    .select("id", { count: "exact", head: true })
    .eq("contractor_id", contractor.id);
  if (countError) throw new Error("Could not check photo count: " + countError.message);
  if (count >= MAX_PORTFOLIO_PHOTOS) {
    throw new Error(`Portfolio is full — maximum ${MAX_PORTFOLIO_PHOTOS} photos allowed. Delete some to add more.`);
  }

  const ts = Date.now();
  const buffer = Buffer.from(fileBase64, "base64");
  const path = `${contractor.id}/${ts}-${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("portfolio-photos")
    .upload(path, buffer, { contentType, upsert: false });
  if (uploadError) throw new Error("Could not upload photo: " + uploadError.message);

  const { data: urlData } = supabase.storage.from("portfolio-photos").getPublicUrl(path);

  // Upload thumbnail if provided
  let thumbnailUrl = null;
  if (thumbnailBase64) {
    const thumbBuffer = Buffer.from(thumbnailBase64, "base64");
    const thumbPath = `${contractor.id}/${ts}-thumb-${fileName}`;
    const { error: thumbError } = await supabase.storage
      .from("portfolio-photos")
      .upload(thumbPath, thumbBuffer, { contentType: "image/jpeg", upsert: false });
    if (!thumbError) {
      const { data: thumbUrlData } = supabase.storage.from("portfolio-photos").getPublicUrl(thumbPath);
      thumbnailUrl = thumbUrlData.publicUrl;
    }
  }

  const { data, error } = await supabase
    .from("portfolio_photos")
    .insert({
      contractor_id: contractor.id,
      storage_path: path,
      public_url: urlData.publicUrl,
      thumbnail_url: thumbnailUrl,
      caption: caption || null,
    })
    .select()
    .single();
  if (error) throw new Error("Could not save photo record: " + error.message);

  return rowToPhoto(data);
}

function rowToPhoto(row) {
  return {
    id: row.id,
    contractorId: row.contractor_id,
    publicUrl: row.public_url,
    thumbnailUrl: row.thumbnail_url || row.public_url, // fall back to full if no thumb
    caption: row.caption || null,
    createdAt: row.created_at,
  };
}

async function listPortfolioPhotos(contractorId) {
  const { data, error } = await supabase
    .from("portfolio_photos")
    .select("*")
    .eq("contractor_id", toId(contractorId))
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list portfolio photos: " + error.message);
  return data.map(rowToPhoto);
}

/**
 * Deletes a portfolio photo -- verifies the photo belongs to the current
 * auth user's contractor profile before deleting anything.
 */
async function deletePortfolioPhoto(authUserId, photoId) {
  const { data: contractor, error: lookupError } = await supabase
    .from("contractors")
    .select("id")
    .eq("auth_user_id", authUserId)
    .single();
  if (lookupError || !contractor) throw new Error("Contractor profile not found.");

  const { data: photo, error: photoError } = await supabase
    .from("portfolio_photos")
    .select("id, contractor_id, storage_path")
    .eq("id", toId(photoId))
    .maybeSingle();
  if (photoError) throw new Error("Could not find photo: " + photoError.message);
  if (!photo) throw new Error("Photo not found.");
  if (photo.contractor_id !== contractor.id) throw new Error("You can only delete your own photos.");

  await supabase.storage.from("portfolio-photos").remove([photo.storage_path]);

  const { error: deleteError } = await supabase
    .from("portfolio_photos")
    .delete()
    .eq("id", toId(photoId));
  if (deleteError) throw new Error("Could not delete photo record: " + deleteError.message);

  return { deleted: true, photoId };
}

async function updatePortfolioPhotoCaption(authUserId, photoId, caption) {
  const { data: contractor, error: lookupError } = await supabase
    .from("contractors")
    .select("id")
    .eq("auth_user_id", authUserId)
    .single();
  if (lookupError || !contractor) throw new Error("Contractor profile not found.");

  const { data: photo, error: photoError } = await supabase
    .from("portfolio_photos")
    .select("id, contractor_id")
    .eq("id", toId(photoId))
    .maybeSingle();
  if (photoError) throw new Error("Could not find photo: " + photoError.message);
  if (!photo) throw new Error("Photo not found.");
  if (photo.contractor_id !== contractor.id) throw new Error("You can only edit your own photos.");

  const { data, error } = await supabase
    .from("portfolio_photos")
    .update({ caption: caption || null })
    .eq("id", toId(photoId))
    .select()
    .single();
  if (error) throw new Error("Could not update caption: " + error.message);
  return rowToPhoto(data);
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
      // Accepts either contractorId (numeric) or slug (string)
      const { contractorId, slug } = body;
      if (!contractorId && !slug) {
        return { statusCode: 400, body: { error: "contractorId or slug is required." } };
      }
      let lookupId = contractorId;
      if (!lookupId && slug) {
        // Look up id by slug
        const { data: row, error: slugError } = await supabase
          .from("contractors").select("id").eq("slug", slug).maybeSingle();
        if (slugError || !row) return { statusCode: 404, body: { error: "Contractor not found." } };
        lookupId = row.id;
      }
      const contractor = await getContractorWithReviews(lookupId);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "listPortfolioPhotos") {
      const { contractorId, slug } = body;
      if (!contractorId && !slug) {
        return { statusCode: 400, body: { error: "contractorId or slug is required." } };
      }
      let lookupId = contractorId;
      if (!lookupId && slug) {
        const { data: row } = await supabase.from("contractors").select("id").eq("slug", slug).maybeSingle();
        if (!row) return { statusCode: 404, body: { error: "Contractor not found." } };
        lookupId = row.id;
      }
      const photos = await listPortfolioPhotos(lookupId);
      return { statusCode: 200, body: { photos } };
    }

    if (action === "listPending") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const contractors = await listPendingContractors();
      return { statusCode: 200, body: { contractors } };
    }

    if (action === "setStatus") {
      try {
        if (!checkAdminPassword(body.adminPassword, req)) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
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

    if (action === "uploadPortfolioPhoto") {
      if (!body.fileBase64 || !body.fileName) {
        return { statusCode: 400, body: { error: "fileBase64 and fileName are required." } };
      }
      const photo = await uploadPortfolioPhoto(
        authUser.id,
        body.fileBase64,
        body.fileName,
        body.contentType || "image/jpeg",
        body.caption || null,
        body.thumbnailBase64 || null
      );
      return { statusCode: 200, body: { photo } };
    }

    if (action === "deletePortfolioPhoto") {
      if (!body.photoId) {
        return { statusCode: 400, body: { error: "photoId is required." } };
      }
      const result = await deletePortfolioPhoto(authUser.id, body.photoId);
      return { statusCode: 200, body: result };
    }

    if (action === "updatePhotoCaption") {
      if (!body.photoId) {
        return { statusCode: 400, body: { error: "photoId is required." } };
      }
      const photo = await updatePortfolioPhotoCaption(authUser.id, body.photoId, body.caption || null);
      return { statusCode: 200, body: { photo } };
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

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "4.5mb",
    },
  },
};

module.exports.handleContractorsRequest = handleContractorsRequest;
module.exports.rowToContractor = rowToContractor;
module.exports.contractorToRow = contractorToRow;
