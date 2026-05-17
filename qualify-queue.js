/**
 * Qualify Queue — 10-Layer Pre-Qualification System for Padeli Listings
 *
 * Takes "Discovered" venues from the Notion Club Tracker and runs them
 * through 10 validation/enrichment layers before they enter the listing
 * pipeline. Filters junk, detects duplicates, verifies data sources,
 * scores completeness, and assigns priority.
 *
 * Layers:
 *   1. Internal duplicate detection (Playtomic ID, coordinates, website)
 *   2. WP duplicate detection (already-published listings)
 *   3. Name cleaning (strip suffixes, fix caps, flag junk)
 *   4. Playtomic verification (active courts, surfaces, images)
 *   5. Google Places verification (place ID, rating, reviews)
 *   6. Website check (live site, padel content, equipment shop filter)
 *   7. Geography validation (bounding box, Arabic city names)
 *   8. Completeness scoring (0-10 data quality)
 *   9. Brand detection (chain/franchise grouping)
 *  10. Priority scoring (0-100 composite rank)
 *
 * Usage:
 *   const { qualifyCountry, qualifySingle } = require('./qualify-queue');
 *   const summary = await qualifyCountry('AE');
 *   const result = await qualifySingle('notion-page-id-here');
 *
 * CLI:
 *   node lib/qualify-queue.js AE
 *   node lib/qualify-queue.js AE --dry-run
 *   node lib/qualify-queue.js AE --limit 10
 *   node lib/qualify-queue.js AE --skip-website
 *   node lib/qualify-queue.js single <notion-page-id>
 *
 * Node.js v24+ — zero external dependencies. CommonJS.
 */

const { stringSimilarity, searchListings } = require('./shell-creator');
const { fetchPlaytomicTenant } = require('./discover-clubs');
const { lookupPlaceId } = require('./place-id-backfill');
const { prefetchWebsite } = require('./site-renderer');

// ─── Constants ──────────────────────────────────────────────────────────────

const CLUB_TRACKER_DB = '35bd1b51-fb30-8106-a719-ec603a1a3616';
const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Playtomic catch-all tenant IDs — match ANY search query, not real venues.
// Detected via scripts/scan-catchall-tenants.js — any tenant appearing 10+ times
// across unrelated venues in a country is a catch-all/default fallback.
const PLAYTOMIC_CATCHALL_TENANTS = new Set([
  // Global / AU
  '019d46ee-b610-4a12-8344-7e839e03b1a7',  // AU catch-all (190 venues)
  '405a3ba5-7f95-429a-b56e-14353a3644d9',   // AU partial-match ("hi")
  '2eb9fb08-3810-4359-81e5-057eff5f619f',   // AU partial-match ("ass")
  'f513e906-c84e-454a-aee8-71a7ac43c3f8',   // AU partial-match ("f")
  '0109adc4-8d51-437f-9dd0-c13f9fb5fd91',   // AU partial-match ("HV")
  '637727e9-57b5-4485-8faa-ec57d2726382',   // AU partial-match ("Bounce")
  // AE
  '91474bfc-57ee-4c11-bda3-1bb091710f4d',   // AE catch-all (95 venues)
  // ES
  '0ce49dbf-e3e3-4edb-8507-52fa96374af6',   // ES catch-all (494 venues, 130 cities)
  // IT
  '6067a366-c543-45eb-8b8b-bdc7a7993d3a',   // IT catch-all (219 venues, 96 cities)
  '01a12b00-e3c3-4dfd-a5f7-96895de801ad',   // IT catch-all (97 venues, tennis fallback)
  'a543da48-cf21-49be-a3d4-d7595501990a',   // IT catch-all (38 venues)
  // FR
  '8296aacd-f97e-47a8-852d-e6253fc92b97',   // FR catch-all (46 venues)
  'e9fe470e-c819-4f57-a9c1-3009e05de1bb',   // FR catch-all (46 venues)
  // US
  'dedf9203-31ee-4f21-99b4-9b54df20e4a0',   // US catch-all (36 venues)
  '0f2f5dfe-907e-42d0-9b5b-ef460c052b90',   // US catch-all (14 venues)
  // DE
  'a4a73583-1ec9-48df-8f2b-a764c42c5826',   // DE catch-all (23 venues)
  '473a9387-3c4d-4f0d-813a-9da45976e3b7',   // DE catch-all (17 venues)
  '7f01aae5-8e69-42c4-9dcb-08ee801516ab',   // DE catch-all (16 venues)
  // ID
  '4ae8ff7b-251f-4d9f-990b-18d84bc67ee6',   // ID catch-all (16 venues)
  // IT (smaller)
  '31acfd90-e1bc-41b1-b80d-76fe3d7ee8a0',   // IT catch-all (14 venues)
  '487aaf5d-5fa9-4320-a430-f910d0cdff31',   // IT catch-all (12 venues)
  '29486a34-4647-48e3-98c8-4001497887a1',   // IT catch-all (10 venues)
]);

// Keywords that indicate a venue is NOT a padel venue
const NON_PADEL_KEYWORDS = [
  'bowling', 'tenpin', 'ten pin', 'bowls', 'lawn bowls',
  'golf', 'golf club', 'golf course',
  'pistol', 'gun club', 'rifle', 'shooting',
  'canoe', 'kayak', 'outrigger', 'paddlers',
  'bridge club', 'bridge association',
  'rsl', 'ex-services', 'ex-service', 'leagues club',
  'athletics', 'athletic club', 'little athletics',
  'cycling', 'bmx', 'mountain bike',
  'swimming', 'aquatic', 'waves',
  'paintball', 'laser tag',
  'intersport', 'rebel sport',
  'mallet sports', 'croquet',
  'equestrian', 'horse', 'pony club',
  'sailing', 'yacht',
  'rowing', 'dragon boat',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Strip catch-all Playtomic tenant IDs — these match any search and aren't real venues.
 * Returns null if the value contains a catch-all tenant ID, otherwise returns the original.
 */
function stripCatchallTenant(value) {
  if (!value) return null;
  for (const id of PLAYTOMIC_CATCHALL_TENANTS) {
    if (value.includes(id)) return null;
  }
  return value;
}

/**
 * Check if a venue name suggests it's NOT a padel venue.
 * Returns { isNonPadel: true, reason } or { isNonPadel: false }.
 */
function checkNonPadelVenue(name, website) {
  if (!name) return { isNonPadel: false };
  const lower = name.toLowerCase();

  // If the name contains "padel" anywhere, it's likely a padel venue — skip filter
  if (/padel/i.test(lower)) return { isNonPadel: false };

  // Check against non-padel keywords
  for (const keyword of NON_PADEL_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { isNonPadel: true, reason: `Non-padel venue (matched: "${keyword}")` };
    }
  }

  return { isNonPadel: false };
}

// ─── Notion API Helpers ─────────────────────────────────────────────────────

