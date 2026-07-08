// ---------------------------------------------------------------------------
// shared.js
// ---------------------------------------------------------------------------
// Data and logic used by BOTH the customer-facing site (CustomerApp.jsx) and
// the admin dashboard (AdminApp.jsx): DFW zip/region data, the service-area
// matching engine, the platform fee math, Stripe/backend config, Supabase
// Auth client, and a few small data-shape helpers.
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Supabase Auth client
// ---------------------------------------------------------------------------
// PUBLIC/ANON key -- safe to ship in frontend code, unlike SUPABASE_SECRET_KEY
// used in the backend, which has full read/write access and must never
// appear here. The anon key lets the browser talk directly to Supabase Auth
// to sign up, sign in, sign out, and manage its own session, without your
// backend handling passwords at all.
const SUPABASE_URL = "https://dmyuuqrdycgzvnduzmqx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ROCu0YLzhW5bmOjNMDIaJg_bzNBk66N";

const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Returns the current session's access token, or null if nobody's signed
 * in. Sent to the backend as an Authorization header on every request, so
 * the backend can verify "who is this request really from" using Supabase
 * itself, rather than trusting a homeownerId the frontend simply claims.
 */
async function getAuthToken() {
  const { data } = await supabaseAuth.auth.getSession();
  return data?.session?.access_token || null;
}

// ---------------------------------------------------------------------------
// Stripe configuration
// ---------------------------------------------------------------------------
const STRIPE_PUBLISHABLE_KEY = "pk_test_51TmfZ8Qxv4nGJRt0dM2EqoyknUsH4sEDRMgH7sCWOS04zTe8oixaQN2Ql7pF2X4l8NQRU6NWBrnOBjsOdw70rBH400Sfs5ObZw";
const CREATE_PAYMENT_INTENT_URL = "https://harrys-list-backend.vercel.app/api/create-payment-intent";
const API_BASE_URL = "https://harrys-list-backend.vercel.app/api";

/**
 * Shared helper for calling the backend. Now also attaches the current
 * Supabase session's access token (if signed in) as an Authorization
 * header on every call. Backend routes that need to know "who is really
 * making this request" verify this token server-side.
 */
