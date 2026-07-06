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
 *   POST /api/contractors  { action: "foundingStatus" }                          <- public, no auth needed
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

const { emailContractorApproved } = require("./email");
const {
  supabase,
  toId,
  getAuthedUser,
  setCors,
  checkAdminPassword,
  rateLimit,
  clientIp,
  validateImageUpload,
} = require("./_shared");

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
    isFoundingMember: !!row.is_founding_member,
    foundingFreeJobsUsed: row.founding_free_jobs_used || 0,
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
  // NOTE: `status` is intentionally NOT mapped here. It is an admin-only gate
  // written directly by setContractorStatus / the create path. Mapping it here
  // previously let a contractor self-approve via the "update" action (C-1).
  if (contractor.logoUrl !== undefined) row.logo_url = contractor.logoUrl;
  return row;
}

async function listContractors() {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .in("status", ["approved", "pending_review"])
    .eq("is_suspended", false)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list contractors: " + error.message);
  if (data.length === 0) return [];

  // Fetch all reviews for listed contractors in one query
  const contractorIds = data.map((c) => c.id);
  const { data: reviewRows } = await supabase
    .from("reviews")
    .select("id, contractor_id, rating, text_review, created_at")
    .in("contractor_id", contractorIds)
    .order("created_at", { ascending: false });

  // Group reviews by contractor
  const reviewsByContractor = new Map();
  (reviewRows || []).forEach((r) => {
    if (!reviewsByContractor.has(r.contractor_id)) reviewsByContractor.set(r.contractor_id, []);
    reviewsByContractor.get(r.contractor_id).push({
      id: r.id,
      rating: r.rating,
      text: r.text_review || "",
      createdAt: r.created_at,
    });
  });

  return data.map((row) => rowToContractor(row, reviewsByContractor.get(row.id) || []));
}

async function listPendingContractors() {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .in("status", ["pending", "pending_review"])
    .order("created_at", { ascending: false });
  if (error) throw new Error("Could not list pending contractors: " + error.message);
  return data.map((row) => rowToContractor(row));
}

// Admin auth (constant-time compare + durable rate limit) now lives in
// ./_shared as checkAdminPassword. It is async, so call sites use `await`.

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

// A contractor may only edit these fields on their own profile. `status`,
// `is_suspended`, `slug`, `email`, `auth_user_id`, etc. are deliberately absent
// so they can never be set through the self-service "update" action.
const CONTRACTOR_EDITABLE_FIELDS = [
  "businessName",
  "trade",
  "yearsInBusiness",
  "bio",
  "licenseInfo",
  "serviceArea",
  "logoUrl",
];

// Fields that, if edited AFTER a contractor is already approved, put the
// listing back into the admin queue for a quick re-review -- these are the
// free-text fields most worth a second look (business name, bio, license
// claims). Portfolio photos and service area don't trigger this.
const SENSITIVE_EDIT_FIELDS = ["businessName", "bio", "licenseInfo"];

async function updateMyContractor(authUserId, updates) {
  const safeUpdates = {};
  for (const key of CONTRACTOR_EDITABLE_FIELDS) {
    if (updates[key] !== undefined) safeUpdates[key] = updates[key];
  }
  const row = contractorToRow(safeUpdates);

  const touchesSensitiveField = SENSITIVE_EDIT_FIELDS.some((key) => updates[key] !== undefined);
  if (touchesSensitiveField) {
    const { data: existing } = await supabase
      .from("contractors").select("status").eq("auth_user_id", authUserId).maybeSingle();
    // Only a currently-approved listing gets bumped back to re-review --
    // a contractor still in the normal "pending" (first-time) queue, or
    // already in "pending_review", just stays where they are.
    if (existing?.status === "approved") {
      row.status = "pending_review";
    }
  }

  // Deliberately do NOT regenerate slug on business name change --
  // the slug is set once at creation and never changes so existing
  // shared links and QR codes keep working.
  const { data, error } = await supabase
    .from("contractors")
    .update(row)
    .eq("auth_user_id", authUserId)
    .select()
    .single();
  if (error) throw new Error("Could not update contractor: " + error.message);
  return rowToContractor(data);
}