function notionHeaders() {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY not set');
  return {
    'Authorization': `Bearer ${key}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionFetch(urlPath, options = {}) {
  const url = urlPath.startsWith('http') ? urlPath : `${NOTION_BASE}${urlPath}`;
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: { ...notionHeaders(), ...(options.headers || {}) },
    });
    if (res.status === 429) {
      const wait = Math.max(parseInt(res.headers.get('retry-after') || '2', 10), 1) * 1000;
      console.log(`  [qualify] Rate limited — waiting ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Notion ${res.status}: ${body.message || JSON.stringify(body)}`);
    }
    return body;
  }
  throw new Error('Notion rate limit exceeded after retries');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Haversine Distance ─────────────────────────────────────────────────────

function haversineMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Geography Constants ────────────────────────────────────────────────────

const COUNTRY_BOUNDS = {
  AE: { minLat: 22.6, maxLat: 26.1, minLng: 51.5, maxLng: 56.4 },
  GB: { minLat: 49.9, maxLat: 60.9, minLng: -8.6, maxLng: 1.8 },
  AU: { minLat: -44.0, maxLat: -10.0, minLng: 112.0, maxLng: 154.0 },
  ES: { minLat: 27.6, maxLat: 43.8, minLng: -18.2, maxLng: 4.3 },
  US: { minLat: 24.5, maxLat: 49.4, minLng: -125.0, maxLng: -66.9 },
  ID: { minLat: -11.0, maxLat: 6.1, minLng: 95.0, maxLng: 141.0 },
  SE: { minLat: 55.3, maxLat: 69.1, minLng: 11.1, maxLng: 24.2 },
  TH: { minLat: 5.6, maxLat: 20.5, minLng: 97.3, maxLng: 105.6 },
  PT: { minLat: 32.6, maxLat: 42.2, minLng: -31.3, maxLng: -6.2 },
  IT: { minLat: 35.5, maxLat: 47.1, minLng: 6.6, maxLng: 18.5 },
  FR: { minLat: 41.3, maxLat: 51.1, minLng: -5.1, maxLng: 9.6 },
  DE: { minLat: 47.3, maxLat: 55.1, minLng: 5.9, maxLng: 15.0 },
};

const CITY_NAMES = {
  'دبي': 'Dubai', 'أبو ظبي': 'Abu Dhabi', 'أبوظبي': 'Abu Dhabi',
  'الشارقة': 'Sharjah', 'عجمان': 'Ajman', 'رأس الخيمة': 'Ras Al Khaimah',
  'العين': 'Al Ain', 'الفجيرة': 'Fujairah', 'أم القيوين': 'Umm Al Quwain',
};

// ─── Brand Detection Constants ──────────────────────────────────────────────

const BRAND_PREFIXES = [
  'Just Padel', 'Game4Padel', 'ESS Padel', "Let's Padel", 'Padel Social',
  'We Are Padel', 'World Padel', 'Padelz', 'Padel Nation', 'Padel Point',
  'XPark Padel', 'Padel House', 'The Padel Club', 'Pure Padel', 'Padel Factory',
];

// ─── Notion Query Helpers ───────────────────────────────────────────────────

/**
 * Query all "Discovered" venues in a country from the Club Tracker.
 * Paginates through all results (Notion caps at 100 per page).
 */
async function queryDiscoveredVenues(countryCode) {
  const allPages = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const body = {
      filter: {
        and: [
          { property: 'Status', select: { equals: 'Discovered' } },
          { property: 'Country', select: { equals: countryCode.toUpperCase() } },
        ],
      },
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionFetch(`/databases/${CLUB_TRACKER_DB}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    allPages.push(...result.results);
    hasMore = result.has_more;
    startCursor = result.next_cursor;

    if (hasMore) await sleep(300);
  }

  return allPages;
}

/**
 * Extract a flat venue object from a Notion page's properties.
 * Handles the various Notion property types gracefully.
 */
