/**
 * Padeli — Playtomic data access (public club page + same-origin availability).
 *
 * Authoritative source for court counts + indoor/outdoor per club and for the
 * peak price per club. Used by the create-listing pipeline (stages 6.5 / 6.6 /
 * 7b / 7c), by audit-content (drift check), and by site-wide backfills.
 *
 * PORTED 2026-10-02 (task t462): api.playtomic.io and api.playtomic.com are
 * NXDOMAIN — the host is gone. Every function that used the API now reads:
 *
 *   (a) the tenant JSON embedded in https://playtomic.com/clubs/<slug>
 *       (browser UA, 15s timeout; playtomic.com/clubs/<uuid> 30x-redirects to
 *       the slug page). Gives tenant_id, tenant_name, slug, address (with
 *       country_code + coordinates + timezone), opening_hours, resources
 *       (count + indoor/outdoor from each resource's `features[]`), images,
 *       properties (WEBSITE_URL, CONTACT_PHONE, FACILITY_*) and
 *       `otherRelevantTenants` (nearby clubs).
 *   (b) https://playtomic.com/api/clubs/availability?tenant_id=<uuid>&sport_id=PADEL&date=YYYY-MM-DD
 *       (the club page's own fetch) for slot prices.
 *
 * Both are plain GETs. Every outbound request goes through one politeness gate
 * (2s between requests) and an in-process cache, so a pipeline run never hits
 * the same page or availability day twice.
 *
 * Reference parsers (proven on the live pages): padeli-audit-content
 * tools/uk-backfill-plan.js section A and uk-gold-standard
 * discovery-scripts/playtomic-crawl.js.
 *
 * Idempotent. Never throws to the caller from the get* functions — returns a
 * structured { ok, error } result instead.
 *
 * Node.js v24+ — no external dependencies.
 */

const PT_PUBLIC = 'https://playtomic.com';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15000;
const POLITENESS_MS = Number(process.env.PADELI_PLAYTOMIC_DELAY_MS || 2000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// URL helpers (unchanged contract)
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PT_SLUG_FINAL = /^https:\/\/(?:www\.)?playtomic\.com\/clubs\/([a-z0-9][a-z0-9-]*)\/?$/i;

/**
 * Extract the tenant UUID from a Playtomic URL (when present in path).
 * Accepts:
 *   https://playtomic.io/tenant/{uuid}                  (legacy API form — dead)
 *   https://playtomic.com/clubs/tenant/{uuid}           (dead)
 *   https://playtomic.com/tenant/{uuid}                 (legacy)
 *   https://playtomic.com/clubs/{uuid}                  (redirects to the slug)
 *   https://app.playtomic.io|com/clubs/{uuid}           (app wall — uuid is still usable)
 * Returns null if no UUID is in the URL (e.g. slug-only `.com/clubs/{slug}`).
 */
function tenantIdFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const m = s.match(/playtomic\.(?:io|com)\/(?:clubs\/)?(?:tenant\/)?([a-f0-9-]{36})/i);
  return m && UUID_RE.test(m[1]) ? m[1].toLowerCase() : null;
}

/**
 * Extract a slug (tenant_uid) from a consumer Playtomic URL.
 * Accepts:  https://playtomic.com/clubs/{slug}   (NOT the /clubs/tenant/ form, NOT a uuid)
 * Returns null if not a slug-style URL.
 */
function tenantSlugFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/playtomic\.com\/clubs\/(?!tenant\b)([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\/?(?:[?#]|$)/i);
  if (!m) return null;
  if (UUID_RE.test(m[1])) return null;
  return m[1].toLowerCase();
}

// ---------------------------------------------------------------------------
// Public booking URL — CORRECTED 2026-10-02 (audit 2026-08-12, re-verified)
// ---------------------------------------------------------------------------
// The ONLY bookable public form is   https://playtomic.com/clubs/<slug>
//
//   - app.playtomic.io/clubs/* and app.playtomic.com/clubs/* are an APP-INSTALL
//     WALL: HTTP 200 and the same page for ANY string, garbage included. No
//     status check can validate them and on mobile they dead-end anyone without
//     the app. NEVER write them, NEVER accept them as a redirect destination.
//     (.io now 308s to .com — both hosts are walls.)
//   - playtomic.io/tenant/<uuid> and playtomic.com/clubs/tenant/<uuid> are dead.
//   - playtomic.com/clubs/<uuid> server-side redirects to the slug form, so a
//     UUID is resolvable with ONE GET following redirects (browser UA). The slug
//     page must then itself return 200 — ~27% of resolved slugs 404 (club left
//     Playtomic) and must be held for a human, never written.
//   - A wrong booking link is worse than no booking link.

/** True for any playtomic.io / playtomic.com host (incl. app. / www.). */
function isPlaytomicUrl(url) {
  if (!url) return false;
  try {
    return /(^|\.)playtomic\.(io|com)$/i.test(new URL(String(url).trim()).hostname);
  } catch {
    return /playtomic\.(io|com)/i.test(String(url));
  }
}

/**
 * True for the shapes that must never be written or accepted:
 *   app.playtomic.io/...  app.playtomic.com/...   (app-install wall)
 *   playtomic.io/...                              (no public site; 308s to the wall)
 *   any playtomic host with a /tenant/<uuid> path (dead)
 */
function isDeadPlaytomicShape(url) {
  if (!url) return false;
  const s = String(url).trim();
  let host, pathname;
  try {
    const u = new URL(s);
    host = u.hostname.toLowerCase();
    pathname = u.pathname;
  } catch {
    return /app\.playtomic\.|playtomic\.io|\/tenant\//i.test(s);
  }
  if (/^app\.playtomic\.(io|com)$/.test(host)) return true;
  if (/^(www\.)?playtomic\.io$/.test(host)) return true;
  if (/playtomic\.(io|com)$/.test(host) && /(^|\/)tenant\//i.test(pathname)) return true;
  return false;
}

/**
 * Synchronous canonicaliser — the single boundary for any Playtomic URL
 * entering or leaving the system. Call it BEFORE writing to WP.
 *
 * Rules:
 *   - playtomic.com/clubs/<slug>  (any www/case)  → https://playtomic.com/clubs/<slug>
 *   - uuid-only forms (tenant/, app.*, playtomic.com/clubs/<uuid>) → null
 *       (needs the network: use resolvePlaytomicUrl())
 *   - any other dead Playtomic shape           → null
 *   - non-Playtomic URL (Matchi, playbypoint…) → returned as-is
 *   - null/undefined/empty input               → null
 */
function canonicalizePlaytomicUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  if (!isPlaytomicUrl(s)) return s;
  if (isDeadPlaytomicShape(s)) return null;
  const slug = tenantSlugFromUrl(s);
  if (slug) return `${PT_PUBLIC}/clubs/${slug}`;
  return null;
}

// ---------------------------------------------------------------------------
// Politeness gate + in-process cache
// ---------------------------------------------------------------------------

let _lastRequestAt = 0;
let _gate = Promise.resolve();

/** Serialise outbound requests and keep ≥ POLITENESS_MS between them. */
function polite(fn) {
  const run = async () => {
    const wait = _lastRequestAt + POLITENESS_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { _lastRequestAt = Date.now(); }
  };
  const p = _gate.then(run, run);
  _gate = p.catch(() => {});
  return p;
}

const _cache = new Map(); // key → value (process lifetime)
const cacheGet = (k) => (_cache.has(k) ? _cache.get(k) : undefined);
const cacheSet = (k, v) => { _cache.set(k, v); return v; };
/** Clear the in-process cache (tests / long-running batch drivers). */
function clearCache() { _cache.clear(); }

async function ptGet(url, { accept, timeoutMs = DEFAULT_TIMEOUT_MS, redirect = 'follow' } = {}) {
  return polite(async () => {
    const res = await fetch(url, {
      method: 'GET',
      redirect,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url || url };
  });
}

// ---------------------------------------------------------------------------
// Club page → tenant JSON (proven extractor from uk-backfill-plan / playtomic-crawl)
// ---------------------------------------------------------------------------

/**
 * Brace-match a JSON object/array out of the Next.js flight payload. The data
 * is double-escaped inside a JS string, so we unescape a window first.
 */
function extractJson(html, marker, open) {
  let i = html.indexOf(marker);
  if (i < 0) return null;
  i = html.indexOf(open, i);
  if (i < 0) return null;
  const slice = html.slice(i, i + 400000).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  let depth = 0, inStr = false, esc = false;
  for (let k = 0; k < slice.length; k++) {
    const ch = slice[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { try { return JSON.parse(slice.slice(0, k + 1)); } catch { return null; } }
    }
  }
  return null;
}

/**
 * Pull the raw tenant object + otherRelevantTenants out of a club page's HTML.
 * Returns null when the page carries no tenant JSON (404 page, wall, changed markup).
 */
function extractTenantFromClubPage(html) {
  if (!html) return null;
  const tenant = extractJson(html, '\\"tenant\\":{\\"tenant_id\\"', '{') || extractJson(html, '"tenant":{"tenant_id"', '{');
  if (!tenant || !tenant.tenant_id) return null;
  const others = extractJson(html, '\\"otherRelevantTenants\\":[', '[') || extractJson(html, '"otherRelevantTenants":[', '[') || [];
  return { tenant, otherRelevantTenants: Array.isArray(others) ? others : [] };
}

/** Classify one resource (API shape or club-page shape) as indoor/outdoor/unknown. */
function resourceRoof(r) {
  const t = String((r && r.properties && r.properties.resource_type) || '').toLowerCase();
  if (t === 'indoor') return 'indoor';
  if (t === 'outdoor' || t === 'roofed') return 'outdoor';
  const feats = Array.isArray(r && r.features) ? r.features.map((f) => String(f).toLowerCase()) : [];
  if (feats.includes('indoor')) return 'indoor';
  if (feats.includes('outdoor') || feats.includes('roofed')) return 'outdoor';
  return 'unknown';
}

function resourceSport(r) {
  return String((r && (r.sport_id || r.sport)) || '').toUpperCase();
}

/**
 * Normalise a raw tenant object (club page shape; tolerant of the old API
 * shape) into one stable structure for the pipeline.
 */
function normalizeTenant(raw, others = []) {
  const t = raw || {};
  const a = t.address || {};
  const coord = a.coordinate || a.coordinates || {};
  const lat = coord.lat != null ? Number(coord.lat) : null;
  const lng = coord.lon != null ? Number(coord.lon) : (coord.lng != null ? Number(coord.lng) : null);
  const props = t.properties || {};
  const allRes = (Array.isArray(t.resources) ? t.resources : []).filter((r) => r && r.is_active !== false);
  const padel = allRes.filter((r) => { const s = resourceSport(r); return !s || s === 'PADEL'; });
  const resources = padel.map((r) => ({
    id: r.resource_id || r.resourceId || null,
    name: (r.name || '').trim() || null,
    sport: resourceSport(r) || 'PADEL',
    roof: resourceRoof(r),
    features: Array.isArray(r.features) ? r.features : [],
    size: (r.properties && r.properties.resource_size) || (Array.isArray(r.features) && r.features.includes('single') ? 'single' : null),
  }));
  let indoor = 0, outdoor = 0, unknown = 0;
  for (const r of resources) { if (r.roof === 'indoor') indoor++; else if (r.roof === 'outdoor') outdoor++; else unknown++; }
  const images = (t.images || []).map((img) => (typeof img === 'string' ? img : (img && (img.url || img.image_url)) || null)).filter(Boolean);
  const sportIds = Array.isArray(t.sport_ids) ? t.sport_ids : [...new Set(allRes.map(resourceSport).filter(Boolean))];
  return {
    tenant_id: t.tenant_id || null,
    tenant_name: (t.tenant_name || t.name || '').trim() || null,
    slug: t.slug || t.tenant_uid || null,
    public_url: t.slug ? `${PT_PUBLIC}/clubs/${String(t.slug).toLowerCase()}` : null,
    status: t.tenant_status || t.playtomic_status || null,
    address: {
      street: a.street || null,
      postal_code: a.postal_code || null,
      city: a.city || null,
      region: a.sub_administrative_area || a.administrative_area || null,
      administrative_area: a.administrative_area || null,
      country: a.country || null,
      country_code: a.country_code || null,
      timezone: a.timezone || null,
    },
    country_code: a.country_code || null,
    coordinates: lat != null && lng != null ? { lat, lng } : null,
    timezone: a.timezone || null,
    opening_hours: t.opening_hours || null,
    courts: {
      total: resources.length,
      indoor,
      outdoor,
      unknown,
      indoor_outdoor: indoor && outdoor ? 'both' : indoor ? 'indoor' : outdoor ? 'outdoor' : null,
    },
    resources,
    images,
    website: props.WEBSITE_URL || (t.properties && t.properties.url) || t.url || null,
    phone: props.CONTACT_PHONE || (t.properties && t.properties.phone) || null,
    description: props.DETAILS_PAGE_DESCRIPTION || null,
    facilities: Object.keys(props).filter((k) => k.startsWith('FACILITY_') && String(props[k]) === 'true').map((k) => k.replace(/^FACILITY_/, '').toLowerCase()),
    sport_ids: sportIds,
    other_sports: sportIds.filter((s) => s !== 'PADEL'),
    booking_type: t.booking_type || null,
    default_currency: t.default_currency || null,
    otherRelevantTenants: (others || []).map((o) => ({
      tenant_id: o.tenant_id || null,
      tenant_name: o.tenant_name || null,
      slug: o.slug || null,
      city: o.city || null,
    })),
    raw: t,
  };
}

/**
 * GET a club page by slug or uuid. Cached per final slug / input.
 * @returns {Promise<object>} { ok, status, finalUrl, slug, tenant } | { ok:false, error, status, finalUrl }
 */
async function fetchClubPage(slugOrUuid, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = `page:${String(slugOrUuid).toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let r;
  try {
    r = await ptGet(`${PT_PUBLIC}/clubs/${encodeURIComponent(String(slugOrUuid).toLowerCase())}`, { timeoutMs });
  } catch (e) {
    return { ok: false, error: `network: ${e.message}`, status: 0, finalUrl: null }; // not cached — transient
  }
  const m = (r.finalUrl || '').match(PT_SLUG_FINAL);
  const finalSlug = m ? m[1].toLowerCase() : null;
  if (r.status === 429 || r.status >= 500) return { ok: false, error: `http-${r.status}`, status: r.status, finalUrl: r.finalUrl }; // transient — not cached
  if (r.status === 404 || r.status === 410) return cacheSet(key, { ok: false, error: 'slug-not-found', status: r.status, finalUrl: r.finalUrl });
  if (r.status !== 200) return cacheSet(key, { ok: false, error: `http-${r.status}`, status: r.status, finalUrl: r.finalUrl });
  if (!finalSlug || isDeadPlaytomicShape(r.finalUrl)) {
    return cacheSet(key, { ok: false, error: 'not-a-slug-page', status: r.status, finalUrl: r.finalUrl });
  }
  const ex = extractTenantFromClubPage(r.text);
  if (!ex) return cacheSet(key, { ok: false, error: 'no-tenant-json', status: r.status, finalUrl: r.finalUrl, slug: finalSlug });
  const tenant = normalizeTenant(ex.tenant, ex.otherRelevantTenants);
  if (!tenant.slug) { tenant.slug = finalSlug; tenant.public_url = `${PT_PUBLIC}/clubs/${finalSlug}`; }
  const out = { ok: true, status: 200, finalUrl: r.finalUrl, slug: finalSlug, tenant };
  cacheSet(key, out);
  cacheSet(`page:${finalSlug}`, out);
  if (tenant.tenant_id) cacheSet(`page:${tenant.tenant_id.toLowerCase()}`, out);
  return out;
}

/**
 * Resolve a tenant by slug. Signature kept from the API era.
 * @returns {Promise<{tenant: object}|{error: string}>}
 */
async function resolveTenantBySlug(slug, opts = {}) {
  if (!slug) return { error: 'invalid-slug' };
  const r = await fetchClubPage(slug, opts);
  if (!r.ok) return { error: r.error, status: r.status, finalUrl: r.finalUrl };
  return { tenant: r.tenant, slug: r.slug, finalUrl: r.finalUrl };
}

/**
 * Fetch a tenant by UUID (playtomic.com/clubs/<uuid> → redirect → slug page).
 * Signature kept; the result is now { tenant } | { error } like resolveTenantBySlug.
 */
async function fetchTenantByUuid(uuid, opts = {}) {
  if (!uuid || !UUID_RE.test(uuid)) return { error: 'invalid-uuid' };
  const r = await fetchClubPage(uuid, opts);
  if (!r.ok) return { error: r.error === 'slug-not-found' ? 'tenant-not-found' : r.error, status: r.status, finalUrl: r.finalUrl };
  return { tenant: r.tenant, slug: r.slug, finalUrl: r.finalUrl };
}

/** Any Playtomic URL (slug / uuid / dead shape with a uuid) → { tenant } | { error }. */
async function fetchTenant(url, opts = {}) {
  const uuid = tenantIdFromUrl(url);
  if (uuid) return fetchTenantByUuid(uuid, opts);
  const slug = tenantSlugFromUrl(url);
  if (slug) return resolveTenantBySlug(slug, opts);
  if (UUID_RE.test(String(url || ''))) return fetchTenantByUuid(String(url).match(UUID_RE)[0], opts);
  return { error: 'invalid-url' };
}

/**
 * Asynchronous resolver: turns ANY Playtomic input into a verified
 * https://playtomic.com/clubs/<slug> URL, or reports why it cannot.
 *
 *   slug form  → GET the slug page, require 200 (playtomic.com 404s honestly)
 *   uuid form  → GET https://playtomic.com/clubs/<uuid> following redirects,
 *                require final URL to match PT_SLUG_FINAL AND status 200
 *   non-Playtomic → passthrough { ok: true, url }
 *
 * @returns {Promise<object>} { ok, url, slug, source, status, finalUrl, tenant } or
 *   { ok: false, reason: 'playtomic_slug_unresolvable', detail, input, url: null }
 *   The orchestrator must HOLD the booking field on ok:false — it must not
 *   auto-declare no_online_booking; that is a human/researcher decision.
 */
async function resolvePlaytomicUrl(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url || !String(url).trim()) return { ok: false, reason: 'no-url', input: url, url: null };
  const s = String(url).trim();
  if (!isPlaytomicUrl(s)) return { ok: true, url: s, slug: null, source: 'passthrough' };

  let candidate = canonicalizePlaytomicUrl(s);
  let source = 'slug';
  let key;
  if (candidate) {
    key = tenantSlugFromUrl(candidate);
  } else {
    const uuid = (s.match(UUID_RE) || [])[0];
    if (!uuid) {
      return { ok: false, reason: 'playtomic_slug_unresolvable', detail: 'dead Playtomic shape with no uuid to resolve', input: s, url: null };
    }
    key = uuid.toLowerCase();
    candidate = `${PT_PUBLIC}/clubs/${key}`;
    source = 'uuid-redirect';
  }

  const r = await fetchClubPage(key, { timeoutMs });
  if (r.ok) {
    return { ok: true, url: `${PT_PUBLIC}/clubs/${r.slug}`, slug: r.slug, source, status: 200, finalUrl: r.finalUrl, tenant: r.tenant };
  }
  if (/^network/.test(r.error)) {
    return { ok: false, reason: 'playtomic_slug_unresolvable', detail: r.error, input: s, url: null };
  }
  if (r.error === 'not-a-slug-page') {
    return { ok: false, reason: 'playtomic_slug_unresolvable', detail: `final URL is not a playtomic.com/clubs/<slug> page: ${r.finalUrl} (HTTP ${r.status})`, input: s, url: null, status: r.status, finalUrl: r.finalUrl };
  }
  if (r.error === 'no-tenant-json') {
    // The slug page is live (200) even though the embedded JSON could not be read: still a valid booking URL.
    return { ok: true, url: `${PT_PUBLIC}/clubs/${r.slug}`, slug: r.slug, source, status: 200, finalUrl: r.finalUrl, tenant: null, warning: 'no-tenant-json' };
  }
  return { ok: false, reason: 'playtomic_slug_unresolvable', detail: `slug page ${r.finalUrl || candidate} returned HTTP ${r.status} — club has likely left Playtomic`, input: s, url: null, status: r.status, finalUrl: r.finalUrl };
}

// ---------------------------------------------------------------------------
// Name-match guard (accuracy-first)
// ---------------------------------------------------------------------------

const NAME_STOPWORDS = new Set([
  'padel','club','clubs','center','centre','sports','academy','academies','the','&','and','la','of','at','by','in','for','to',
  'court','courts','indoor','outdoor','park','arena','hub','fitness','football','tennis','pickleball','pro','play','play2',
  'dubai','abu','dhabi','sharjah','ajman','fujairah','uae','emirates','united','arab','uk','london','usa','us','au','australia',
  'jumeirah','marina','downtown','jbr','deira','bur','dxb','quoz','wasl','barsha','sufouh','furjan','jvc',
  'business','bay','silicon','oasis','warsan','hatta','jebel','ali','dragon','mart','remraam','nad','hamar','umm',
  'yas','saadiyat','reem','mafraq','musaffah','khalifa','mbz','al','dhafra','garhoud','ruwais','maryah',
  '-','–','—','/','+','@','(',')',
]);

/**
 * Fuzzy-match the venue name against the returned Playtomic tenant_name.
 *
 * Background: in 2026-06-03 we discovered 30 listings had the wrong Playtomic
 * UUID assigned (all pointing to "adel"). The Playtomic backfill dutifully
 * pulled adel's data and wrote it to every one of them. Without this guard,
 * any UUID corruption gets amplified by the next backfill. WP 11410 (2026-10)
 * pointed at a South African tenant for the same reason.
 *
 * Rule:
 *   - Tokenise both names (lowercase, alphanumeric, drop generic padel/location
 *     stopwords + listing's own city words)
 *   - Score = common tokens / min(|listing|, |tenant|)
 *   - Match if score >= 0.75 AND (≥2 distinctive tokens match OR every listing
 *     token is in tenant)
 *
 * @returns {object} { ok, score, common, t1size, reason? }
 */
function verifyTenantMatchesVenue(venueName, tenantName, opts = {}) {
  if (!venueName || !tenantName) return { ok: false, score: 0, common: 0, t1size: 0, reason: 'missing-input' };
  // Fast-path (2026-06-26): normalized full-string equality / containment. Catches
  // exact matches whose only distinctive token is <3 chars or a stopword (e.g.
  // "Padel Club EP", "Marina Padel", "Oasis Padel", "Padel 26", "[PIPELINE TEST]
  // Bali Padel Academy"), which token-overlap alone scores as a false mismatch.
  const normFull = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const nv = normFull(venueName), nt = normFull(tenantName);
  if (nv && nt && (nv === nt || (nv.length >= 5 && nt.length >= 5 && (nv.includes(nt) || nt.includes(nv))))) {
    return { ok: true, score: 1, common: -1, t1size: -1, reason: 'normalized-string-match' };
  }
  const extra = new Set();
  for (const w of String(opts.cityHint || '').toLowerCase().split(/\s+/)) if (w) extra.add(w);
  const tok = (s, useExtra) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !NAME_STOPWORDS.has(w) && (!useExtra || !extra.has(w)) && w.length >= 3);
  let t1 = new Set(tok(venueName, true)), t2 = new Set(tok(tenantName, true));
  // Bug fix (2026-06-26): the cityHint over-strips when the city IS the venue's
  // identity (e.g. "Selby Padel Club" in Selby → strip padel/club/selby → empty),
  // forcing a false 'no-distinctive-tokens' mismatch (false WRONG_TENANT / PT05).
  // Fallback: if cityHint stripping wiped either side clean, recompute WITHOUT
  // removing city words so an exact "[City] Padel Club" pair still matches.
  if (!t1.size || !t2.size) { t1 = new Set(tok(venueName, false)); t2 = new Set(tok(tenantName, false)); }
  if (!t1.size || !t2.size) return { ok: false, score: 0, common: 0, t1size: t1.size, reason: 'no-distinctive-tokens' };
  let common = 0;
  for (const w of t1) if (t2.has(w)) common++;
  const score = common / Math.min(t1.size, t2.size);
  const confident = score >= 0.75 && (common >= 2 || common === t1.size);
  return { ok: confident, score, common, t1size: t1.size, t2size: t2.size };
}

/**
 * Token similarity gate used by getCourts()/getPeakPrice() when a venueName is
 * supplied: a tenant whose name does not token-match the venue (≥ 0.6) is
 * returned with `nameMatch: false` so stages 7b/7c refuse to override.
 *
 * ok = verifyTenantMatchesVenue().ok OR (token score ≥ 0.6 with ≥ 1 distinctive
 * token in common). Score is the same common/min(|a|,|b|) ratio.
 *
 * @returns {{ ok: boolean, score: number, threshold: number, detail: object }}
 */
function tenantNameMatch(venueName, tenantName, opts = {}) {
  const v = verifyTenantMatchesVenue(venueName, tenantName, opts);
  const threshold = opts.threshold != null ? opts.threshold : 0.6;
  const ok = !!v.ok || (v.score >= threshold && (v.common === -1 || v.common >= 1));
  return { ok, score: Number(v.score || 0), threshold, detail: v };
}

// ---------------------------------------------------------------------------
// Court data
// ---------------------------------------------------------------------------

/**
 * Build the standard court result from a normalised tenant. Keeps every field
 * the API-era callers read (tenantId, tenantName, indoor, outdoor, unknown,
 * total, activeTotal, hasIndoor, hasOutdoor, resources, countryCode, timezone).
 */
function parseTenant(tenant) {
  const t = tenant && tenant.raw !== undefined ? tenant : normalizeTenant(tenant);
  const c = t.courts;
  return {
    ok: true,
    tenantId: t.tenant_id,
    tenantUid: t.slug,
    tenantName: t.tenant_name,
    slug: t.slug,
    publicUrl: t.public_url,
    currency: t.default_currency,
    countryCode: t.country_code,
    timezone: t.timezone,
    coordinates: t.coordinates,
    indoor: c.indoor,
    outdoor: c.outdoor,
    unknown: c.unknown,
    total: c.total,
    activeTotal: c.indoor + c.outdoor,
    hasIndoor: c.indoor > 0,
    hasOutdoor: c.outdoor > 0,
    resources: t.resources,
    openingHours: t.opening_hours,
    images: t.images,
    otherRelevantTenants: t.otherRelevantTenants,
    tenant: t,
  };
}

/**
 * Fetch court data for a Playtomic tenant.
 *
 * @param {string} url - Playtomic URL (slug page, uuid form, or dead shape carrying a uuid).
 * @param {object} [opts]
 * @param {number} [opts.retries=3]         - Max attempts on transient failure.
 * @param {number} [opts.retryDelayMs=2000] - Base backoff between retries.
 * @param {string} [opts.venueName]         - When given, the tenant name is checked
 *                                            against it; a mismatch returns
 *                                            { ok:false, error:'name-mismatch', nameMatch:false, ... }.
 * @param {string} [opts.cityHint]
 *
 * @returns {Promise<object>} Always-shaped result:
 *   { ok, tenantId, tenantName, slug, publicUrl, countryCode, timezone, coordinates,
 *     indoor, outdoor, unknown, total, activeTotal, hasIndoor, hasOutdoor,
 *     resources, openingHours, images, otherRelevantTenants, tenant,
 *     nameMatch: true|false|null, nameMatchScore }
 *   or { ok:false, error: 'invalid-url' | 'slug-not-found' | 'tenant-not-found' | 'http-XXX' | 'name-mismatch' | network-error }
 */
async function getCourts(url, { retries = 3, retryDelayMs = 2000, venueName = null, cityHint = null } = {}) {
  const uuid = tenantIdFromUrl(url) || ((String(url || '').match(UUID_RE) || [])[0] || '').toLowerCase() || null;
  const slug = uuid ? null : tenantSlugFromUrl(url);
  if (!uuid && !slug) return { ok: false, error: 'invalid-url' };

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const r = uuid ? await fetchTenantByUuid(uuid) : await resolveTenantBySlug(slug);
    if (r.tenant) {
      const out = parseTenant(r.tenant);
      out.nameMatch = null;
      out.nameMatchScore = null;
      if (venueName) {
        const nm = tenantNameMatch(venueName, out.tenantName, { cityHint });
        out.nameMatch = nm.ok;
        out.nameMatchScore = nm.score;
        out.nameMatchDetail = nm.detail;
        if (!nm.ok) {
          return { ...out, ok: false, error: 'name-mismatch', venueName };
        }
      }
      return out;
    }
    lastErr = r.error;
    if (/^(slug-not-found|tenant-not-found|invalid-|not-a-slug-page|no-tenant-json|http-4)/.test(lastErr || '')) {
      return { ok: false, error: lastErr, status: r.status, finalUrl: r.finalUrl };
    }
    if (attempt < retries - 1) await sleep(retryDelayMs * Math.pow(2, attempt));
  }
  return { ok: false, error: lastErr || 'unknown-error' };
}

// ---------------------------------------------------------------------------
// Peak price (same-origin availability endpoint)
// ---------------------------------------------------------------------------

/** Parse a Playtomic slot price string like "20 GBP" / "AED 270.50" / "Rp 150.000". */
function parseSlotPrice(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return { amount: s, currency: null };
  const str = String(s);
  const numMatch = str.match(/([0-9][0-9.,]*)/);
  if (!numMatch) return null;
  let raw = numMatch[1];
  // Heuristic: a single comma followed by 1-2 digits is a European decimal; else strip separators
  if (/,\d{1,2}$/.test(raw) && !/\.\d{1,2}$/.test(raw)) {
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else {
    raw = raw.replace(/,/g, '');
  }
  const amount = parseFloat(raw);
  if (isNaN(amount)) return null;
  const ccyMatch = str.match(/\b([A-Z]{3})\b/) || str.match(/([£$€₱])/);
  const currency = ccyMatch ? (ccyMatch[1] || ccyMatch[0]) : null;
  return { amount, currency };
}

/** Build the YYYY-MM-DDTHH:MM:SS string for the next given weekday + hour (kept for tests/callers). */
function nextWeekdayAt(weekday /* 0=Sun..6=Sat */, hour = 18, fromDate = new Date()) {
  const d = new Date(fromDate.getTime());
  d.setHours(0, 0, 0, 0);
  const cur = d.getDay();
  let delta = (weekday - cur + 7) % 7;
  if (delta === 0) delta = 7; // next, not today
  d.setDate(d.getDate() + delta);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00:00`;
}

/** LOCAL YYYY-MM-DD of the next given weekday (never toISOString — immune to BST/UTC flips). */
function nextDateFor(weekday, fromDate = new Date()) {
  return nextWeekdayAt(weekday, 12, fromDate).slice(0, 10);
}

/**
 * GET the same-origin availability for one tenant + date. Cached per tenant+date.
 * @returns {Promise<object>} { ok, date, data: [{resource_id, start_date, slots[]}] } | { ok:false, error }
 */
async function fetchAvailability(tenantId, date, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!tenantId || !UUID_RE.test(tenantId)) return { ok: false, error: 'invalid-tenant-id' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return { ok: false, error: 'invalid-date' };
  const key = `avail:${String(tenantId).toLowerCase()}:${date}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const url = `${PT_PUBLIC}/api/clubs/availability?tenant_id=${encodeURIComponent(tenantId)}&sport_id=PADEL&date=${date}`;
  let r;
  try {
    r = await ptGet(url, { accept: 'application/json', timeoutMs });
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
  if (r.status === 429 || r.status >= 500) return { ok: false, error: `http-${r.status}` };
  if (r.status !== 200) return cacheSet(key, { ok: false, error: `http-${r.status}` });
  let arr;
  try { arr = JSON.parse(r.text); } catch { return cacheSet(key, { ok: false, error: 'json-parse' }); }
  return cacheSet(key, { ok: true, date, data: Array.isArray(arr) ? arr : [] });
}

/**
 * Availability `start_time` values are UTC (verified 2026-10-02: Padelheim opens
 * 06:00 BST and its first slot is 05:00:00; Lembongan opens 08:00 WITA and its
 * first slot is 00:00:00). Convert to the tenant's local wall-clock HH:MM:SS.
 */
function localSlotTime(startDate, startTime, timezone) {
  const t = String(startTime || '');
  if (!timezone || !/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) || !/^\d{2}:\d{2}/.test(t)) return t;
  try {
    const d = new Date(`${startDate}T${t.length === 5 ? t + ':00' : t}Z`);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
    const get = (k) => (parts.find((p) => p.type === k) || {}).value || '00';
    return `${get('hour').replace('24', '00')}:${get('minute')}:${get('second')}`;
  } catch {
    return t;
  }
}

/**
 * Peak per-hour per-court price from one availability payload.
 * Peak = max 60-min slot price starting ≥ 17:00 LOCAL (pass `timezone`; the
 * payload's start_time is UTC). When the day has no 60-min evening slots the
 * longest-available evening slots are scaled to per-hour (`scaled: true`); when
 * the day has no evening slots at all, null is returned for `evening` and the
 * all-day maximum is offered as `allDay` for fallback.
 */
function peakFromAvailability(avail, { fromTime = '17:00:00', timezone = null } = {}) {
  const slots = [];
  for (const r of (avail && avail.data) || []) {
    for (const s of r.slots || []) {
      const p = parseSlotPrice(s.price != null ? s.price : (s.price_amount != null ? s.price_amount : s.amount));
      if (!p) continue;
      const dur = Number(s.duration) || 60;
      slots.push({
        start: localSlotTime(r.start_date || (avail && avail.date), s.start_time, timezone),
        startUtc: String(s.start_time || ''),
        duration: dur,
        raw: s.price != null ? String(s.price) : String(p.amount),
        amount: p.amount,
        perHour: Math.round((p.amount / dur) * 60 * 100) / 100,
        currency: p.currency,
      });
    }
  }
  if (!slots.length) return null;
  const summarise = (pool, window) => {
    const sixty = pool.filter((s) => s.duration === 60);
    const basis = sixty.length ? sixty : pool;
    const top = basis.reduce((a, b) => (b.perHour > a.perHour ? b : a));
    return {
      peak: top.perHour,
      scaled: !sixty.length,
      currency: top.currency || slots.find((s) => s.currency)?.currency || null,
      window,
      slotsSeen: pool.length,
      maxSlot: `${top.start.slice(0, 5)}/${top.duration}m ${top.raw}`,
      sample: [...new Set(basis.map((s) => `${s.start.slice(0, 5)}/${s.duration}m ${s.raw}`))].slice(0, 6),
    };
  };
  const evening = slots.filter((s) => s.start >= fromTime);
  return {
    evening: evening.length ? summarise(evening, `>=${fromTime.slice(0, 5)}`) : null,
    allDay: summarise(slots, 'all-day'),
    slotsSeen: slots.length,
  };
}

/**
 * Peak price for a Playtomic tenant: max 60-min per-court price on the next
 * Saturday ≥ 17:00, falling back to Friday, then Tuesday. If none of those days
 * exposes evening slots, the best all-day value seen is returned with
 * `window: 'all-day'`.
 *
 * @param {string} url - Playtomic URL (slug / uuid form).
 * @param {object} [opts]
 * @param {string} [opts.venueName] - name-guard; mismatch → { ok:false, error:'name-mismatch', nameMatch:false }
 * @param {string} [opts.cityHint]
 * @param {number[]} [opts.weekdays=[6,5,2]]
 * @returns {Promise<object>} {
 *   ok, peakPrice, currency, date, window, scaled, slotsSeen, attemptsTried, sample, maxSlot,
 *   tenantId, tenantName, slug, nameMatch, nameMatchScore
 * } | { ok:false, error, attemptsTried, ... }
 */
async function getPeakPrice(url, { venueName = null, cityHint = null, weekdays = [6, 5, 2], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t = await fetchTenant(url, { timeoutMs });
  if (!t.tenant) return { ok: false, error: t.error || 'tenant-not-found', attemptsTried: 0 };
  const tenant = t.tenant;
  const base = {
    tenantId: tenant.tenant_id,
    tenantName: tenant.tenant_name,
    slug: tenant.slug,
    publicUrl: tenant.public_url,
    nameMatch: null,
    nameMatchScore: null,
  };
  if (venueName) {
    const nm = tenantNameMatch(venueName, tenant.tenant_name, { cityHint });
    base.nameMatch = nm.ok;
    base.nameMatchScore = nm.score;
    base.nameMatchDetail = nm.detail;
    if (!nm.ok) return { ...base, ok: false, error: 'name-mismatch', venueName, attemptsTried: 0 };
  }
  if (!tenant.tenant_id) return { ...base, ok: false, error: 'no-tenant-id', attemptsTried: 0 };

  let tried = 0;
  let lastError = null;
  let allDayBest = null;
  for (const wd of weekdays) {
    tried++;
    const date = nextDateFor(wd);
    const avail = await fetchAvailability(tenant.tenant_id, date, { timeoutMs });
    if (!avail.ok) {
      lastError = avail.error;
      if (/^(http-403|http-429|network)/.test(avail.error)) break;
      continue;
    }
    const peak = peakFromAvailability(avail, { timezone: tenant.timezone });
    if (!peak) { lastError = 'no-slots'; continue; }
    if (peak.evening) {
      const e = peak.evening;
      return { ...base, ok: true, peakPrice: e.peak, currency: e.currency || tenant.default_currency, date, window: e.window, timezone: tenant.timezone, scaled: e.scaled, slotsSeen: e.slotsSeen, attemptsTried: tried, sample: e.sample, maxSlot: e.maxSlot };
    }
    if (!allDayBest || peak.allDay.peak > allDayBest.peak) allDayBest = { ...peak.allDay, date };
    lastError = 'no-evening-slots';
  }
  if (allDayBest) {
    return { ...base, ok: true, peakPrice: allDayBest.peak, currency: allDayBest.currency || tenant.default_currency, date: allDayBest.date, window: 'all-day', timezone: tenant.timezone, scaled: allDayBest.scaled, slotsSeen: allDayBest.slotsSeen, attemptsTried: tried, sample: allDayBest.sample, maxSlot: allDayBest.maxSlot };
  }
  return { ...base, ok: false, error: lastError || 'no-availability', attemptsTried: tried };
}

/** Alias kept for callers that used the older name. */
const fetchPeakPrice = getPeakPrice;

// ---------------------------------------------------------------------------
// Pipeline enrichment shape (what create-listing Stage 6.5 writes onto `venue`)
// ---------------------------------------------------------------------------

/**
 * Map a normalised tenant to the venue-enrichment shape the orchestrator and
 * research prompt consume (same keys discover-clubs.fetchPlaytomicTenant used).
 */
function toVenueEnrichment(tenant) {
  if (!tenant) return null;
  const t = tenant.raw !== undefined ? tenant : normalizeTenant(tenant);
  return {
    tenant_id: t.tenant_id,
    tenant_name: t.tenant_name,
    slug: t.slug,
    playtomic_url: t.public_url,
    playtomic_status: t.status,
    booking_type: t.booking_type,
    courts: t.courts.total || null,
    indoor_outdoor: t.courts.indoor_outdoor,
    surface_type: null,
    timezone: t.timezone,
    currency: t.default_currency,
    opening_hours_raw: t.opening_hours,
    images: t.images,
    court_details: t.resources.map((r) => ({
      name: r.name,
      type: r.roof === 'unknown' ? null : r.roof,
      size: r.size,
      feature: r.features.filter((f) => !/^(indoor|outdoor|roofed)$/i.test(f)).join(', ') || null,
      bookable_online: true,
    })),
    cancellation_policy: null,
    other_sports: t.other_sports,
    website: t.website,
    phone: t.phone,
    facilities: t.facilities,
    address: { ...t.address, lat: t.coordinates ? t.coordinates.lat : null, lng: t.coordinates ? t.coordinates.lng : null },
    other_relevant_tenants: t.otherRelevantTenants,
  };
}

/**
 * Best-effort tenant lookup by venue name (no search API exists any more):
 * tries the slugified name as a club-page slug, name-guarded. Returns the
 * enrichment shape or null.
 */
async function guessTenantByName(name, { cityHint = null, slugs = null } = {}) {
  if (!name) return null;
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const candidates = [...new Set([...(slugs || []), base, base.replace(/-padel-club$/, ''), base.replace(/-club$/, ''), `${base}-padel`].filter(Boolean))];
  for (const slug of candidates) {
    const r = await resolveTenantBySlug(slug);
    if (!r.tenant) continue;
    const nm = tenantNameMatch(name, r.tenant.tenant_name, { cityHint });
    if (!nm.ok) continue;
    return { ...toVenueEnrichment(r.tenant), nameMatch: true, nameMatchScore: nm.score, tried: candidates };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // URL helpers
  tenantIdFromUrl,
  tenantSlugFromUrl,
  canonicalizePlaytomicUrl,
  resolvePlaytomicUrl,
  isPlaytomicUrl,
  isDeadPlaytomicShape,
  PT_SLUG_FINAL,
  // tenant access (club page)
  fetchClubPage,
  resolveTenantBySlug,
  fetchTenantByUuid,
  fetchTenant,
  extractTenantFromClubPage,
  normalizeTenant,
  toVenueEnrichment,
  guessTenantByName,
  // courts + price
  getCourts,
  getPeakPrice,
  fetchPeakPrice,
  fetchAvailability,
  peakFromAvailability,
  localSlotTime,
  // name guards
  verifyTenantMatchesVenue,
  tenantNameMatch,
  // utilities / tests
  parseSlotPrice,
  nextWeekdayAt,
  nextDateFor,
  clearCache,
  BROWSER_UA,
};