// The Founding 50: the first 50 contractors to reach "approved" become
// founding members (permanent badge + zero platform fee on their first job).
const FOUNDING_MEMBER_CAP = 50;
const FOUNDING_FREE_JOBS = 1;

async function setContractorStatus(contractorId, status) {
  // Fetch previous status + founding flag so we can detect first-time approval
  const { data: existing } = await supabase
    .from("contractors").select("status, is_founding_member").eq("id", toId(contractorId)).maybeSingle();
  const previousStatus = existing?.status;

  const updates = { status };

  // On FIRST approval only, if there's still room under the cap, make them a
  // founding member. Guarded so re-approvals (e.g. after a re-review) never
  // re-trigger it, and so we never exceed 50.
  if (status === "approved" && previousStatus !== "approved" && !existing?.is_founding_member) {
    const { count } = await supabase
      .from("contractors")
      .select("id", { count: "exact", head: true })
      .eq("is_founding_member", true);
    if ((count || 0) < FOUNDING_MEMBER_CAP) {
      updates.is_founding_member = true;
    }
  }

  const { data, error } = await supabase
    .from("contractors")
    .update(updates)
    .eq("id", toId(contractorId))
    .select()
    .single();
  if (error) throw new Error("Could not update contractor status: " + error.message);
  const contractor = rowToContractor(data);
  contractor._previousStatus = previousStatus; // Pass through for email logic
  return contractor;
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
  return addPortfolioPhotoForContractor(contractor.id, fileBase64, fileName, contentType, caption, thumbnailBase64);
}

