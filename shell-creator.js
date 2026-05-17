/**
 * Shell Creator — Creates NEW listing posts on WordPress via WP REST API
 *
 * Replaces Listeo Data Scraper Pro for listing creation.
 * Creates minimal draft "shell" listings from discovery pool data,
 * ready to be enriched by the research pipeline.
 *
 * The existing wp-payload.js module handles UPDATES to existing listings.
 * This module handles CREATION of new ones.
 *
 * Node.js v24+ (native fetch, no external deps) — CommonJS
 *
 * Env vars:
 *   PADELI_WP_USER        — WP username
 *   PADELI_WP_APP_PASSWORD — WP app password
 */

const fs = require('fs');
const path = require('path');

const SITE_URL = 'https://padeli.com';

// Duplicate detection threshold (Dice coefficient)
const SIMILARITY_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getCredentials() {
  const user = process.env.PADELI_WP_USER;
  const pass = process.env.PADELI_WP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Missing PADELI_WP_USER or PADELI_WP_APP_PASSWORD env vars');
  }
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// String Similarity (Dice coefficient via bigram overlap)
// Mirrors the implementation in discover-clubs.js
// ---------------------------------------------------------------------------

function stringSimilarity(a, b) {
  if (!a || !b) return 0;

  const normalize = (s) => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const s1 = normalize(a);
  const s2 = normalize(b);

  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bigrams = (str) => {
    const map = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const pair = str.slice(i, i + 2);
      map.set(pair, (map.get(pair) || 0) + 1);
    }
    return map;
  };

  const map1 = bigrams(s1);
  const map2 = bigrams(s2);

  let intersection = 0;
  for (const [pair, count] of map1) {
    if (map2.has(pair)) {
      intersection += Math.min(count, map2.get(pair));
    }
  }

  return (2 * intersection) / (s1.length - 1 + s2.length - 1);
}

// ---------------------------------------------------------------------------
// WP REST Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch listings from WP REST API matching a search term.
 * Returns all matches across statuses (draft, publish, pending, etc.).
 *
 * @param {string} searchTerm — name to search for
 * @returns {object[]} — array of WP listing objects
 */
async function searchListings(searchTerm) {
  const auth = getCredentials();
  const url = `${SITE_URL}/wp-json/wp/v2/listing?search=${encodeURIComponent(searchTerm)}&status=any&per_page=20`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (PadeliShellCreator)',
    },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WP REST search error ${res.status}: ${errorBody}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Duplicate Detection
// ---------------------------------------------------------------------------

/**
 * Search WP for an existing listing by name.
 * Returns the listing object if found (>85% name similarity), null otherwise.
 *
 * @param {string} name — venue name to check
 * @returns {object|null} — existing WP listing or null
 */
