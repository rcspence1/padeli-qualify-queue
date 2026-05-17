/**
 * Place ID Backfill Module
 *
 * Populates _place_id, _google_rating, _google_review_count on listings
 * missing _place_id. Uses Google Places New API (searchText).
 *
 * Ported from Mark's place_id_backfill.py — same logic, Node.js v24+.
 *
 * Per-listing process:
 *   1. Read current meta (snapshot)
 *   2. Build text query: "{title} {address}"
 *   3. Call Places API (New) searchText with X-Goog-FieldMask
 *   4. Pick top result if name loosely matches
 *   5. POST meta update via WP REST
 *   6. Append result to log
 *
 * Env vars:
 *   GOOGLE_PLACES_API_KEY — Google Places API key
 *   PADELI_WP_USER — WP username
 *   PADELI_WP_APP_PASSWORD — WP app password
 *
 * Node.js v24+ — no external dependencies.
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://padeli.com';
const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'place-id-backfill-log.json');

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getGoogleKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('Missing GOOGLE_PLACES_API_KEY env var');
  return key.replace(/^['"]|['"]$/g, '');
}

function getWPAuth() {
  const user = process.env.PADELI_WP_USER;
  const pass = process.env.PADELI_WP_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing PADELI_WP_USER or PADELI_WP_APP_PASSWORD');
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Google Places API
// ---------------------------------------------------------------------------

/**
 * Search Google Places (New) for a venue by text query.
 * Returns top 3 results with id, displayName, formattedAddress, rating, userRatingCount, types.
 */