// Shared by the contractor self-service path and the admin path. Adds a photo
// to the given contractor's portfolio. The CALLER is responsible for
// authorization (auth user lookup, or admin password check).
async function addPortfolioPhotoForContractor(contractorId, fileBase64, fileName, contentType, caption, thumbnailBase64) {
  const contractor = { id: toId(contractorId) };

  const { count, error: countError } = await supabase
    .from("portfolio_photos")
    .select("id", { count: "exact", head: true })
    .eq("contractor_id", contractor.id);
  if (countError) throw new Error("Could not check photo count: " + countError.message);
  if (count >= MAX_PORTFOLIO_PHOTOS) {
    throw new Error(`Portfolio is full — maximum ${MAX_PORTFOLIO_PHOTOS} photos allowed. Delete some to add more.`);
  }

  // Verify the upload is a real image (PNG/JPEG/WebP) by its bytes -- not the
  // client-declared content-type -- and use a sanitized filename. Rejects SVG
  // and content-type confusion attacks.
  const { buffer, contentType: safeType, safeName } = validateImageUpload(fileBase64, fileName);
  const ts = Date.now();
  const path = `${contractor.id}/${ts}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("portfolio-photos")
    .upload(path, buffer, { contentType: safeType, upsert: false });
  if (uploadError) throw new Error("Could not upload photo: " + uploadError.message);

  const { data: urlData } = supabase.storage.from("portfolio-photos").getPublicUrl(path);

  // Upload thumbnail if provided (also validated; skipped if not a valid image)
  let thumbnailUrl = null;
  if (thumbnailBase64) {
    try {
      const { buffer: thumbBuffer, contentType: thumbType } = validateImageUpload(
        thumbnailBase64,
        `thumb-${safeName}`
      );
      const thumbPath = `${contractor.id}/${ts}-thumb-${safeName}`;
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

  // Don't expose suspended or unapproved contractors on public profiles.
  // pending_review is included here too -- it's an already-approved listing
  // with a sensitive-field edit awaiting a quick admin look, and it stays
  // live in the meantime (see updateMyContractor).
  if ((row.status !== "approved" && row.status !== "pending_review") || row.is_suspended) {
    throw new Error("This contractor profile is not publicly available.");
  }

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
  return saveLogoForContractor(existing.id, fileBase64, fileName);
}

// Shared by the contractor self-service path and the admin path. The CALLER is
// responsible for authorization.
async function saveLogoForContractor(contractorId, fileBase64, fileName) {
  const existing = { id: toId(contractorId) };
  const { buffer, contentType: safeType, safeName } = validateImageUpload(fileBase64, fileName);
  const path = `${existing.id}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("contractor-logos")
    .upload(path, buffer, { contentType: safeType, upsert: true });
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

// ---------------------------------------------------------------------------
// Admin-side edits. These let an admin (authenticated by the admin password,
// checked at the call site) edit a contractor's profile and manage their
// photos on their behalf -- for contractors who can't or won't do it
// themselves. Each is keyed by contractorId, not auth_user_id.
// ---------------------------------------------------------------------------
async function adminUpdateContractor(contractorId, updates) {
  const safeUpdates = {};
  for (const key of CONTRACTOR_EDITABLE_FIELDS) {
    if (updates[key] !== undefined) safeUpdates[key] = updates[key];
  }
  const row = contractorToRow(safeUpdates);
  if (Object.keys(row).length === 0) throw new Error("No editable fields provided.");
  const { data, error } = await supabase
    .from("contractors")
    .update(row)
    .eq("id", toId(contractorId))
    .select()
    .single();
  if (error) throw new Error("Could not update contractor: " + error.message);
  return rowToContractor(data);
}

async function adminUploadLogo(contractorId, fileBase64, fileName) {
  const { data: existing } = await supabase
    .from("contractors").select("id").eq("id", toId(contractorId)).maybeSingle();
  if (!existing) throw new Error("Contractor not found.");
  return saveLogoForContractor(existing.id, fileBase64, fileName);
}

async function adminUploadPortfolioPhoto(contractorId, fileBase64, fileName, contentType, caption, thumbnailBase64) {
  const { data: existing } = await supabase
    .from("contractors").select("id").eq("id", toId(contractorId)).maybeSingle();
  if (!existing) throw new Error("Contractor not found.");
  return addPortfolioPhotoForContractor(existing.id, fileBase64, fileName, contentType, caption, thumbnailBase64);
}

async function adminDeletePortfolioPhoto(photoId) {
  const { data: photo, error: photoError } = await supabase
    .from("portfolio_photos").select("id, storage_path").eq("id", toId(photoId)).maybeSingle();
  if (photoError) throw new Error("Could not find photo: " + photoError.message);
  if (!photo) throw new Error("Photo not found.");
  await supabase.storage.from("portfolio-photos").remove([photo.storage_path]);
  const { error: deleteError } = await supabase
    .from("portfolio_photos").delete().eq("id", toId(photoId));
  if (deleteError) throw new Error("Could not delete photo record: " + deleteError.message);
  return { deleted: true, photoId };
}

async function handleContractorsRequest(body, req) {
  const { action } = body || {};

  try {
    if (action === "list") {
      const contractors = await listContractors();
      return { statusCode: 200, body: { contractors } };
    }

    if (action === "foundingStatus") {
      // Public: how many "Founding 50" spots remain. Drives the landing-page
      // offer banner. Counts is_founding_member=true -- the SAME source
      // setContractorStatus uses to cap the perk -- so the banner and the
      // actual benefit switch off together the moment the 50th founder is
      // approved. No auth: it exposes only an aggregate count.
      const { count } = await supabase
        .from("contractors")
        .select("id", { count: "exact", head: true })
        .eq("is_founding_member", true);
      const founderCount = count || 0;
      return {
        statusCode: 200,
        body: {
          founderCount,
          spotsLeft: Math.max(0, FOUNDING_MEMBER_CAP - founderCount),
          cap: FOUNDING_MEMBER_CAP,
          freeJobs: FOUNDING_FREE_JOBS,
        },
      };
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

    if (action === "listApproved") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const { data, error } = await supabase
        .from("contractors")
        .select("*")
        .eq("status", "approved")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { statusCode: 200, body: { contractors: (data || []).map((r) => rowToContractor(r)) } };
    }

    if (action === "listArchived") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      const { data, error } = await supabase
        .from("contractors")
        .select("*")
        .eq("status", "archived")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { statusCode: 200, body: { contractors: (data || []).map((r) => rowToContractor(r)) } };
    }

    if (action === "listPending") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
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
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      if (!body.contractorId || !body.status) {
        return { statusCode: 400, body: { error: "contractorId and status are required." } };
      }
      if (body.status !== "approved" && body.status !== "rejected" && body.status !== "archived") {
        return { statusCode: 400, body: { error: "status must be 'approved', 'rejected', or 'archived'." } };
      }
      const contractor = await setContractorStatus(body.contractorId, body.status);
      // Email contractor on first approval only (not re-approval)
      if (body.status === "approved" && contractor._previousStatus !== "approved" && contractor.email) {
        emailContractorApproved({
          contractorEmail: contractor.email,
          contractorName: contractor.businessName,
        }).catch(() => {});
      }
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "adminUpdateContractor") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      if (!body.contractorId || !body.updates) {
        return { statusCode: 400, body: { error: "contractorId and updates are required." } };
      }
      if (body.updates.businessName && body.updates.businessName.length > 100) {
        return { statusCode: 400, body: { error: "Business name must be 100 characters or less." } };
      }
      if (body.updates.bio && body.updates.bio.length > 2000) {
        return { statusCode: 400, body: { error: "Bio must be 2000 characters or less." } };
      }
      const contractor = await adminUpdateContractor(body.contractorId, body.updates);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "adminUploadLogo") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      if (!body.contractorId || !body.fileBase64 || !body.fileName) {
        return { statusCode: 400, body: { error: "contractorId, fileBase64 and fileName are required." } };
      }
      const contractor = await adminUploadLogo(body.contractorId, body.fileBase64, body.fileName);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "adminUploadPortfolioPhoto") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      if (!body.contractorId || !body.fileBase64 || !body.fileName) {
        return { statusCode: 400, body: { error: "contractorId, fileBase64 and fileName are required." } };
      }
      const photo = await adminUploadPortfolioPhoto(
        body.contractorId,
        body.fileBase64,
        body.fileName,
        body.contentType || "image/jpeg",
        body.caption || null,
        body.thumbnailBase64 || null
      );
      return { statusCode: 200, body: { photo } };
    }

    if (action === "adminDeletePortfolioPhoto") {
      try {
        if (!(await checkAdminPassword(body.adminPassword, req))) {
          return { statusCode: 401, body: { error: "Incorrect admin password." } };
        }
      } catch (err) {
        return { statusCode: 429, body: { error: err.message } };
      }
      if (!body.photoId) {
        return { statusCode: 400, body: { error: "photoId is required." } };
      }
      const result = await adminDeletePortfolioPhoto(body.photoId);
      return { statusCode: 200, body: result };
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
      if (body.contractor.businessName.length > 100) {
        return { statusCode: 400, body: { error: "Business name must be 100 characters or less." } };
      }
      if (body.contractor.bio && body.contractor.bio.length > 2000) {
        return { statusCode: 400, body: { error: "Bio must be 2000 characters or less." } };
      }
      if (!(await rateLimit(`contractor-create:${clientIp(req)}`, { max: 5, windowMs: 60 * 60 * 1000 }))) {
        return { statusCode: 429, body: { error: "Too many requests. Please try again later." } };
      }
      const contractor = await createContractorForAuthUser(authUser, body.contractor);
      return { statusCode: 200, body: { contractor } };
    }

    if (action === "update") {
      const updates = body.updates || {};
      if (updates.businessName && updates.businessName.length > 100) {
        return { statusCode: 400, body: { error: "Business name must be 100 characters or less." } };
      }
      if (updates.bio && updates.bio.length > 2000) {
        return { statusCode: 400, body: { error: "Bio must be 2000 characters or less." } };
      }
      const contractor = await updateMyContractor(authUser.id, updates);
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
  setCors(req, res);

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