function extractVenue(page) {
  const p = page.properties || {};

  const getText = (prop) => {
    if (!prop) return null;
    if (prop.type === 'rich_text' && prop.rich_text?.length) return prop.rich_text[0].plain_text;
    if (prop.type === 'title' && prop.title?.length) return prop.title[0].plain_text;
    if (prop.type === 'url') return prop.url;
    return null;
  };

  const getNumber = (prop) => {
    if (!prop || prop.type !== 'number') return null;
    return prop.number;
  };

  const getSelect = (prop) => {
    if (!prop || prop.type !== 'select' || !prop.select) return null;
    return prop.select.name;
  };

  // Parse coordinates from "lat, lng" string
  const coordsRaw = getText(p['Coordinates']);
  let lat = null, lng = null;
  if (coordsRaw) {
    const parts = coordsRaw.split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      lat = parts[0];
      lng = parts[1];
    }
  }

  return {
    pageId: page.id,
    name: getText(p['Name']) || getText(p['Venue Name']) || '',
    country: getSelect(p['Country']) || '',
    city: getText(p['City']) || '',
    address: getText(p['Address']) || '',
    coordinates: coordsRaw || '',
    lat,
    lng,
    website: getText(p['Website']) || null,
    phone: getText(p['Phone']) || null,
    playtomicId: stripCatchallTenant(getText(p['Playtomic ID'])),
    playtomicUrl: stripCatchallTenant(getText(p['Playtomic URL'])),
    googlePlaceId: getText(p['Google Place ID']) || null,
    googleRating: getNumber(p['Google Rating']),
    googleReviews: getNumber(p['Google Reviews']),
    courts: getNumber(p['Courts']),
    source: getSelect(p['Source']) || getText(p['Source']) || '',
    photos: getNumber(p['Photos']) || 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: Internal Duplicate Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect duplicates within the discovered venue batch itself.
 * Groups by: Playtomic ID, proximity + name similarity, website URL.
 */
function detectInternalDuplicates(venues) {
  const results = venues.map(v => ({
    pageId: v.pageId,
    isDuplicate: false,
    duplicateOf: null,
    reason: null,
  }));
  const resultMap = new Map(results.map(r => [r.pageId, r]));

  // Count non-null fields for "most data" tiebreaker
  const fieldCount = (v) => {
    let count = 0;
    if (v.name) count++;
    if (v.address) count++;
    if (v.city) count++;
    if (v.website) count++;
    if (v.phone) count++;
    if (v.lat && v.lng) count++;
    if (v.playtomicId) count++;
    if (v.googlePlaceId) count++;
    if (v.courts) count++;
    if (v.photos) count++;
    return count;
  };

  // --- Group by Playtomic ID ---
  const byPlaytomic = new Map();
  for (const v of venues) {
    if (!v.playtomicId) continue;
    if (!byPlaytomic.has(v.playtomicId)) byPlaytomic.set(v.playtomicId, []);
    byPlaytomic.get(v.playtomicId).push(v);
  }
  for (const [, group] of byPlaytomic) {
    if (group.length < 2) continue;
    // Keep the one with most data
    group.sort((a, b) => fieldCount(b) - fieldCount(a));
    const keeper = group[0];
    for (let i = 1; i < group.length; i++) {
      const r = resultMap.get(group[i].pageId);
      r.isDuplicate = true;
      r.duplicateOf = keeper.pageId;
      r.reason = `Duplicate Playtomic ID: ${group[i].playtomicId}`;
    }
  }

  // --- Group by coordinates (within 250m) + name similarity ---
  // Two tiers: within 100m needs 50% name match, 100-250m needs 70% match
  const withCoords = venues.filter(v => v.lat && v.lng && !resultMap.get(v.pageId).isDuplicate);
  for (let i = 0; i < withCoords.length; i++) {
    if (resultMap.get(withCoords[i].pageId).isDuplicate) continue;
    for (let j = i + 1; j < withCoords.length; j++) {
      if (resultMap.get(withCoords[j].pageId).isDuplicate) continue;
      const dist = haversineMetres(withCoords[i].lat, withCoords[i].lng, withCoords[j].lat, withCoords[j].lng);
      if (dist <= 250) {
        const sim = stringSimilarity(withCoords[i].name, withCoords[j].name);
        const threshold = dist <= 100 ? 0.50 : 0.70;
        if (sim > threshold) {
          const keepIdx = fieldCount(withCoords[i]) >= fieldCount(withCoords[j]) ? i : j;
          const dropIdx = keepIdx === i ? j : i;
          const r = resultMap.get(withCoords[dropIdx].pageId);
          r.isDuplicate = true;
          r.duplicateOf = withCoords[keepIdx].pageId;
          r.reason = `Within ${Math.round(dist)}m, name similarity ${(sim * 100).toFixed(0)}%`;
        }
      }
    }
  }

  // --- Fuzzy name clustering within same city ---
  // Catches venues like "XPark Padel Dubai" vs "X Park Padel - Dubai Marina"
  const byCity = new Map();
  for (const v of venues) {
    if (resultMap.get(v.pageId).isDuplicate) continue;
    const city = (v.city || '').toLowerCase().trim();
    if (!city) continue;
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(v);
  }
  for (const [, cityVenues] of byCity) {
    if (cityVenues.length < 2) continue;
    for (let i = 0; i < cityVenues.length; i++) {
      if (resultMap.get(cityVenues[i].pageId).isDuplicate) continue;
      for (let j = i + 1; j < cityVenues.length; j++) {
        if (resultMap.get(cityVenues[j].pageId).isDuplicate) continue;
        const sim = stringSimilarity(cityVenues[i].name, cityVenues[j].name);
        if (sim > 0.80) {
          const keepIdx = fieldCount(cityVenues[i]) >= fieldCount(cityVenues[j]) ? i : j;
          const dropIdx = keepIdx === i ? j : i;
          const r = resultMap.get(cityVenues[dropIdx].pageId);
          r.isDuplicate = true;
          r.duplicateOf = cityVenues[keepIdx].pageId;
          r.reason = `Same city, name similarity ${(sim * 100).toFixed(0)}%`;
        }
      }
    }
  }

  // --- Group by website URL ---
  const byWebsite = new Map();
  for (const v of venues) {
    if (!v.website || resultMap.get(v.pageId).isDuplicate) continue;
    const normalUrl = v.website.toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
    if (!byWebsite.has(normalUrl)) byWebsite.set(normalUrl, []);
    byWebsite.get(normalUrl).push(v);
  }
  for (const [, group] of byWebsite) {
    if (group.length < 2) continue;
    group.sort((a, b) => fieldCount(b) - fieldCount(a));
    const keeper = group[0];
    for (let i = 1; i < group.length; i++) {
      if (resultMap.get(group[i].pageId).isDuplicate) continue;
      const r = resultMap.get(group[i].pageId);
      r.isDuplicate = true;
      r.duplicateOf = keeper.pageId;
      r.reason = `Same website: ${group[i].website}`;
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2: WordPress Duplicate Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check each venue against existing WordPress listings.
 * Uses searchListings() from shell-creator.js and fuzzy name matching.
 */
async function detectWPDuplicates(venues) {
  const results = [];

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const entry = { pageId: v.pageId, isDuplicate: false, existingWpId: null, existingTitle: null };

    try {
      const matches = await searchListings(v.name);
      if (matches && matches.length > 0) {
        for (const m of matches) {
          const wpTitle = typeof m.title === 'object' ? (m.title.rendered || m.title.raw || '') : (m.title || '');
          const sim = stringSimilarity(v.name, wpTitle);
          if (sim > 0.85) {
            entry.isDuplicate = true;
            entry.existingWpId = m.id;
            entry.existingTitle = wpTitle;
            break;
          }
        }
      }
    } catch (err) {
      // WP search failed — skip, don't crash
      console.log(`  [qualify] WP search failed for "${v.name}": ${err.message}`);
    }

    results.push(entry);

    // Rate limit + progress
    if (i > 0 && i % 10 === 0) console.log(`  [qualify]   ...checked ${i}/${venues.length} against WP`);
    await sleep(200);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3: Name Cleaning
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clean venue names: strip source suffixes, fix all-caps, flag junk.
 */
function cleanNames(venues) {
  const SOURCE_SUFFIXES = [' - Playtomic', ' - Matchi', ' - Google'];
  const JUNK_NAMES = ['padel', 'club', 'sports', 'sport', 'tennis', 'center', 'centre'];
  // Playtomic sandbox/test tenants — always exclude
  const BLOCKLIST_PATTERNS = [/anemone/i, /test\s*tenant/i, /demo\s*club/i, /sandbox/i];

  return venues.map(v => {
    let cleaned = v.name || '';
    const original = cleaned;

    // Strip source suffixes
    for (const suffix of SOURCE_SUFFIXES) {
      if (cleaned.toLowerCase().endsWith(suffix.toLowerCase())) {
        cleaned = cleaned.slice(0, -suffix.length).trim();
      }
    }

    // Fix all-caps: if every letter is uppercase and name has 4+ chars, title-case it
    if (cleaned.length >= 4 && cleaned === cleaned.toUpperCase() && /[A-Z]/.test(cleaned)) {
      cleaned = cleaned.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    // Flag junk names
    let isJunk = false;
    let reason = null;

    // Check blocklist first (ANEMONE sandboxes, test tenants, etc.)
    if (BLOCKLIST_PATTERNS.some(p => p.test(cleaned))) {
      isJunk = true;
      reason = `Blocklisted pattern: "${cleaned}"`;
    } else if (cleaned.length < 4) {
      isJunk = true;
      reason = `Name too short: "${cleaned}"`;
    } else {
      const words = cleaned.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(Boolean);
      if (words.length > 0 && words.every(w => JUNK_NAMES.includes(w))) {
        isJunk = true;
        reason = `Generic name only: "${cleaned}"`;
      }
    }

    // Non-padel venue filter — bowling alleys, golf clubs, pistol clubs, etc.
    if (!isJunk) {
      const nonPadel = checkNonPadelVenue(cleaned, v.website);
      if (nonPadel.isNonPadel) {
        isJunk = true;
        reason = nonPadel.reason;
      }
    }

    return { pageId: v.pageId, originalName: original, cleanedName: cleaned, isJunk, reason };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4: Playtomic Verification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify each venue's Playtomic data by calling the Playtomic API.
 * Extracts court count, surfaces, indoor/outdoor, images, booking type.
 */
async function checkPlaytomic(venues) {
  const results = [];
  const toCheck = venues.filter(v => v.playtomicId);

  for (let i = 0; i < toCheck.length; i++) {
    const v = toCheck[i];
    const entry = {
      pageId: v.pageId,
      playtomicActive: false,
      verifiedCourts: null,
      surfaces: null,
      indoorOutdoor: null,
      images: 0,
      bookingType: null,
      enrichment: null,
    };

    try {
      const tenant = await fetchPlaytomicTenant(v.playtomicId);
      if (tenant) {
        const isActive = tenant.playtomic_status === 'ACTIVE' || tenant.playtomic_status === 'PUBLISHED';
        entry.playtomicActive = isActive;
        entry.verifiedCourts = tenant.courts || null;
        entry.surfaces = tenant.surface_type || null;
        entry.indoorOutdoor = tenant.indoor_outdoor || null;
        entry.images = (tenant.images || []).length;
        entry.bookingType = tenant.booking_type || null;
        entry.enrichment = tenant;
      }
    } catch (err) {
      console.log(`  [qualify] Playtomic check failed for ${v.playtomicId}: ${err.message}`);
    }

    results.push(entry);

    // Rate limit + progress
    if (i > 0 && i % 10 === 0) console.log(`  [qualify]   ...checked ${i}/${toCheck.length} Playtomic tenants`);
    await sleep(500);
  }

  // Add empty entries for venues without Playtomic IDs
  const checkedIds = new Set(toCheck.map(v => v.pageId));
  for (const v of venues) {
    if (!checkedIds.has(v.pageId)) {
      results.push({
        pageId: v.pageId,
        playtomicActive: false,
        verifiedCourts: null,
        surfaces: null,
        indoorOutdoor: null,
        images: 0,
        bookingType: null,
        enrichment: null,
      });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5: Google Places Verification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Look up each venue in Google Places to verify existence, get rating/reviews.
 */
async function checkGooglePlaces(venues) {
  const results = [];
  const SPORTS_TYPES = [
    'sports_complex', 'sports_club', 'gym', 'stadium', 'recreation_center',
    'fitness_center', 'athletic_field', 'health_club',
  ];

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const entry = {
      pageId: v.pageId,
      hasGooglePlace: false,
      placeId: null,
      rating: null,
      reviewCount: null,
      isSportsType: false,
      matchScore: 0,
    };

    try {
      const result = await lookupPlaceId(v.name, v.address || v.city);
      if (result) {
        entry.hasGooglePlace = true;
        entry.placeId = result.placeId;
        entry.rating = result.rating;
        entry.reviewCount = result.reviewCount;
        entry.matchScore = result.matchScore || 0;
        entry.isSportsType = (result.types || []).some(t => SPORTS_TYPES.includes(t));
      }
    } catch (err) {
      console.log(`  [qualify] Google Places failed for "${v.name}": ${err.message}`);
    }

    results.push(entry);

    // Rate limit + progress
    if (i > 0 && i % 10 === 0) console.log(`  [qualify]   ...checked ${i}/${venues.length} Google Places`);
    await sleep(200);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5b: Google Place ID Deduplication
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After Google Places lookup, group venues by Place ID.
 * Multiple Notion entries with the same Google Place ID = same real venue.
 * Keeps the one with the most data, marks others as duplicates.
 */
function deduplicateByPlaceId(venues, layer5Results) {
  const placeMap = new Map(); // placeId → [{ venue, layer5Result }]

  for (const v of venues) {
    const l5 = layer5Results.find(r => r.pageId === v.pageId);
    if (!l5 || !l5.placeId) continue;
    if (!placeMap.has(l5.placeId)) placeMap.set(l5.placeId, []);
    placeMap.get(l5.placeId).push({ venue: v, l5 });
  }

  const results = venues.map(v => ({
    pageId: v.pageId,
    isDuplicate: false,
    duplicateOf: null,
    reason: null,
  }));
  const resultMap = new Map(results.map(r => [r.pageId, r]));

  const fieldCount = (v) => {
    let count = 0;
    if (v.name) count++;
    if (v.address) count++;
    if (v.city) count++;
    if (v.website) count++;
    if (v.phone) count++;
    if (v.lat && v.lng) count++;
    if (v.playtomicId) count++;
    if (v.courts) count++;
    if (v.photos) count++;
    return count;
  };

  for (const [placeId, group] of placeMap) {
    if (group.length < 2) continue;
    // Keep the one with most data
    group.sort((a, b) => fieldCount(b.venue) - fieldCount(a.venue));
    const keeper = group[0];
    for (let i = 1; i < group.length; i++) {
      const r = resultMap.get(group[i].venue.pageId);
      r.isDuplicate = true;
      r.duplicateOf = keeper.venue.pageId;
      r.reason = `Same Google Place ID: ${placeId}`;
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 6: Website Check
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if venue websites are live and contain padel-related content.
 * Classifies as venue site vs equipment shop.
 */
async function checkWebsites(venues) {
  const results = [];
  const PADEL_WORDS = ['padel', 'paddle tennis', 'court', 'book a court', 'play', 'coaching', 'lesson'];
  const SHOP_WORDS = ['shop', 'buy', 'racket', 'racquet', 'price', 'add to cart', 'checkout'];
  const VENUE_WORDS = ['court', 'book a court', 'play', 'coaching', 'membership'];

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    const entry = {
      pageId: v.pageId,
      websiteLive: false,
      hasPadelContent: false,
      isEquipmentShop: false,
      websiteStatus: null,
    };

    if (!v.website) {
      entry.websiteStatus = 'no-url';
      results.push(entry);
      continue;
    }

    try {
      const site = await prefetchWebsite(v.website);
      if (site.error) {
        entry.websiteStatus = site.error;
      } else {
        entry.websiteLive = true;
        entry.websiteStatus = 'live';

        // Combine all page content for keyword analysis
        const allContent = Object.values(site.pages || {}).join(' ').toLowerCase() + ' ' + (site.content || '').toLowerCase();

        entry.hasPadelContent = PADEL_WORDS.some(w => allContent.includes(w));

        // Equipment shop detection: has shop words but lacks venue words
        const hasShopWords = SHOP_WORDS.some(w => allContent.includes(w));
        const hasVenueWords = VENUE_WORDS.some(w => allContent.includes(w));
        entry.isEquipmentShop = hasShopWords && !hasVenueWords;
      }
    } catch (err) {
      entry.websiteStatus = `error: ${err.message}`;
    }

    results.push(entry);

    // Rate limit + progress
    if (i > 0 && i % 10 === 0) console.log(`  [qualify]   ...checked ${i}/${venues.length} websites`);
    await sleep(1000);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 7: Geography Validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate that venue coordinates fall within the expected country bounds.
 * Also translates Arabic city names to English where applicable.
 */
function validateGeography(venues) {
  return venues.map(v => {
    const entry = { pageId: v.pageId, inBounds: null, cityEnglish: null, flagged: false, reason: null };

    // Arabic city name translation
    const cityRaw = v.city || '';
    entry.cityEnglish = CITY_NAMES[cityRaw] || cityRaw || null;

    // Also check address for Arabic city names
    if (!entry.cityEnglish || entry.cityEnglish === cityRaw) {
      const addr = v.address || '';
      for (const [arabic, english] of Object.entries(CITY_NAMES)) {
        if (addr.includes(arabic)) {
          entry.cityEnglish = english;
          break;
        }
      }
    }

    // Bounding box check
    if (v.lat && v.lng && v.country) {
      const bounds = COUNTRY_BOUNDS[v.country.toUpperCase()];
      if (bounds) {
        const inBounds = v.lat >= bounds.minLat && v.lat <= bounds.maxLat &&
                         v.lng >= bounds.minLng && v.lng <= bounds.maxLng;
        entry.inBounds = inBounds;
        if (!inBounds) {
          entry.flagged = true;
          entry.reason = `Coordinates (${v.lat}, ${v.lng}) outside ${v.country} bounds`;
        }
      } else {
        // No bounds defined for this country — skip check
        entry.inBounds = null;
      }
    } else {
      entry.inBounds = null;
    }

    return entry;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 8: Completeness Scoring
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a 0-10 data completeness score for each venue based on available fields.
 */
function scoreCompleteness(venues, layerResults) {
  const { layer3, layer4, layer5, layer6 } = layerResults;

  // Build lookup maps by pageId
  const nameMap = new Map((layer3 || []).map(r => [r.pageId, r]));
  const playtomicMap = new Map((layer4 || []).map(r => [r.pageId, r]));
  const googleMap = new Map((layer5 || []).map(r => [r.pageId, r]));
  const websiteMap = new Map((layer6 || []).map(r => [r.pageId, r]));

  return venues.map(v => {
    let score = 0;
    const breakdown = [];

    // Has name (not junk) → 1pt
    const nameResult = nameMap.get(v.pageId);
    if (nameResult && !nameResult.isJunk && v.name) {
      score += 1;
      breakdown.push('name');
    }

    // Has coordinates → 1pt
    if (v.lat && v.lng) {
      score += 1;
      breakdown.push('coordinates');
    }

    // Has website (and it's live) → 1pt
    const webResult = websiteMap.get(v.pageId);
    if (v.website && webResult && webResult.websiteLive) {
      score += 1;
      breakdown.push('website-live');
    }

    // Has phone → 1pt
    if (v.phone) {
      score += 1;
      breakdown.push('phone');
    }

    // Has Playtomic with active courts → 2pts
    const ptResult = playtomicMap.get(v.pageId);
    if (ptResult && ptResult.playtomicActive && ptResult.verifiedCourts) {
      score += 2;
      breakdown.push('playtomic-active');
    }

    // Has Google Place with rating → 1pt
    const gResult = googleMap.get(v.pageId);
    if (gResult && gResult.hasGooglePlace && gResult.rating) {
      score += 1;
      breakdown.push('google-place');
    }

    // Has photos from any source → 1pt
    if (v.photos > 0 || (ptResult && ptResult.images > 0)) {
      score += 1;
      breakdown.push('photos');
    }

    // Has court count → 1pt
    if (v.courts || (ptResult && ptResult.verifiedCourts)) {
      score += 1;
      breakdown.push('courts');
    }

    // Has address/city → 1pt
    if (v.address || v.city) {
      score += 1;
      breakdown.push('address');
    }

    return { pageId: v.pageId, score, breakdown };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 9: Brand Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect brand/franchise affiliation based on venue name prefixes.
 */
function detectBrands(venues) {
  return venues.map(v => {
    const nameLower = (v.name || '').toLowerCase();
    let brand = null;

    for (const prefix of BRAND_PREFIXES) {
      if (nameLower.startsWith(prefix.toLowerCase())) {
        brand = prefix;
        break;
      }
    }

    return { pageId: v.pageId, brand, isBrandVenue: !!brand };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 10: Priority Scoring
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a 0-100 priority score combining all layer results.
 */
function computePriority(venues, layerResults) {
  const { layer4, layer5, layer8, layer9 } = layerResults;

  const playtomicMap = new Map((layer4 || []).map(r => [r.pageId, r]));
  const googleMap = new Map((layer5 || []).map(r => [r.pageId, r]));
  const scoreMap = new Map((layer8 || []).map(r => [r.pageId, r]));
  const brandMap = new Map((layer9 || []).map(r => [r.pageId, r]));

  return venues.map(v => {
    let priority = 0;
    const factors = [];

    // Completeness score x 5 (max 50)
    const compResult = scoreMap.get(v.pageId);
    if (compResult) {
      const pts = compResult.score * 5;
      priority += pts;
      factors.push(`completeness: ${pts}`);
    }

    // Google reviews: log10(reviews) x 8 (max ~25 for 1000+ reviews)
    const gResult = googleMap.get(v.pageId);
    if (gResult && gResult.reviewCount && gResult.reviewCount > 0) {
      const pts = Math.min(Math.log10(gResult.reviewCount) * 8, 25);
      priority += pts;
      factors.push(`reviews: ${pts.toFixed(1)}`);
    }

    // Has photos: +10
    const ptResult = playtomicMap.get(v.pageId);
    if (v.photos > 0 || (ptResult && ptResult.images > 0)) {
      priority += 10;
      factors.push('photos: 10');
    }

    // Has Playtomic booking: +10
    if (ptResult && ptResult.playtomicActive) {
      priority += 10;
      factors.push('playtomic: 10');
    }

    // Court count bonus: min(courts, 5) x 1
    const courts = v.courts || (ptResult && ptResult.verifiedCourts) || 0;
    if (courts > 0) {
      const pts = Math.min(courts, 5);
      priority += pts;
      factors.push(`courts: ${pts}`);
    }

    // Brand venue: +5
    const bResult = brandMap.get(v.pageId);
    if (bResult && bResult.isBrandVenue) {
      priority += 5;
      factors.push('brand: 5');
    }

    return { pageId: v.pageId, priority: Math.round(priority), factors };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Notion Update
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Patch a Notion page with qualification results.
 * Gracefully handles missing properties (logs and skips).
 */
async function updateNotionQualification(pageId, qualification) {
  const props = {};

  // Status
  if (qualification.status === 'excluded') {
    props['Status'] = { select: { name: 'Excluded' } };
  } else if (qualification.status === 'ready') {
    props['Status'] = { select: { name: 'Ready' } };
  } else {
    props['Status'] = { select: { name: 'Needs Review' } };
  }

  // Enrichment fields — only set if we have data
  if (qualification.googleRating) props['Google Rating'] = { number: qualification.googleRating };
  if (qualification.googleReviews) props['Google Reviews'] = { number: qualification.googleReviews };
  if (qualification.placeId) props['Google Place ID'] = { rich_text: [{ type: 'text', text: { content: qualification.placeId } }] };
  if (qualification.verifiedCourts) props['Courts'] = { number: qualification.verifiedCourts };
  if (qualification.qualScore !== undefined) props['Qualification Score'] = { number: qualification.qualScore };
  if (qualification.priorityScore !== undefined) props['Priority Score'] = { number: qualification.priorityScore };
  if (qualification.exclusionReason) props['Notes'] = { rich_text: [{ type: 'text', text: { content: qualification.exclusionReason } }] };
  if (qualification.cityEnglish) props['City'] = { rich_text: [{ type: 'text', text: { content: qualification.cityEnglish } }] };
  if (qualification.brand) props['Brand'] = { rich_text: [{ type: 'text', text: { content: qualification.brand } }] };
  if (qualification.surfaces) props['Surface'] = { rich_text: [{ type: 'text', text: { content: qualification.surfaces } }] };
  if (qualification.indoorOutdoor) props['Indoor/Outdoor'] = { select: { name: qualification.indoorOutdoor } };

  // Try to update — catch property-not-found errors gracefully
  try {
    await notionFetch(`/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: props }),
    });
  } catch (err) {
    if (err.message && err.message.includes('property')) {
      console.log(`  [qualify] Some Notion properties not found for ${pageId} — retrying with safe fields only`);
      // Retry with only Status (which always exists)
      const safeProps = { Status: props.Status };
      // Add fields one-by-one that are likely to exist
      const likelyFields = ['Google Rating', 'Google Reviews', 'Google Place ID', 'Courts', 'City', 'Notes'];
      for (const field of likelyFields) {
        if (props[field]) safeProps[field] = props[field];
      }
      try {
        await notionFetch(`/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: safeProps }),
        });
      } catch (retryErr) {
        // Last resort — just set status
        console.log(`  [qualify] Retry failed for ${pageId}: ${retryErr.message} — setting Status only`);
        try {
          await notionFetch(`/pages/${pageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: { Status: props.Status } }),
          });
        } catch (finalErr) {
          console.log(`  [qualify] FAILED to update ${pageId}: ${finalErr.message}`);
        }
      }
    } else {
      console.log(`  [qualify] FAILED to update ${pageId}: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Orchestrators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a qualification object for a single venue from all layer results.
 * Determines final status: ready, excluded, or needs-review.
 */
function buildQualification(venue, layerResults) {
  const { layer1, layer2, layer3, layer4, layer5, layer5b, layer6, layer7, layer8, layer9, layer10 } = layerResults;

  const find = (arr, pageId) => (arr || []).find(r => r.pageId === pageId) || {};

  const l1 = find(layer1, venue.pageId);
  const l2 = find(layer2, venue.pageId);
  const l3 = find(layer3, venue.pageId);
  const l4 = find(layer4, venue.pageId);
  const l5 = find(layer5, venue.pageId);
  const l5b = find(layer5b, venue.pageId);
  const l6 = find(layer6, venue.pageId);
  const l7 = find(layer7, venue.pageId);
  const l8 = find(layer8, venue.pageId);
  const l9 = find(layer9, venue.pageId);
  const l10 = find(layer10, venue.pageId);

  const qual = {
    status: 'ready',
    exclusionReason: null,
    exclusionType: null,
    googleRating: l5.rating || null,
    googleReviews: l5.reviewCount || null,
    placeId: l5.placeId || null,
    verifiedCourts: l4.verifiedCourts || null,
    qualScore: l8.score !== undefined ? l8.score : null,
    priorityScore: l10.priority !== undefined ? l10.priority : null,
    cityEnglish: l7.cityEnglish || null,
    brand: l9.brand || null,
    surfaces: l4.surfaces || null,
    indoorOutdoor: l4.indoorOutdoor || null,
  };

  // --- Exclusion checks (order matters — first match wins) ---

  // Internal duplicate
  if (l1.isDuplicate) {
    qual.status = 'excluded';
    qual.exclusionReason = `Internal duplicate: ${l1.reason}`;
    qual.exclusionType = 'duplicate';
    return qual;
  }

  // Place ID duplicate (different entries, same real venue)
  if (l5b && l5b.isDuplicate) {
    qual.status = 'excluded';
    qual.exclusionReason = `Place ID duplicate: ${l5b.reason}`;
    qual.exclusionType = 'duplicate';
    return qual;
  }

  // WP duplicate (already published)
  if (l2.isDuplicate) {
    qual.status = 'excluded';
    qual.exclusionReason = `Already live on WP: "${l2.existingTitle}" (ID ${l2.existingWpId})`;
    qual.exclusionType = 'already-live';
    return qual;
  }

  // Junk name or non-padel venue
  if (l3.isJunk) {
    qual.status = 'excluded';
    qual.exclusionReason = `Junk name: ${l3.reason}`;
    qual.exclusionType = l3.reason && l3.reason.startsWith('Non-padel') ? 'non-padel' : 'junk-name';
    return qual;
  }

  // Playtomic inactive (only exclude if Playtomic is the sole source)
  if (venue.playtomicId && !l4.playtomicActive && venue.source && !venue.source.includes('+')) {
    qual.status = 'excluded';
    qual.exclusionReason = `Playtomic tenant inactive (sole source)`;
    qual.exclusionType = 'inactive';
    return qual;
  }

  // Equipment shop (not a venue)
  if (l6.isEquipmentShop) {
    qual.status = 'excluded';
    qual.exclusionReason = `Website is an equipment shop, not a venue`;
    qual.exclusionType = 'equipment-shop';
    return qual;
  }

  // Geography out-of-bounds
  if (l7.flagged) {
    qual.status = 'needs-review';
    qual.exclusionReason = l7.reason;
    return qual;
  }

  // Low completeness → needs review
  if (l8.score !== undefined && l8.score <= 2) {
    qual.status = 'needs-review';
    qual.exclusionReason = `Low data completeness (${l8.score}/10)`;
    qual.exclusionType = 'unverifiable';
    return qual;
  }

  // No Google Place and no Playtomic → needs review
  if (!l5.hasGooglePlace && !l4.playtomicActive) {
    qual.status = 'needs-review';
    qual.exclusionReason = `Cannot verify — no Google Place or Playtomic data`;
    qual.exclusionType = 'unverifiable';
    return qual;
  }

  return qual;
}

/**
 * Qualify all "Discovered" venues in a country.
 *
 * @param {string} countryCode - ISO country code (e.g. 'AE', 'GB')
 * @param {object} options - { dryRun, limit, skipWebsite, skipPlaytomic }
 * @returns {object} Summary: { total, ready, excluded, needsReview, duplicates, errors }
 */
async function qualifyCountry(countryCode, options = {}) {
  const { dryRun = false, limit = null, skipWebsite = false, skipPlaytomic = false } = options;

  console.log(`[qualify] Starting qualification for ${countryCode.toUpperCase()}...`);
  if (dryRun) console.log(`[qualify] DRY RUN — no Notion updates will be made`);

  // ── Fetch venues from Notion ──
  let venues = (await queryDiscoveredVenues(countryCode)).map(extractVenue);
  console.log(`[qualify] Found ${venues.length} Discovered venues in ${countryCode.toUpperCase()}`);

  if (limit && venues.length > limit) {
    venues = venues.slice(0, limit);
    console.log(`[qualify] Limited to ${limit} venues`);
  }

  if (venues.length === 0) {
    console.log(`[qualify] Nothing to qualify — done.`);
    return { total: 0, ready: 0, excluded: 0, needsReview: 0, duplicates: 0, errors: 0 };
  }

  const layerResults = {};

  // ── Layer 1: Internal duplicates (bulk, no API) ──
  console.log(`[qualify] Layer 1: Internal duplicate detection...`);
  layerResults.layer1 = detectInternalDuplicates(venues);
  const dupCount = layerResults.layer1.filter(r => r.isDuplicate).length;
  const dupGroups = new Set(layerResults.layer1.filter(r => r.isDuplicate).map(r => r.duplicateOf)).size;
  console.log(`[qualify]   Found ${dupGroups} duplicate groups, ${dupCount} venues to exclude`);

  // Filter out duplicates for subsequent API layers (save API calls)
  const dupIds = new Set(layerResults.layer1.filter(r => r.isDuplicate).map(r => r.pageId));
  const nonDupVenues = venues.filter(v => !dupIds.has(v.pageId));

  // ── Layer 2: WP duplicates (API calls) ──
  console.log(`[qualify] Layer 2: WP duplicate check...`);
  layerResults.layer2 = await detectWPDuplicates(nonDupVenues);
  const wpDupCount = layerResults.layer2.filter(r => r.isDuplicate).length;
  console.log(`[qualify]   Found ${wpDupCount} already-published venues`);

  // Also add empty entries for internal duplicates
  for (const v of venues) {
    if (dupIds.has(v.pageId)) {
      layerResults.layer2.push({ pageId: v.pageId, isDuplicate: false, existingWpId: null, existingTitle: null });
    }
  }

  // ── Layer 3: Name cleaning (bulk, no API) ──
  console.log(`[qualify] Layer 3: Name cleaning...`);
  layerResults.layer3 = cleanNames(venues);
  const fixedNames = layerResults.layer3.filter(r => r.originalName !== r.cleanedName).length;
  const junkNames = layerResults.layer3.filter(r => r.isJunk && (!r.reason || !r.reason.startsWith('Non-padel'))).length;
  const nonPadelNames = layerResults.layer3.filter(r => r.isJunk && r.reason && r.reason.startsWith('Non-padel')).length;
  console.log(`[qualify]   Fixed ${fixedNames} names, excluded ${junkNames} junk + ${nonPadelNames} non-padel entries`);

  // ── Layer 4: Playtomic verification (API calls) ──
  if (skipPlaytomic) {
    console.log(`[qualify] Layer 4: Playtomic verification — SKIPPED`);
    layerResults.layer4 = venues.map(v => ({
      pageId: v.pageId, playtomicActive: false, verifiedCourts: null,
      surfaces: null, indoorOutdoor: null, images: 0, bookingType: null, enrichment: null,
    }));
  } else {
    console.log(`[qualify] Layer 4: Playtomic verification...`);
    layerResults.layer4 = await checkPlaytomic(nonDupVenues);
    // Add empty entries for duplicates
    for (const v of venues) {
      if (dupIds.has(v.pageId) && !layerResults.layer4.find(r => r.pageId === v.pageId)) {
        layerResults.layer4.push({
          pageId: v.pageId, playtomicActive: false, verifiedCourts: null,
          surfaces: null, indoorOutdoor: null, images: 0, bookingType: null, enrichment: null,
        });
      }
    }
    const ptChecked = nonDupVenues.filter(v => v.playtomicId).length;
    const ptActive = layerResults.layer4.filter(r => r.playtomicActive).length;
    const ptInactive = ptChecked - ptActive;
    console.log(`[qualify]   Checked ${ptChecked} venues — ${ptActive} active, ${ptInactive} inactive`);
  }

  // ── Layer 5: Google Places (API calls) ──
  console.log(`[qualify] Layer 5: Google Places verification...`);
  layerResults.layer5 = await checkGooglePlaces(nonDupVenues);
  // Add empty entries for duplicates
  for (const v of venues) {
    if (dupIds.has(v.pageId) && !layerResults.layer5.find(r => r.pageId === v.pageId)) {
      layerResults.layer5.push({
        pageId: v.pageId, hasGooglePlace: false, placeId: null,
        rating: null, reviewCount: null, isSportsType: false, matchScore: 0,
      });
    }
  }
  const gpFound = layerResults.layer5.filter(r => r.hasGooglePlace).length;
  const avgRating = layerResults.layer5.filter(r => r.rating).reduce((s, r) => s + r.rating, 0) /
                    (layerResults.layer5.filter(r => r.rating).length || 1);
  const avgReviews = layerResults.layer5.filter(r => r.reviewCount).reduce((s, r) => s + r.reviewCount, 0) /
                     (layerResults.layer5.filter(r => r.reviewCount).length || 1);
  console.log(`[qualify]   Found places for ${gpFound} venues — avg rating ${avgRating.toFixed(1)}, avg reviews ${Math.round(avgReviews)}`);

  // ── Layer 5b: Place ID dedup (bulk, no API) ──
  console.log(`[qualify] Layer 5b: Google Place ID deduplication...`);
  layerResults.layer5b = deduplicateByPlaceId(nonDupVenues, layerResults.layer5);
  const placeIdDups = layerResults.layer5b.filter(r => r.isDuplicate).length;
  console.log(`[qualify]   ${placeIdDups} venues share a Place ID with another entry`);
  // Add Place ID dupes to the dupIds set so subsequent layers skip them
  for (const r of layerResults.layer5b) {
    if (r.isDuplicate) dupIds.add(r.pageId);
  }
  // Also add empty entries for already-excluded dupes
  for (const v of venues) {
    if (!layerResults.layer5b.find(r => r.pageId === v.pageId)) {
      layerResults.layer5b.push({ pageId: v.pageId, isDuplicate: false, duplicateOf: null, reason: null });
    }
  }

  // ── Layer 6: Website check (API calls, slowest) ──
  if (skipWebsite) {
    console.log(`[qualify] Layer 6: Website check — SKIPPED`);
    layerResults.layer6 = venues.map(v => ({
      pageId: v.pageId, websiteLive: false, hasPadelContent: false,
      isEquipmentShop: false, websiteStatus: 'skipped',
    }));
  } else {
    const withWebsite = nonDupVenues.filter(v => v.website);
    console.log(`[qualify] Layer 6: Website check (${withWebsite.length} with URLs)...`);
    layerResults.layer6 = await checkWebsites(nonDupVenues);
    // Add empty entries for duplicates
    for (const v of venues) {
      if (dupIds.has(v.pageId) && !layerResults.layer6.find(r => r.pageId === v.pageId)) {
        layerResults.layer6.push({
          pageId: v.pageId, websiteLive: false, hasPadelContent: false,
          isEquipmentShop: false, websiteStatus: 'skipped-duplicate',
        });
      }
    }
    const liveCount = layerResults.layer6.filter(r => r.websiteLive).length;
    const shopCount = layerResults.layer6.filter(r => r.isEquipmentShop).length;
    console.log(`[qualify]   ${liveCount} live sites, ${shopCount} equipment shops detected`);
  }

  // ── Layer 7: Geography validation (bulk, no API) ──
  console.log(`[qualify] Layer 7: Geography validation...`);
  layerResults.layer7 = validateGeography(venues);
  const outOfBounds = layerResults.layer7.filter(r => r.flagged).length;
  console.log(`[qualify]   ${outOfBounds} venues flagged as out-of-bounds`);

  // ── Layer 8: Completeness scoring (bulk) ──
  console.log(`[qualify] Layer 8: Completeness scoring...`);
  layerResults.layer8 = scoreCompleteness(venues, layerResults);
  const avgScore = layerResults.layer8.reduce((s, r) => s + r.score, 0) / (venues.length || 1);
  console.log(`[qualify]   Average completeness: ${avgScore.toFixed(1)}/10`);

  // ── Layer 9: Brand detection (bulk) ──
  console.log(`[qualify] Layer 9: Brand detection...`);
  layerResults.layer9 = detectBrands(venues);
  const brandCount = layerResults.layer9.filter(r => r.isBrandVenue).length;
  const brandGroups = [...new Set(layerResults.layer9.filter(r => r.brand).map(r => r.brand))];
  console.log(`[qualify]   ${brandCount} brand venues across ${brandGroups.length} brands: ${brandGroups.join(', ') || 'none'}`);

  // ── Layer 10: Priority scoring (bulk) ──
  console.log(`[qualify] Layer 10: Priority scoring...`);
  layerResults.layer10 = computePriority(venues, layerResults);
  const avgPriority = layerResults.layer10.reduce((s, r) => s + r.priority, 0) / (venues.length || 1);
  console.log(`[qualify]   Average priority: ${avgPriority.toFixed(1)}/100`);

  // ── Build qualifications and update Notion ──
  console.log(`[qualify] Building qualifications and ${dryRun ? 'previewing' : 'updating Notion'}...`);

  const summary = { total: venues.length, ready: 0, excluded: 0, needsReview: 0, duplicates: 0, errors: 0 };
  const exclusionBreakdown = { duplicates: 0, alreadyLive: 0, junkNames: 0, nonPadel: 0, inactive: 0, equipmentShop: 0, unverifiable: 0 };

  for (let i = 0; i < venues.length; i++) {
    const v = venues[i];
    try {
      const qual = buildQualification(v, layerResults);

      if (qual.status === 'ready') summary.ready++;
      else if (qual.status === 'excluded') {
        summary.excluded++;
        if (qual.exclusionType === 'duplicate') exclusionBreakdown.duplicates++;
        else if (qual.exclusionType === 'already-live') exclusionBreakdown.alreadyLive++;
        else if (qual.exclusionType === 'junk-name') exclusionBreakdown.junkNames++;
        else if (qual.exclusionType === 'non-padel') exclusionBreakdown.nonPadel++;
        else if (qual.exclusionType === 'inactive') exclusionBreakdown.inactive++;
        else if (qual.exclusionType === 'equipment-shop') exclusionBreakdown.equipmentShop++;
        else if (qual.exclusionType === 'unverifiable') exclusionBreakdown.unverifiable++;
      } else {
        summary.needsReview++;
        if (qual.exclusionType === 'unverifiable') exclusionBreakdown.unverifiable++;
      }

      if (!dryRun) {
        await updateNotionQualification(v.pageId, qual);
        await sleep(150); // Notion rate limiting
      }
    } catch (err) {
      summary.errors++;
      console.log(`  [qualify] Error processing "${v.name}": ${err.message}`);
    }

    if (i > 0 && i % 20 === 0) {
      console.log(`  [qualify]   ...processed ${i}/${venues.length}`);
    }
  }

  // ── Final report ──
  const readyPct = venues.length > 0 ? ((summary.ready / venues.length) * 100).toFixed(0) : 0;
  const reviewPct = venues.length > 0 ? ((summary.needsReview / venues.length) * 100).toFixed(0) : 0;
  const excludedPct = venues.length > 0 ? ((summary.excluded / venues.length) * 100).toFixed(0) : 0;

  console.log('');
  console.log(`[qualify] ${'='.repeat(50)}`);
  console.log(`[qualify] QUALIFICATION COMPLETE — ${countryCode.toUpperCase()}`);
  console.log(`[qualify] ${'='.repeat(50)}`);
  console.log(`[qualify]   Total processed:  ${summary.total}`);
  console.log(`[qualify]   Ready:            ${summary.ready}  (${readyPct}%)`);
  console.log(`[qualify]   Needs Review:     ${summary.needsReview}  (${reviewPct}%)`);
  console.log(`[qualify]   Excluded:         ${summary.excluded}  (${excludedPct}%)`);
  console.log(`[qualify]     - Duplicates:    ${exclusionBreakdown.duplicates}`);
  console.log(`[qualify]     - Already live:  ${exclusionBreakdown.alreadyLive}`);
  console.log(`[qualify]     - Junk names:    ${exclusionBreakdown.junkNames}`);
  console.log(`[qualify]     - Non-padel:     ${exclusionBreakdown.nonPadel}`);
  console.log(`[qualify]     - Inactive:      ${exclusionBreakdown.inactive}`);
  console.log(`[qualify]     - Equip shops:   ${exclusionBreakdown.equipmentShop}`);
  console.log(`[qualify]     - Unverifiable:  ${exclusionBreakdown.unverifiable}`);
  if (summary.errors > 0) console.log(`[qualify]   Errors:           ${summary.errors}`);
  console.log(`[qualify] ${'='.repeat(50)}`);

  return { ...summary, exclusionBreakdown };
}

/**
 * Qualify a single venue by its Notion page ID.
 * Runs all 10 layers on just that one venue and updates Notion.
 */
async function qualifySingle(notionPageId) {
  console.log(`[qualify] Qualifying single venue: ${notionPageId}`);

  // Fetch the page from Notion
  const page = await notionFetch(`/pages/${notionPageId}`);
  const venue = extractVenue(page);
  const venues = [venue];

  console.log(`[qualify] Venue: "${venue.name}" (${venue.country})`);

  const layerResults = {};

  // Run all layers on this single venue
  console.log(`[qualify] Layer 1: Internal duplicate detection...`);
  layerResults.layer1 = detectInternalDuplicates(venues);

  console.log(`[qualify] Layer 2: WP duplicate check...`);
  layerResults.layer2 = await detectWPDuplicates(venues);

  console.log(`[qualify] Layer 3: Name cleaning...`);
  layerResults.layer3 = cleanNames(venues);

  console.log(`[qualify] Layer 4: Playtomic verification...`);
  layerResults.layer4 = await checkPlaytomic(venues);

  console.log(`[qualify] Layer 5: Google Places verification...`);
  layerResults.layer5 = await checkGooglePlaces(venues);

  console.log(`[qualify] Layer 5b: Place ID dedup...`);
  layerResults.layer5b = deduplicateByPlaceId(venues, layerResults.layer5);

  console.log(`[qualify] Layer 6: Website check...`);
  layerResults.layer6 = await checkWebsites(venues);

  console.log(`[qualify] Layer 7: Geography validation...`);
  layerResults.layer7 = validateGeography(venues);

  console.log(`[qualify] Layer 8: Completeness scoring...`);
  layerResults.layer8 = scoreCompleteness(venues, layerResults);

  console.log(`[qualify] Layer 9: Brand detection...`);
  layerResults.layer9 = detectBrands(venues);

  console.log(`[qualify] Layer 10: Priority scoring...`);
  layerResults.layer10 = computePriority(venues, layerResults);

  // Build qualification and update Notion
  const qual = buildQualification(venue, layerResults);
  await updateNotionQualification(notionPageId, qual);

  console.log(`[qualify] Result: ${qual.status.toUpperCase()} (score: ${qual.qualScore}/10, priority: ${qual.priorityScore}/100)`);
  if (qual.exclusionReason) console.log(`[qualify] Reason: ${qual.exclusionReason}`);

  return { venue, qualification: qual, layerResults };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node lib/qualify-queue.js AE                  # qualify all Discovered in AE');
    console.log('  node lib/qualify-queue.js AE --dry-run        # preview without updating Notion');
    console.log('  node lib/qualify-queue.js AE --limit 10       # only process 10');
    console.log('  node lib/qualify-queue.js AE --skip-website   # skip website checks (faster)');
    console.log('  node lib/qualify-queue.js single <page-id>    # single venue');
    process.exit(0);
  }

  const command = args[0];

  if (command === 'single') {
    const pageId = args[1];
    if (!pageId) {
      console.log('Usage: node lib/qualify-queue.js single <notion-page-id>');
      process.exit(1);
    }
    qualifySingle(pageId)
      .then(() => process.exit(0))
      .catch(err => { console.error(`[qualify] FATAL: ${err.message}`); process.exit(1); });
  } else {
    // Country code mode
    const countryCode = command.toUpperCase();
    const options = {
      dryRun: args.includes('--dry-run'),
      limit: args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : null,
      skipWebsite: args.includes('--skip-website'),
      skipPlaytomic: args.includes('--skip-playtomic'),
    };

    qualifyCountry(countryCode, options)
      .then(() => process.exit(0))
      .catch(err => { console.error(`[qualify] FATAL: ${err.message}`); process.exit(1); });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  qualifyCountry,
  qualifySingle,
  detectInternalDuplicates,
  detectWPDuplicates,
  cleanNames,
  checkPlaytomic,
  checkGooglePlaces,
  deduplicateByPlaceId,
  checkWebsites,
  validateGeography,
  scoreCompleteness,
  detectBrands,
  computePriority,
  updateNotionQualification,
};
