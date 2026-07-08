/**
 * api/_shared.js
 * ---------------------------------------------------------------------------
 * Shared helpers for every backend serverless function. Previously each
 * endpoint copy-pasted its own `supabase` client, `toId`, `getAuthedUser`,
 * CORS block, and (in two files) `checkAdminPassword`. That duplication was a
 * real drift hazard, so all of it now lives here and is imported everywhere.
 *
 * Consolidated concerns:
 *   - Supabase service client
 *   - toId / getAuthedUser
 *   - setCors            (origin-locked; fixes CORS wildcard)
 *   - checkAdminPassword (constant-time compare + durable rate limit)
 *   - rateLimit          (Supabase-backed, in-memory fallback; for public writes)
 *   - escapeHtml         (for transactional email templates)
 *   - validateImageUpload(magic-byte sniffing + allow-list + filename sanitize)
 *
 * ENVIRONMENT VARIABLES
 *   SUPABASE_URL, SUPABASE_SECRET_KEY, ADMIN_PASSWORD
 *   ALLOWED_ORIGINS  (optional, comma-separated; defaults to the prod domains)
 * ---------------------------------------------------------------------------
 */

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// ---------------------------------------------------------------------------
// ID coercion (numeric string -> number, otherwise passthrough)
// ---------------------------------------------------------------------------
function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

// ---------------------------------------------------------------------------
// CORS -- locked to the production site + Vercel preview deployments.
// (Previously every endpoint sent Access-Control-Allow-Origin: *.)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://harryslistdfw.com,https://www.harryslistdfw.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow Vercel preview URLs: https://<deploy>.vercel.app
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === "https:" && hostname.endsWith(".vercel.app")) return true;
  } catch (_) {
    /* not a valid URL */
  }
  return false;
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ---------------------------------------------------------------------------
// Auth: verify the Supabase session token and return the user it proves.
// ---------------------------------------------------------------------------
async function getAuthedUser(req) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