async function apiCall(resource, body, { timeoutMs = 20000 } = {}) {
  const token = await getAuthToken();
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Abort the request if it hangs, so the UI never waits forever (L-8).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/${resource}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Request to ${resource} timed out. Please try again.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request to ${resource} failed.`);
  }
  return data;
}

let stripeJsPromise = null;
function loadStripeJs() {
  if (stripeJsPromise) return stripeJsPromise;
  stripeJsPromise = new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/v3/";
    script.onload = () => resolve(window.Stripe);
    script.onerror = () => reject(new Error("Failed to load Stripe.js"));
    document.head.appendChild(script);
  });
  return stripeJsPromise;
}

const ZIP_DATA = {
  regions: [
    {
      region: "Central Dallas",
      cities: [
        { city: "Dallas", zip_codes: ["75201","75202","75203","75204","75205","75206","75207","75208","75209","75210","75211","75212","75214","75215","75216","75217","75218","75219","75220","75223","75224","75225","75226","75227","75228","75229","75230","75231","75232","75233","75234","75235","75236","75237","75238","75239","75240","75241","75242","75243","75244","75246","75247","75248","75249","75251","75252","75253","75254"] }
      ]
    },
    {
      region: "North Dallas / Collin County Suburbs",
      cities: [
        { city: "Plano", zip_codes: ["75023","75024","75025","75074","75075","75093","75094"] },
        { city: "Frisco", zip_codes: ["75033","75034","75035","75036"] },
        { city: "McKinney", zip_codes: ["75069","75070","75071","75072"] },
        { city: "Allen", zip_codes: ["75002","75013"] },
        { city: "Richardson", zip_codes: ["75080","75081","75082"] }
      ]
    },
    {
      region: "East Dallas Suburbs",
      cities: [
        { city: "Garland", zip_codes: ["75040","75041","75042","75043","75044"] },
        { city: "Mesquite", zip_codes: ["75149","75150","75180","75181","75182"] }
      ]
    },
    {
      region: "West Dallas / Las Colinas Corridor",
      cities: [
        { city: "Irving", zip_codes: ["75014","75015","75016","75017","75038","75039","75060","75061","75062","75063"] },
        { city: "Carrollton", zip_codes: ["75006","75007","75010"] },
        { city: "Grand Prairie", zip_codes: ["75050","75051","75052","75054"] }
      ]
    },
    {
      region: "Mid-Cities / Arlington",
      cities: [
        { city: "Arlington", zip_codes: ["76001","76002","76006","76010","76011","76012","76013","76014","76015","76016","76017","76018"] }
      ]
    },
    {
      region: "Fort Worth",
      cities: [
        { city: "Fort Worth", zip_codes: ["76101","76102","76103","76104","76105","76106","76107","76108","76109","76110","76111","76112","76114","76115","76116","76117","76118","76119","76120","76123","76126","76129","76130","76131","76132","76133","76134","76135","76136","76137","76140","76148","76155","76164","76177","76179","76180","76182","76244"] }
      ]
    }
  ]
};

function buildZipIndex(zipData) {
  const allZipCodes = new Set();
  const zipToCity = new Map();
  const zipToRegion = new Map();
  const cityToZips = new Map();
  const regionToZips = new Map();
  const regionToCities = new Map();

  for (const region of zipData.regions) {
    const regionZips = new Set();
    const citiesInRegion = [];
    for (const city of region.cities) {
      const cityZips = new Set(city.zip_codes);
      cityToZips.set(city.city, cityZips);
      citiesInRegion.push(city.city);
      for (const zip of city.zip_codes) {
        allZipCodes.add(zip);
        zipToCity.set(zip, city.city);
        zipToRegion.set(zip, region.region);
        regionZips.add(zip);
      }
    }
    regionToZips.set(region.region, regionZips);
    regionToCities.set(region.region, citiesInRegion);
  }

  return { allZipCodes, zipToCity, zipToRegion, cityToZips, regionToZips, regionToCities };
}

const INDEX = buildZipIndex(ZIP_DATA);

function resolveSelection(selection) {
  if (selection.mode === "ALL_DFW") return new Set(INDEX.allZipCodes);
  return new Set(selection.zipCodes);
}

function cityCheckState(selection, cityName) {
  const cityZips = INDEX.cityToZips.get(cityName);
  if (selection.mode === "ALL_DFW") return "checked";
  let n = 0;
  for (const z of cityZips) if (selection.zipCodes.has(z)) n++;
  if (n === 0) return "unchecked";
  if (n === cityZips.size) return "checked";
  return "indeterminate";
}

function regionCheckState(selection, regionName) {
  const regionZips = INDEX.regionToZips.get(regionName);
  if (selection.mode === "ALL_DFW") return "checked";
  let n = 0;
  for (const z of regionZips) if (selection.zipCodes.has(z)) n++;
  if (n === 0) return "unchecked";
  if (n === regionZips.size) return "checked";
  return "indeterminate";
}

function matchContractorsToZip(zip, contractors) {
  return contractors.filter((c) => {
    if (c.serviceArea.mode === "ALL_DFW") return true;
    return c.serviceArea.zipCodes.has(zip);
  });
}

const FEE_BRACKETS = [
  { upTo: 500, rate: 0.04, label: "Under $500" },
  { upTo: 2500, rate: 0.03, label: "$500 \u2013 $2,500" },
  { upTo: 10000, rate: 0.02, label: "$2,500 \u2013 $10,000" },
  { upTo: Infinity, rate: 0.01, label: "$10,000+" },
];

function feeOwedForAmount(amount) {
  let owed = 0;
  let lowerBound = 0;
  for (const bracket of FEE_BRACKETS) {
    if (amount <= lowerBound) break;
    const slice = Math.min(amount, bracket.upTo) - lowerBound;
    owed += slice * bracket.rate;
    lowerBound = bracket.upTo;
  }
  return Math.round(owed * 100) / 100;
}

function effectiveFeeRate(amount) {
  if (amount <= 0) return FEE_BRACKETS[0].rate;
  return feeOwedForAmount(amount) / amount;
}

const PAYMENT_DUE_DAYS = 10;

// Must match the 7-day cutoff in the backend's cronAutoConfirm job (jobs.js).
// If a homeowner takes no action on a pending confirmation within this many
// days, it's automatically confirmed. Homeowners are told this upfront (at
// report time) and reminded at 3 days, so this is shown in-app as a countdown
// too rather than being a surprise.
const AUTO_CONFIRM_DAYS = 7;

function daysBetween(isoA, isoB) {
  const a = new Date(isoA);
  const b = new Date(isoB);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function isPaymentOverdue(job, today = new Date()) {
  if (job.status !== "confirmed") return false;
  return daysBetween(job.confirmedAt, today.toISOString()) > PAYMENT_DUE_DAYS;
}

function contractorIsSuspended(contractor) {
  // Check database flag first (set by cron job) -- covers contractors
  // visible in the directory who may not have job data loaded client-side.
  if (contractor.isSuspended) return true;
  // Also check locally if job data is available.
  return (contractor.completedJobs || []).some(
    (job) => job.status === "confirmed" && isPaymentOverdue(job) && !job.feePaid
  );
}

const TRADES = [
  // Exterior
  "Roofing",
  "Fencing",
  "Gutters & Drainage",
  "Siding & Exterior",
  "Windows & Doors",
  "Painting — Exterior",

  // Landscaping & Outdoor
  "Landscaping & Lawn Care",
  "Mulch & Hardscape",
  "Tree Service",
  "Irrigation & Sprinklers",
  "Pool & Spa",
  "Outdoor Lighting",
  "Concrete & Driveways",

  // Interior
  "Painting — Interior",
  "Flooring",
  "Tile & Stonework",
  "Carpentry & Trim",
  "Kitchen Remodel",
  "Bathroom Remodel",
  "Basement & Additions",

  // Mechanical & Systems
  "HVAC",
  "Plumbing",
  "Electrical",
  "Insulation",
  "Solar",
  "Home Automation",

  // Maintenance & Cleaning
  "Pressure Washing",
  "House Cleaning",
  "Junk Removal",
  "Pest Control",
  "Chimney & Fireplace",

  // Youth & Student Businesses
  "Car Detailing",
  "Window Cleaning",
  "Gutter Cleaning",
  "Holiday Lighting",
  "Moving Help",
  "Furniture Assembly",
  "TV & Electronics Setup",
  "Garage Organization",

  // General
  "General Contractor",
  "Handyman",
];

// ---------------------------------------------------------------------------
// Slug helpers for programmatic trade x city SEO pages (/[trade]/[city]).
// Slugs are lowercase, hyphenated, with "&"/"—"/"." stripped so URLs stay
// clean (e.g. "Painting — Exterior" -> "painting-exterior",
// "Landscaping & Lawn Care" -> "landscaping-lawn-care").
// ---------------------------------------------------------------------------
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// slug -> canonical trade name, built once from TRADES so every trade is
// automatically reachable at /<slug> without hand-maintaining a map.
const TRADE_SLUG_TO_NAME = new Map(TRADES.map((t) => [slugify(t), t]));

// slug -> canonical city name, built from the same ZIP_DATA that powers the
// service-area picker, so city coverage always matches what's real.
const CITY_SLUG_TO_NAME = new Map(
  [...INDEX.cityToZips.keys()].map((c) => [slugify(c), c])
);

function tradeSlug(tradeName) {
  return slugify(tradeName);
}
function citySlug(cityName) {
  return slugify(cityName);
}
function tradeNameFromSlug(slug) {
  return TRADE_SLUG_TO_NAME.get(slug) || null;
}
function cityNameFromSlug(slug) {
  return CITY_SLUG_TO_NAME.get(slug) || null;
}

/** Does this contractor's service area actually cover the given city? */
function contractorCoversCity(contractor, cityName) {
  if (contractor.serviceArea.mode === "ALL_DFW") return true;
  const cityZips = INDEX.cityToZips.get(cityName);
  if (!cityZips) return false;
  const zips = contractor.serviceArea.zipCodes;
  for (const z of cityZips) {
    if (zips instanceof Set ? zips.has(z) : zips.includes(z)) return true;
  }
  return false;
}

/**
 * Picks one representative city for a contractor's service area, for the
 * "see other <trade> contractors in <city>" internal link on profile pages.
 * ALL_DFW contractors link to Dallas (largest city); CUSTOM areas link to
 * whichever covered city has the most of their selected zips.
 */
function primaryCityForServiceArea(serviceArea) {
  if (!serviceArea) return null;
  if (serviceArea.mode === "ALL_DFW") return "Dallas";
  const zips = serviceArea.zipCodes;
  const zipSet = zips instanceof Set ? zips : new Set(zips || []);
  if (zipSet.size === 0) return null;
  const counts = new Map();
  zipSet.forEach((z) => {
    const city = INDEX.zipToCity.get(z);
    if (city) counts.set(city, (counts.get(city) || 0) + 1);
  });
  let best = null, bestCount = 0;
  counts.forEach((count, city) => {
    if (count > bestCount) { best = city; bestCount = count; }
  });
  return best;
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function toId(value) {
  if (value === null || value === undefined || value === "") return value;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

function idsMatch(a, b) {
  return toId(a) === toId(b);
}

function normalizeContractor(contractor) {
  if (!contractor || !contractor.serviceArea) return contractor;
  const zips = contractor.serviceArea.zipCodes;
  let safeZips;
  if (zips instanceof Set) {
    safeZips = zips;
  } else if (Array.isArray(zips)) {
    safeZips = new Set(zips);
  } else {
    safeZips = new Set();
  }
  return {
    ...contractor,
    serviceArea: {
      ...contractor.serviceArea,
      zipCodes: safeZips,
    },
  };
}

function describeServiceArea(serviceArea) {
  if (serviceArea.mode === "ALL_DFW") return "Serves all of DFW";
  const zips = serviceArea.zipCodes;
  const cityCounts = new Map();
  zips.forEach((z) => {
    const city = INDEX.zipToCity.get(z);
    if (!city) return;
    cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
  });
  const fullCities = [];
  cityCounts.forEach((count, city) => {
    if (count === INDEX.cityToZips.get(city).size) fullCities.push(city);
  });
  if (fullCities.length > 0 && fullCities.length === cityCounts.size) {
    return `Serves ${fullCities.join(", ")}`;
  }
  return `Serves ${zips.size} zip code${zips.size === 1 ? "" : "s"}`;
}

export {
  supabaseAuth,
  getAuthToken,
  STRIPE_PUBLISHABLE_KEY,
  CREATE_PAYMENT_INTENT_URL,
  API_BASE_URL,
  apiCall,
  loadStripeJs,
  ZIP_DATA,
  INDEX,
  buildZipIndex,
  resolveSelection,
  cityCheckState,
  regionCheckState,
  matchContractorsToZip,
  FEE_BRACKETS,
  feeOwedForAmount,
  effectiveFeeRate,
  PAYMENT_DUE_DAYS,
  AUTO_CONFIRM_DAYS,
  isPaymentOverdue,
  contractorIsSuspended,
  TRADES,
  uid,
  toId,
  idsMatch,
  normalizeContractor,
  describeServiceArea,
  slugify,
  tradeSlug,
  citySlug,
  tradeNameFromSlug,
  cityNameFromSlug,
  contractorCoversCity,
  primaryCityForServiceArea,
};