async function searchPlaces(query) {
  const key = getGoogleKey();
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.types',
      'Referer': 'https://padeli.com/',
      'Origin': 'https://padeli.com',
    },
    body: JSON.stringify({ textQuery: query, pageSize: 3, languageCode: 'en' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

/**
 * Search Google Places (New) with photo field mask — for discovery and photo sourcing.
 * Returns top 3 results with id, displayName, formattedAddress, photos.
 */
async function searchPlacesWithPhotos(query) {
  const key = getGoogleKey();
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.photos',
      'Referer': 'https://padeli.com/',
      'Origin': 'https://padeli.com',
    },
    body: JSON.stringify({ textQuery: query, pageSize: 3 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Name matching (from Mark's backfill script)
// ---------------------------------------------------------------------------

function normalise(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Loose name match — what fraction of query words appear in place name.
 * Returns 0-1. Mark's threshold was implicit (he took top result regardless
 * but logged the score for audit).
 */
function nameMatch(queryName, placeName) {
  const q = normalise(queryName).split(/\s+/).filter(Boolean);
  const p = new Set(normalise(placeName).split(/\s+/).filter(Boolean));
  if (!q.length || !p.size) return 0;
  const common = q.filter(w => p.has(w));
  return common.length / q.length;
}

// ---------------------------------------------------------------------------
// WP REST helpers
// ---------------------------------------------------------------------------

async function wpGet(endpoint) {
  const auth = getWPAuth();
  const res = await fetch(`${SITE_URL}${endpoint}`, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'User-Agent': 'Mozilla/5.0 (PadeliBackfill)',
    },
  });
  if (!res.ok) throw new Error(`WP GET ${res.status}: ${endpoint}`);
  return res.json();
}

async function wpPost(endpoint, data) {
  const auth = getWPAuth();
  const res = await fetch(`${SITE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (PadeliBackfill)',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP POST ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Backfill logic
// ---------------------------------------------------------------------------

/**
 * Backfill _place_id for a single listing.
 *
 * @param {number} listingId — WP listing post ID
 * @returns {object} — result with status, place_id, rating, etc.
 */
async function backfillListing(listingId) {
  // 1. Snapshot current meta
  let listing;
  try {
    listing = await wpGet(`/wp-json/wp/v2/listing/${listingId}?context=edit&_fields=id,slug,title,meta`);
  } catch (err) {
    return { id: listingId, status: 'fetch_fail', error: err.message };
  }

  const title = typeof listing.title === 'object' ? listing.title.raw || listing.title.rendered : listing.title;
  const meta = listing.meta || {};
  const address = meta._address || '';

  // Skip if already has place_id
  if (meta._place_id) {
    return { id: listingId, status: 'skipped', reason: 'has_place_id', place_id: meta._place_id };
  }

  if (!address) {
    return { id: listingId, status: 'no_address', title };
  }

  // 2-3. Search Places
  const query = `${title} ${address}`;
  let searchResult;
  try {
    searchResult = await searchPlaces(query);
  } catch (err) {
    return { id: listingId, status: 'search_error', error: err.message, title };
  }

  const places = searchResult.places || [];
  if (!places.length) {
    return { id: listingId, status: 'no_match', title };
  }

  // 4. Pick top result
  const top = places[0];
  const placeId = top.id;
  const placeName = (top.displayName || {}).text || '';
  const matchScore = nameMatch(title, placeName);
  const rating = top.rating || null;
  const reviewCount = top.userRatingCount || null;

  // 5. Write meta
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const payload = {
    meta: {
      _place_id: placeId,
      _google_last_updated: now,
    },
  };
  if (rating !== null) {
    payload.meta._google_rating = String(rating);
    payload.meta._combined_rating = String(rating);
  }
  if (reviewCount !== null) {
    payload.meta._google_review_count = String(reviewCount);
    payload.meta._combined_review_count = String(reviewCount);
  }

  try {
    await wpPost(`/wp-json/wp/v2/listing/${listingId}`, payload);
  } catch (err) {
    return { id: listingId, status: 'write_fail', error: err.message, title };
  }

  return {
    id: listingId,
    status: 'ok',
    title,
    place_id: placeId,
    rating,
    review_count: reviewCount,
    match_name: placeName,
    match_address: top.formattedAddress || '',
    match_score: matchScore,
  };
}

/**
 * Backfill place_id for multiple listings.
 *
 * @param {number[]} listingIds — array of WP listing IDs
 * @param {object} options
 * @param {number} options.delayMs — delay between listings in ms (default: 500)
 * @returns {object[]} — array of results
 */
async function backfillBatch(listingIds, options = {}) {
  const { delayMs = 500 } = options;
  const results = [];

  // Load existing log
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  }
  const done = new Set(log.filter(e => ['ok', 'skipped'].includes(e.status)).map(e => e.id));

  for (const lid of listingIds) {
    if (done.has(lid)) {
      console.log(`  ${lid}: already done, skip`);
      continue;
    }

    let result = await backfillListing(lid);

    results.push(result);
    log.push({ ...result, timestamp: new Date().toISOString() });

    const status = result.status.padEnd(15);
    const name = (result.match_name || '').substring(0, 35).padEnd(35);
    console.log(`  ${lid} ${status} ${name} score=${(result.match_score || 0).toFixed(2)} r=${result.rating || '-'}`);

    // Save log periodically
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

    // Rate limiting
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  return results;
}

/**
 * Standalone Place ID lookup — search Google Places for a venue and return
 * place_id + rating without writing to WP. Used by discovery and enrichment.
 *
 * @param {string} name — venue name
 * @param {string} address — venue address
 * @returns {object|null} — { placeId, placeName, rating, reviewCount, matchScore } or null
 */
async function lookupPlaceId(name, address) {
  const query = `${name} ${address || ''}`.trim();
  try {
    const result = await searchPlaces(query);
    const places = result.places || [];
    if (!places.length) return null;
    const top = places[0];
    return {
      placeId: top.id,
      placeName: (top.displayName || {}).text || '',
      formattedAddress: top.formattedAddress || '',
      rating: top.rating || null,
      reviewCount: top.userRatingCount || null,
      matchScore: nameMatch(name, (top.displayName || {}).text || ''),
      types: top.types || [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [,, command, ...args] = process.argv;

  const commands = {
    async lookup() {
      const name = args[0];
      const address = args[1] || '';
      if (!name) { console.log('Usage: node place-id-backfill.js lookup "Venue Name" "Address"'); process.exit(1); }
      const result = await lookupPlaceId(name, address);
      console.log(JSON.stringify(result, null, 2));
    },

    async backfill() {
      const ids = args[0];
      if (!ids) { console.log('Usage: node place-id-backfill.js backfill 123,456,789'); process.exit(1); }
      const listingIds = ids.split(',').map(Number);
      console.log(`Backfilling ${listingIds.length} listings`);
      await backfillBatch(listingIds);
    },
  };

  if (!command || !commands[command]) {
    console.log('Usage: node place-id-backfill.js <lookup|backfill> [args]');
    console.log('  lookup  "Venue Name" "Address"');
    console.log('  backfill 123,456,789');
    process.exit(1);
  }

  commands[command]().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  searchPlaces,
  searchPlacesWithPhotos,
  lookupPlaceId,
  backfillListing,
  backfillBatch,
  nameMatch,
  normalise,
};