async function findExistingListing(name) {
  const existing = await searchListings(name);

  for (const listing of existing) {
    const wpTitle = listing.title?.rendered || listing.title?.raw || '';
    const similarity = stringSimilarity(name, wpTitle);
    if (similarity > SIMILARITY_THRESHOLD) {
      return {
        id: listing.id,
        title: wpTitle,
        slug: listing.slug,
        status: listing.status,
        similarity: Math.round(similarity * 100),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a display-quality friendly address from club data.
 * Matches the live gold standard format: "Street, City, Region Postcode, Country"
 * e.g. "Jl. Babakan Kubu, Canggu, Bali 80351, Indonesia"
 *
 * Falls back gracefully — if only city + country are available, uses those.
 */
function buildFriendlyAddress(clubData) {
  const { COUNTRY_NAMES } = require('./config');
  const parts = [];

  // Street address (extract first part before city/region repetition)
  if (clubData.address) {
    // Use full address as base — it's the most complete source
    const countryName = COUNTRY_NAMES?.[clubData.country_code] || clubData.country_code || '';
    // If address already contains the country, use it directly
    if (countryName && clubData.address.toLowerCase().includes(countryName.toLowerCase())) {
      return clubData.address;
    }
    // Otherwise build from address + country
    return countryName ? `${clubData.address}, ${countryName}` : clubData.address;
  }

  // Fallback: build from parts
  if (clubData.city) parts.push(clubData.city);
  if (clubData.region) parts.push(clubData.region);
  if (clubData.postcode) {
    // Append postcode to last part
    if (parts.length) {
      parts[parts.length - 1] += ` ${clubData.postcode}`;
    } else {
      parts.push(clubData.postcode);
    }
  }
  const countryName = COUNTRY_NAMES?.[clubData.country_code] || clubData.country_code || '';
  if (countryName) parts.push(countryName);

  return parts.join(', ') || `${clubData.city || ''}, ${clubData.country_code || ''}`;
}

// ---------------------------------------------------------------------------
// Shell Payload Builder
// ---------------------------------------------------------------------------

/**
 * Build the minimal WP REST payload for a new draft listing.
 *
 * @param {object} clubData — discovery pool data
 * @returns {object} — WP REST payload
 */
function buildShellPayload(clubData) {
  return {
    title: clubData.name,
    status: 'draft',
    content: '', // empty — filled by research pipeline
    meta: {
      _address: clubData.address || '',
      _phone: clubData.phone || '',
      _email: '',
      _website: clubData.website || '',
      _geolocation_lat: String(clubData.lat || ''),
      _geolocation_long: String(clubData.lng || ''),
      _place_id: clubData.place_id || '',
      _google_rating: String(clubData.google_rating || ''),
      _google_review_count: String(clubData.google_review_count || ''),
      _friendly_address: buildFriendlyAddress(clubData),
      _verified: '0',
    },
    listing_category: [189],  // padel-courts
    clubs_category: [135],    // padel-clubs
  };
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Create a minimal WP listing post (status: draft) from discovery pool data.
 *
 * @param {object} clubData — object with fields from discover-clubs.js output
 *   (name, address, city, country_code, lat, lng, phone, website, place_id, etc.)
 * @param {object} options
 * @returns {object} — { status, listingId?, slug?, payload?, existingId? }
 */
async function createListingShell(clubData, options = {}) {

  if (!clubData.name) {
    return { status: 'error', error: 'clubData.name is required' };
  }

  // Step 1: Duplicate check
  console.log(`[shell-creator] Checking for duplicates: "${clubData.name}"...`);
  const existing = await findExistingListing(clubData.name);

  if (existing) {
    console.log(`[shell-creator] DUPLICATE found: "${existing.title}" (ID ${existing.id}, ${existing.similarity}% match)`);
    return {
      status: 'duplicate',
      existingId: existing.id,
      existingTitle: existing.title,
      existingSlug: existing.slug,
      existingStatus: existing.status,
      similarity: existing.similarity,
    };
  }

  // Step 2: Build payload
  const payload = buildShellPayload(clubData);

  // Step 3: POST to WP REST
  console.log(`[shell-creator] CREATING listing: "${clubData.name}"...`);
  const auth = getCredentials();

  const res = await fetch(`${SITE_URL}/wp-json/wp/v2/listing`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (PadeliShellCreator)',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WP REST create error ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
  console.log(`[shell-creator] CREATED listing ${data.id}: "${clubData.name}" (slug: ${data.slug})`);

  return {
    status: 'created',
    listingId: data.id,
    slug: data.slug,
  };
}

/**
 * Create shells for an array of clubs from discovery output.
 *
 * @param {object[]} clubs — array of club objects from discover-clubs.js
 * @param {object} options
 * @param {number} options.delayMs — ms between creates (default 1000)
 * @returns {object[]} — array of results for each club
 */
async function createBatchShells(clubs, options = {}) {
  const delayMs = options.delayMs || 1000;

  console.log(`\n[shell-creator] Batch: ${clubs.length} clubs, mode: LIVE`);
  console.log(`[shell-creator] Delay between creates: ${delayMs}ms\n`);

  const results = [];

  for (let i = 0; i < clubs.length; i++) {
    const club = clubs[i];
    console.log(`[shell-creator] [${i + 1}/${clubs.length}] ${club.name}`);

    try {
      const result = await createListingShell(club);
      results.push({ name: club.name, ...result });
    } catch (err) {
      console.error(`[shell-creator] ERROR on "${club.name}": ${err.message}`);
      results.push({ name: club.name, status: 'error', error: err.message });
    }

    // Delay between requests (skip after last item)
    if (i < clubs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Summary
  const created = results.filter((r) => r.status === 'created').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log(`\n[shell-creator] Batch complete:`);
  console.log(`  Created:    ${created}`);
  console.log(`  Duplicates: ${duplicates}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Errors:     ${errors}`);

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [,, command, ...args] = process.argv;
  const cleanArgs = args;

  const commands = {
    async create() {
      const name = cleanArgs[0];
      const address = cleanArgs[1] || '';
      const countryCode = cleanArgs[2] || '';

      if (!name) {
        console.log('Usage: node shell-creator.js create "Venue Name" "Full Address" [CC]');
        console.log('  CC = country code (e.g. GB, ES, SE). Optional.');
        process.exit(1);
      }

      // Parse city from address (last part before country, or second-to-last comma segment)
      const addressParts = address.split(',').map((s) => s.trim());
      const city = addressParts.length >= 2
        ? addressParts[addressParts.length - 2]
        : addressParts[0] || '';

      const clubData = {
        name,
        address,
        city,
        country_code: countryCode,
      };

      const result = await createListingShell(clubData);
      console.log('\nResult:');
      console.log(JSON.stringify(result, null, 2));
    },

    async batch() {
      const filePath = cleanArgs[0];

      if (!filePath) {
        console.log('Usage: node shell-creator.js batch /path/to/clubs.json');
        console.log('  Input: JSON array of club objects (from discover-clubs.js output)');
        process.exit(1);
      }

      const absPath = path.resolve(filePath);
      if (!fs.existsSync(absPath)) {
        console.error(`File not found: ${absPath}`);
        process.exit(1);
      }

      const clubs = JSON.parse(fs.readFileSync(absPath, 'utf8'));

      if (!Array.isArray(clubs)) {
        console.error('Input file must contain a JSON array of club objects');
        process.exit(1);
      }

      const results = await createBatchShells(clubs);
      console.log('\nResults:');
      console.log(JSON.stringify(results, null, 2));
    },

    async check() {
      const name = cleanArgs[0];

      if (!name) {
        console.log('Usage: node shell-creator.js check "Venue Name"');
        console.log('  Checks if a listing with this name already exists on WP.');
        process.exit(1);
      }

      const existing = await findExistingListing(name);

      if (existing) {
        console.log(`DUPLICATE FOUND:`);
        console.log(JSON.stringify(existing, null, 2));
      } else {
        console.log(`No existing listing found for "${name}" — safe to create.`);
      }
    },
  };

  if (!command || !commands[command]) {
    console.log('Shell Creator — Create new WP listing drafts from discovery data\n');
    console.log('Usage: node shell-creator.js <command> [args]\n');
    console.log('Commands:');
    console.log('  create "Venue Name" "Full Address" [CC]  — Create a single listing shell');
    console.log('  batch  /path/to/clubs.json               — Batch create from JSON file');
    console.log('  check  "Venue Name"                               — Check for duplicates only');
    process.exit(1);
  }

  commands[command]().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Venue Validation Gate
// ---------------------------------------------------------------------------

// Sports-related Google Place types that indicate a real venue
const SPORTS_TYPES = new Set([
  'sports_complex', 'sports_club', 'sports_activity_location',
  'gym', 'stadium', 'health', 'fitness_center',
  'recreation_center', 'athletic_field'
]);

/**
 * Validate whether a club entry is a real physical venue worth listing.
 *
 * Community groups, casual Playtomic tenants, and junk entries get filtered.
 * Returns { valid: true/false, reason, signals } — the pipeline should skip
 * venues that fail and mark them as 'not_a_venue' in the master sheet.
 *
 * A venue passes if it scores >= 2 out of 4 signals:
 *   1. Google Place ID matches a sports-related type
 *   2. Has a website
 *   3. Has a phone number
 *   4. Has a Google rating with reviews
 *
 * @param {object} clubData — from master sheet or discovery
 * @param {object} placeResult — from lookupPlaceId() (can be null)
 * @returns {object} { valid, score, signals, reason }
 */
function validateVenue(clubData, placeResult) {
  const signals = [];
  let score = 0;

  // Signal 1: Google Place ID with sports-related type
  if (placeResult && placeResult.placeId && placeResult.types) {
    const hasSportsType = placeResult.types.some(t => SPORTS_TYPES.has(t));
    if (hasSportsType && placeResult.matchScore > 0.3) {
      score++;
      signals.push('google_sports_venue');
    } else {
      signals.push('google_no_sports_type');
    }
  } else {
    signals.push('no_google_place');
  }

  // Signal 2: Has a website
  if (clubData.website && clubData.website.trim()) {
    score++;
    signals.push('has_website');
  } else {
    signals.push('no_website');
  }

  // Signal 3: Has a phone number
  if (clubData.phone && clubData.phone.trim()) {
    score++;
    signals.push('has_phone');
  } else {
    signals.push('no_phone');
  }

  // Signal 4: Has Google rating with reviews
  if (placeResult && placeResult.rating && placeResult.reviewCount > 0) {
    score++;
    signals.push('has_reviews');
  } else {
    signals.push('no_reviews');
  }

  const valid = score >= 2;
  const reason = valid
    ? `Passed venue validation (${score}/4 signals)`
    : `Failed venue validation (${score}/4 signals: ${signals.join(', ')}). Likely a community group or casual Playtomic tenant, not a physical venue.`;

  console.log(`[venue-gate] "${clubData.name}": ${valid ? 'PASS' : 'FAIL'} (${score}/4) — ${signals.join(', ')}`);

  return { valid, score, signals, reason };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createListingShell,
  createBatchShells,
  findExistingListing,
  buildShellPayload,
  stringSimilarity,
  searchListings,
  validateVenue,
};