// ---------------------------------------------------------------------------
// Best-effort client IP. x-forwarded-for is client-spoofable, so prefer the
// edge-provided headers that Vercel injects and cannot be overridden by the
// caller. Only fall back to the left-most XFF entry if those are absent.
// ---------------------------------------------------------------------------
function clientIp(req) {
  const edge = req.headers["x-real-ip"] || req.headers["x-vercel-forwarded-for"];
  if (edge) return String(edge).split(",")[0].trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// ---------------------------------------------------------------------------
// Rate limiter. Durable across cold starts when the `rate_limits` table exists
// (see migration in the repo notes); otherwise falls back to a per-instance
// in-memory window so an endpoint never hard-fails just because the table is
// missing. Returns true if the action is allowed, false if the limit is hit.
// ---------------------------------------------------------------------------
const _memBuckets = new Map();

async function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  try {
    const windowStart = new Date(now - windowMs).toISOString();
    const { count, error } = await supabase
      .from("rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("bucket", key)
      .gte("created_at", windowStart);
    if (error) throw error;
    if ((count || 0) >= max) return false;
    await supabase.from("rate_limits").insert({ bucket: key });
    return true;
  } catch (_) {
    // Fallback: in-memory sliding window (resets on cold start).
    const rec = _memBuckets.get(key) || { hits: [] };
    rec.hits = rec.hits.filter((t) => t > now - windowMs);
    if (rec.hits.length >= max) {
      _memBuckets.set(key, rec);
      return false;
    }
    rec.hits.push(now);
    _memBuckets.set(key, rec);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Admin auth: constant-time comparison + durable rate limit keyed on a
// trustworthy IP source. NOTE: a single shared password is still a weak model;
// the recommended next step is a Supabase Auth `is_admin` role verified like
// any other session. This closes the timing leak and the XFF-spoofing bypass.
// ---------------------------------------------------------------------------
function timingSafeEqualStr(a, b) {
  // Hash both sides to a fixed length first so the compare cannot leak the
  // secret's length, then constant-time compare the digests.
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Checks whether `key` is currently within its limit WITHOUT recording a new
 * attempt. Used so that checking "am I locked out?" never itself counts as
 * an attempt.
 */
async function rateLimitPeek(key, { max, windowMs }) {
  const now = Date.now();
  try {
    const windowStart = new Date(now - windowMs).toISOString();
    const { count, error } = await supabase
      .from("rate_limits")
      .select("id", { count: "exact", head: true })
      .eq("bucket", key)
      .gte("created_at", windowStart);
    if (error) throw error;
    return (count || 0) < max;
  } catch (_) {
    const rec = _memBuckets.get(key) || { hits: [] };
    rec.hits = rec.hits.filter((t) => t > now - windowMs);
    return rec.hits.length < max;
  }
}

/** Records one attempt against `key`, independent of rateLimit()'s combined check-and-record. */
async function rateLimitRecord(key, windowMs) {
  const now = Date.now();
  try {
    await supabase.from("rate_limits").insert({ bucket: key });
  } catch (_) {
    const rec = _memBuckets.get(key) || { hits: [] };
    rec.hits = rec.hits.filter((t) => t > now - windowMs);
    rec.hits.push(now);
    _memBuckets.set(key, rec);
  }
}

// Admin lockout window and threshold, in one place so they're easy to tune.
const ADMIN_LOCKOUT_MAX_FAILURES = 8;
const ADMIN_LOCKOUT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

async function checkAdminPassword(password, req) {
  const ip = clientIp(req);
  const key = `admin:${ip}`;
  const windowOpts = { max: ADMIN_LOCKOUT_MAX_FAILURES, windowMs: ADMIN_LOCKOUT_WINDOW_MS };

  // Peek only -- the admin panel resends the password on every action
  // (approving a contractor, switching tabs, etc.), so checking "am I
  // locked out" must never itself count as an attempt. Only an actual
  // WRONG password below adds to the count.
  const stillAllowed = await rateLimitPeek(key, windowOpts);
  if (!stillAllowed) {
    throw new Error("Too many failed attempts. Please try again later.");
  }

  const realPassword = process.env.ADMIN_PASSWORD;
  if (!realPassword) {
    console.error("WARNING: ADMIN_PASSWORD is not set. Admin actions are disabled.");
    return false;
  }

  const isCorrect = timingSafeEqualStr(password || "", realPassword);
  if (!isCorrect) {
    await rateLimitRecord(key, ADMIN_LOCKOUT_WINDOW_MS);
  }
  return isCorrect;
}

// ---------------------------------------------------------------------------
// HTML escaping for values interpolated into transactional email bodies.
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Image upload validation: verify real image bytes (not just the client's
// claimed content-type), reject SVG/HTML, and produce a safe stored filename.
// ---------------------------------------------------------------------------
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function extForType(type) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[type];
}

function sanitizeFileName(name) {
  const cleaned = String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-80) || "file";
}

/**
 * Validates a base64-encoded upload. Returns { buffer, contentType, safeName }
 * derived from the *actual* bytes, or throws with a user-safe message.
 * The declared content-type is ignored in favour of magic-byte sniffing.
 */
function validateImageUpload(fileBase64, fileName) {
  if (!fileBase64) throw new Error("No file provided.");
  const buffer = Buffer.from(fileBase64, "base64");
  const MAX_BYTES = 8 * 1024 * 1024; // 8MB
  if (buffer.length === 0) throw new Error("Empty file.");
  if (buffer.length > MAX_BYTES) throw new Error("File too large (max 8MB).");

  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    throw new Error("File must be a valid PNG, JPEG, or WebP image.");
  }
  const base = sanitizeFileName(fileName).replace(/\.[^.]*$/, "");
  const safeName = `${base}.${extForType(sniffed)}`;
  return { buffer, contentType: sniffed, safeName };
}

module.exports = {
  supabase,
  toId,
  ALLOWED_ORIGINS,
  isAllowedOrigin,
  setCors,
  getAuthedUser,
  clientIp,
  rateLimit,
  checkAdminPassword,
  timingSafeEqualStr,
  escapeHtml,
  ALLOWED_IMAGE_TYPES,
  validateImageUpload,
};
