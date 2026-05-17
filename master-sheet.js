/**
 * master-sheet.js — JSON-based club tracking per country.
 *
 * Replaces the xlsx master sheets described in the Padeli SOP.
 * One JSON file per country: data/{country-code}-clubs.json
 *
 * Node.js v24+, zero external dependencies.
 *
 * Usage as CLI:
 *   node master-sheet.js summary GB
 *   node master-sheet.js status GB pending
 *   node master-sheet.js backup GB
 *   node master-sheet.js import GB clubs.json
 *   node master-sheet.js next GB 10
 */

const { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const DATA_DIR = join(__dirname, '..', 'data');
const BACKUPS_DIR = join(DATA_DIR, 'backups');

const VALID_STATUSES = new Set([
  'pending', 'imported', 'enriched', 'researched', 'drafted',
  'published', 'dropped', 'duplicate', 'needs-manual', 'not_a_venue',
  'coming_soon', 'in_progress'
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDirs() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(BACKUPS_DIR)) mkdirSync(BACKUPS_DIR, { recursive: true });
}

function filePath(countryCode) {
  return join(DATA_DIR, `${countryCode.toUpperCase()}-clubs.json`);
}

function nextPoolId(clubs) {
  if (clubs.length === 0) return 1;
  return Math.max(...clubs.map(c => c.pool_id)) + 1;
}

function normalise(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function now() {
  return new Date().toISOString();
}

function dateStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Load the club sheet for a country. Creates an empty file if none exists.
 * @param {string} countryCode  ISO 3166-1 alpha-2 (e.g. "GB")
 * @returns {Array<object>}
 */
function loadSheet(countryCode) {
  ensureDirs();
  const fp = filePath(countryCode);
  if (!existsSync(fp)) {
    writeFileSync(fp, '[]', 'utf-8');
    return [];
  }
  const raw = readFileSync(fp, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Save the club sheet. Uses atomic write (tmp + rename) to prevent corruption.
 * @param {string} countryCode
 * @param {Array<object>} data
 */
function saveSheet(countryCode, data) {
  ensureDirs();
  const fp = filePath(countryCode);
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, fp);
}

/**
 * Add discovered clubs. Deduplicates against existing entries by place_id,
 * then by normalised name + city.
 * @param {string} countryCode
 * @param {Array<object>} clubs  Array of partial club objects (at minimum: name, city)
 * @returns {{ added: number, skipped: number, total: number }}
 */
function addClubs(countryCode, clubs) {
  const existing = loadSheet(countryCode);

  // Build lookup indexes
  const placeIds = new Set(existing.filter(c => c.place_id).map(c => c.place_id));
  const nameCity = new Set(existing.map(c => normalise(c.name) + '|' + normalise(c.city)));

  let id = nextPoolId(existing);
  let added = 0;
  let skipped = 0;

  for (const club of clubs) {
    // Dedup by place_id
    if (club.place_id && placeIds.has(club.place_id)) {
      skipped++;
      continue;
    }
    // Dedup by name + city
    const key = normalise(club.name) + '|' + normalise(club.city);
    if (nameCity.has(key)) {
      skipped++;
      continue;
    }

    const ts = now();
    const entry = {
      pool_id: id++,
      name: club.name || '',
      address: club.address || '',
      city: club.city || '',
      region: club.region || '',
      postcode: club.postcode || '',
      country: club.country || '',
      country_code: countryCode.toUpperCase(),
      phone: club.phone || '',
      website: club.website || '',
      playtomic_url: club.playtomic_url || null,
      matchi_url: club.matchi_url || null,
      place_id: club.place_id || null,
      lat: club.lat ?? null,
      lng: club.lng ?? null,
      courts_total: club.courts_total ?? null,
      indoor_outdoor: club.indoor_outdoor || '',
      surface_type: club.surface_type || '',
      opened_year: club.opened_year || '',
      notes: club.notes || '',
      padeli_listing_id: club.padeli_listing_id || null,
      status: club.status || 'pending',
      source: club.source || '',
      discovered_at: club.discovered_at || ts,
      updated_at: ts,
      // Rich Playtomic fields
      playtomic_tenant_id: club.playtomic_tenant_id || null,
      playtomic_status: club.playtomic_status || null,
      booking_type: club.booking_type || null,
      timezone: club.timezone || null,
      currency: club.currency || null,
      opening_hours_raw: club.opening_hours_raw || null,
      images: club.images || [],
      court_details: club.court_details || [],
      cancellation_policy: club.cancellation_policy || null,
    };

    existing.push(entry);
    placeIds.add(entry.place_id);
    nameCity.add(key);
    added++;
  }

  saveSheet(countryCode, existing);
  return { added, skipped, total: existing.length };
}

/**
 * Update the status of a club by pool_id.
 * @param {string} countryCode
 * @param {number} poolId
 * @param {string} newStatus
 * @param {string} [notes]  Optional note to append
 * @returns {object|null}  Updated club or null if not found
 */
function updateStatus(countryCode, poolId, newStatus, notes) {
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status "${newStatus}". Valid: ${[...VALID_STATUSES].join(', ')}`);
  }

  const data = loadSheet(countryCode);
  const club = data.find(c => c.pool_id === poolId);
  if (!club) return null;

  club.status = newStatus;
  club.updated_at = now();
  if (notes !== undefined && notes !== null) {
    club.notes = club.notes ? `${club.notes}; ${notes}` : notes;
  }

  saveSheet(countryCode, data);
  return club;
}

/**
 * Link a WP listing ID to a club entry after import.
 * @param {string} countryCode
 * @param {number} poolId
 * @param {number|string} wpListingId
 * @returns {object|null}
 */
function linkListing(countryCode, poolId, wpListingId) {
  const data = loadSheet(countryCode);
  const club = data.find(c => c.pool_id === poolId);
  if (!club) return null;

  club.padeli_listing_id = wpListingId;
  club.updated_at = now();

  saveSheet(countryCode, data);
  return club;
}

/**
 * Return all clubs with a given status.
 * @param {string} countryCode
 * @param {string} status
 * @returns {Array<object>}
 */
function getByStatus(countryCode, status) {
  const data = loadSheet(countryCode);
  return data.filter(c => c.status === status);
}

/**
 * Return a summary object: counts by status, city, and source.
 * @param {string} countryCode
 * @returns {{ total: number, by_status: object, by_city: object, by_source: object }}
 */
function getSummary(countryCode) {
  const data = loadSheet(countryCode);

  const by_status = {};
  const by_city = {};
  const by_source = {};

  for (const club of data) {
    by_status[club.status] = (by_status[club.status] || 0) + 1;

    const city = club.city || '(unknown)';
    by_city[city] = (by_city[city] || 0) + 1;

    const source = club.source || '(unknown)';
    by_source[source] = (by_source[source] || 0) + 1;
  }

  return { total: data.length, by_status, by_city, by_source };
}

/**
 * Create a timestamped backup of the country sheet.
 * @param {string} countryCode
 * @returns {string}  Path to the backup file
 */
function backupSheet(countryCode) {
  ensureDirs();
  const src = filePath(countryCode);
  if (!existsSync(src)) {
    throw new Error(`No sheet found for ${countryCode.toUpperCase()}`);
  }
  const dest = join(BACKUPS_DIR, `${countryCode.toUpperCase()}-clubs-${dateStamp()}.json`);
  copyFileSync(src, dest);
  return dest;
}

/**
 * Sync from WordPress listings. Matches WP listings to sheet entries by
 * place_id first, then by normalised name. Updates status and listing ID.
 *
 * @param {string} countryCode
 * @param {Array<object>} wpListings  Each should have at minimum:
 *   { id, title, place_id?, status? }
 *   where status maps to sheet statuses (e.g. 'draft'->'imported', 'publish'->'published')
 * @returns {{ matched: number, unmatched: number, details: Array }}
 */
function syncFromWP(countryCode, wpListings) {
  const data = loadSheet(countryCode);

  // Build indexes for fast lookup
  const byPlaceId = new Map();
  const byName = new Map();
  for (let i = 0; i < data.length; i++) {
    if (data[i].place_id) byPlaceId.set(data[i].place_id, i);
    const key = normalise(data[i].name);
    if (key && !byName.has(key)) byName.set(key, i);
  }

  const wpStatusMap = {
    publish: 'published',
    draft: 'imported',
    pending: 'imported',
    private: 'imported'
  };

  let matched = 0;
  let unmatched = 0;
  const details = [];

  for (const wp of wpListings) {
    let idx = -1;

    // Match by place_id first
    if (wp.place_id && byPlaceId.has(wp.place_id)) {
      idx = byPlaceId.get(wp.place_id);
    }

    // Fallback: match by normalised name (title)
    if (idx === -1) {
      const nameKey = normalise(wp.title || wp.name || '');
      if (nameKey && byName.has(nameKey)) {
        idx = byName.get(nameKey);
      }
    }

    if (idx !== -1) {
      const club = data[idx];
      club.padeli_listing_id = wp.id;
      const mappedStatus = wpStatusMap[wp.status] || wp.status;
      if (mappedStatus && VALID_STATUSES.has(mappedStatus)) {
        // Only advance status, never regress (published > imported > pending)
        const rank = ['pending', 'imported', 'enriched', 'researched', 'published'];
        const currentRank = rank.indexOf(club.status);
        const newRank = rank.indexOf(mappedStatus);
        if (newRank > currentRank || currentRank === -1) {
          club.status = mappedStatus;
        }
      }
      club.updated_at = now();
      matched++;
      details.push({ pool_id: club.pool_id, name: club.name, wp_id: wp.id, action: 'matched' });
    } else {
      unmatched++;
      details.push({ wp_title: wp.title || wp.name, wp_id: wp.id, action: 'unmatched' });
    }
  }

  saveSheet(countryCode, data);
  return { matched, unmatched, details };
}

/**
 * Return the next N clubs with status 'pending', sorted by pool_id (FIFO).
 * @param {string} countryCode
 * @param {number} n  How many to return
 * @param {object} [options]
 * @param {string} [options.city]    Filter by city (case-insensitive)
 * @param {string} [options.source]  Filter by source (case-insensitive, partial match for multi-source like 'playtomic+matchi')
 * @returns {Array<object>}
 */
function getNextBatch(countryCode, n, options = {}) {
  const data = loadSheet(countryCode);
  let pending = data.filter(c => c.status === 'pending');

  if (options.city) {
    const cityLower = options.city.toLowerCase();
    pending = pending.filter(c => (c.city || '').toLowerCase() === cityLower);
  }

  if (options.source) {
    const srcLower = options.source.toLowerCase();
    pending = pending.filter(c => (c.source || '').toLowerCase().includes(srcLower));
  }

  // Sort by pool_id ascending (FIFO)
  pending.sort((a, b) => a.pool_id - b.pool_id);

  return pending.slice(0, n);
}

/**
 * Update status for multiple clubs in a single load/save cycle.
 * @param {string} countryCode
 * @param {number[]} poolIds  Array of pool_id values to update
 * @param {string} newStatus
 * @param {string} [notes]  Optional note to append to each
 * @returns {{ updated: number, notFound: number }}
 */
function bulkUpdateStatus(countryCode, poolIds, newStatus, notes) {
  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status "${newStatus}". Valid: ${[...VALID_STATUSES].join(', ')}`);
  }

  const data = loadSheet(countryCode);
  const idSet = new Set(poolIds);
  let updated = 0;
  let notFound = 0;

  for (const club of data) {
    if (idSet.has(club.pool_id)) {
      club.status = newStatus;
      club.updated_at = now();
      if (notes !== undefined && notes !== null) {
        club.notes = club.notes ? `${club.notes}; ${notes}` : notes;
      }
      idSet.delete(club.pool_id);
      updated++;
    }
  }

  notFound = idSet.size;

  saveSheet(countryCode, data);
  return { updated, notFound };
}

// ---------------------------------------------------------------------------
// Notion sync
// ---------------------------------------------------------------------------

const NOTION_API_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';
const SYSTEMS_PAGE_ID = '346d1b51-fb30-8096-9126-e397b0c4ca91';

function notionDbFilePath(countryCode) {
  return join(DATA_DIR, `${countryCode.toUpperCase()}-notion-db.json`);
}

function notionHeaders() {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY environment variable is not set');
  return {
    'Authorization': `Bearer ${key}`,
    'Notion-Version': NOTION_API_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${NOTION_BASE}${path}`;
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { ...options, headers: { ...notionHeaders(), ...(options.headers || {}) } });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
      const wait = Math.max(retryAfter, 1) * 1000;
      console.log(`  Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Notion API ${res.status}: ${body.message || JSON.stringify(body)}`);
    }
    return body;
  }
  throw new Error('Notion API rate limit exceeded after retries');
}

const STATUS_COLORS = {
  pending: 'default',
  imported: 'blue',
  enriched: 'purple',
  researched: 'yellow',
  drafted: 'orange',
  published: 'green',
  dropped: 'red',
  duplicate: 'gray',
  'needs-manual': 'pink',
};

function buildDatabaseProperties() {
  return {
    Name: { title: {} },
    City: { rich_text: {} },
    Status: {
      select: {
        options: Object.entries(STATUS_COLORS).map(([name, color]) => ({ name, color })),
      },
    },
    Source: { rich_text: {} },
    'WP Listing ID': { number: {} },
    'Google Rating': { number: {} },
    Courts: { rich_text: {} },
    Phone: { rich_text: {} },
    Website: { url: {} },
    Address: { rich_text: {} },
    'Pool ID': { number: {} },
    Discovered: { date: {} },
  };
}

function clubToNotionProperties(club) {
  const props = {
    Name: { title: [{ text: { content: club.name || '' } }] },
    City: { rich_text: [{ text: { content: club.city || '' } }] },
    Status: { select: club.status ? { name: club.status } : null },
    Source: { rich_text: [{ text: { content: club.source || '' } }] },
    Courts: { rich_text: [{ text: { content: club.courts_total != null ? String(club.courts_total) : '' } }] },
    Phone: { rich_text: [{ text: { content: club.phone || '' } }] },
    Address: { rich_text: [{ text: { content: club.address || '' } }] },
    'Pool ID': { number: typeof club.pool_id === 'number' ? club.pool_id : null },
  };

  if (club.padeli_listing_id != null) {
    props['WP Listing ID'] = { number: Number(club.padeli_listing_id) || null };
  }

  if (club.google_rating != null) {
    props['Google Rating'] = { number: Number(club.google_rating) || null };
  }

  if (club.website) {
    props.Website = { url: club.website };
  }

  if (club.discovered_at) {
    props.Discovered = { date: { start: club.discovered_at.slice(0, 10) } };
  }

  return props;
}

async function createNotionDatabase(countryCode) {
  const cc = countryCode.toUpperCase();
  const body = {
    parent: { page_id: SYSTEMS_PAGE_ID },
    title: [{ type: 'text', text: { content: `Padeli Master Sheet — ${cc}` } }],
    properties: buildDatabaseProperties(),
  };

  const result = await notionFetch('/databases', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const dbMeta = { database_id: result.id, database_url: result.url, created_at: now() };
  writeFileSync(notionDbFilePath(cc), JSON.stringify(dbMeta, null, 2), 'utf-8');
  return dbMeta;
}

async function queryAllNotionPages(databaseId) {
  const pages = [];
  let cursor = undefined;

  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const result = await notionFetch(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    pages.push(...result.results);
    if (!result.has_more) break;
    cursor = result.next_cursor;
  }

  return pages;
}

function extractPoolId(page) {
  const prop = page.properties['Pool ID'];
  if (prop && prop.number != null) return prop.number;
  return null;
}

function propsChanged(page, club) {
  const p = page.properties;

  const getText = (prop) => {
    if (!prop) return '';
    if (prop.rich_text && prop.rich_text.length > 0) return prop.rich_text[0].plain_text || '';
    return '';
  };
  const getSelect = (prop) => (prop && prop.select) ? prop.select.name : '';
  const getNumber = (prop) => (prop && prop.number != null) ? prop.number : null;
  const getUrl = (prop) => (prop && prop.url) ? prop.url : null;

  if (getSelect(p.Status) !== (club.status || '')) return true;
  if (getNumber(p['WP Listing ID']) !== (club.padeli_listing_id != null ? Number(club.padeli_listing_id) : null)) return true;
  if (getText(p.City) !== (club.city || '')) return true;
  if (getText(p.Source) !== (club.source || '')) return true;
  if (getText(p.Courts) !== (club.courts_total != null ? String(club.courts_total) : '')) return true;
  if (getText(p.Phone) !== (club.phone || '')) return true;
  if (getText(p.Address) !== (club.address || '')) return true;
  if (getUrl(p.Website) !== (club.website || null)) return true;

  // Check name (title)
  const titleText = (p.Name && p.Name.title && p.Name.title.length > 0) ? p.Name.title[0].plain_text : '';
  if (titleText !== (club.name || '')) return true;

  return false;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Sync the local master sheet for a country to a Notion database.
 * Creates the database on first run; updates on subsequent runs.
 *
 * @param {string} countryCode  ISO 3166-1 alpha-2 (e.g. "AU")
 * @returns {Promise<{ database_id: string, database_url: string, created: number, updated: number, unchanged: number, total: number }>}
 */
async function syncToNotion(countryCode) {
  const cc = countryCode.toUpperCase();
  const clubs = loadSheet(cc);

  if (clubs.length === 0) {
    throw new Error(`No clubs found in ${cc} master sheet. Nothing to sync.`);
  }

  const dbFile = notionDbFilePath(cc);
  let dbMeta;
  let isFirstRun = false;

  // Load or create Notion database
  if (existsSync(dbFile)) {
    dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
    console.log(`\nFound existing Notion DB: ${dbMeta.database_id}`);
  } else {
    console.log(`\nCreating Notion database for ${cc}...`);
    dbMeta = await createNotionDatabase(cc);
    isFirstRun = true;
    console.log(`Created: ${dbMeta.database_url}`);
  }

  const databaseId = dbMeta.database_id;
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  if (isFirstRun) {
    // First run — create all pages in batches
    console.log(`Creating ${clubs.length} pages in batches of 10...`);
    const batches = [];
    for (let i = 0; i < clubs.length; i += 10) {
      batches.push(clubs.slice(i, i + 10));
    }

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const promises = batch.map(club =>
        notionFetch('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties: clubToNotionProperties(club),
          }),
        })
      );

      await Promise.all(promises);
      created += batch.length;
      console.log(`  Batch ${b + 1}/${batches.length} — ${created}/${clubs.length} created`);
      if (b < batches.length - 1) await sleep(350);
    }
  } else {
    // Subsequent run — query existing, match by Pool ID, update or create
    console.log('Querying existing Notion pages...');
    const existingPages = await queryAllNotionPages(databaseId);
    console.log(`Found ${existingPages.length} existing pages in Notion.`);

    // Build map: pool_id -> page
    const pageByPoolId = new Map();
    for (const page of existingPages) {
      const pid = extractPoolId(page);
      if (pid != null) pageByPoolId.set(pid, page);
    }

    const toCreate = [];
    const toUpdate = [];

    for (const club of clubs) {
      const existingPage = pageByPoolId.get(club.pool_id);
      if (existingPage) {
        if (propsChanged(existingPage, club)) {
          toUpdate.push({ pageId: existingPage.id, club });
        } else {
          unchanged++;
        }
      } else {
        toCreate.push(club);
      }
    }

    // Update existing pages in batches
    if (toUpdate.length > 0) {
      console.log(`Updating ${toUpdate.length} pages...`);
      const updateBatches = [];
      for (let i = 0; i < toUpdate.length; i += 10) {
        updateBatches.push(toUpdate.slice(i, i + 10));
      }

      for (let b = 0; b < updateBatches.length; b++) {
        const batch = updateBatches[b];
        const promises = batch.map(({ pageId, club }) =>
          notionFetch(`/pages/${pageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: clubToNotionProperties(club) }),
          })
        );
        await Promise.all(promises);
        updated += batch.length;
        if (b < updateBatches.length - 1) await sleep(350);
      }
    }

    // Create new pages in batches
    if (toCreate.length > 0) {
      console.log(`Creating ${toCreate.length} new pages...`);
      const createBatches = [];
      for (let i = 0; i < toCreate.length; i += 10) {
        createBatches.push(toCreate.slice(i, i + 10));
      }

      for (let b = 0; b < createBatches.length; b++) {
        const batch = createBatches[b];
        const promises = batch.map(club =>
          notionFetch('/pages', {
            method: 'POST',
            body: JSON.stringify({
              parent: { database_id: databaseId },
              properties: clubToNotionProperties(club),
            }),
          })
        );
        await Promise.all(promises);
        created += batch.length;
        if (b < createBatches.length - 1) await sleep(350);
      }
    }
  }

  const total = clubs.length;
  console.log(`\n=== Notion Sync Complete ===`);
  console.log(`  Database: ${dbMeta.database_url}`);
  console.log(`  Created:   ${created}`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Total:     ${total}`);

  return { database_id: databaseId, database_url: dbMeta.database_url, created, updated, unchanged, total };
}

// ---------------------------------------------------------------------------
// Unified Notion sync (all countries, one database)
// ---------------------------------------------------------------------------

const UNIFIED_DB_FILE = join(DATA_DIR, 'unified-notion-db.json');
const PIPELINE_AUTHOR_ID = 5; // Ryan's WP author ID — pipeline trial drafts

const DISPLAY_STATUS_MAP = {
  pending: 'Discovered',
  coming_soon: 'Discovered',
  imported: 'Discovered',
  enriched: 'Discovered',
  researched: 'Discovered',
  in_progress: 'In Progress',
  drafted: 'Drafted',
  published: 'Published',
  duplicate: 'Excluded',
  not_a_venue: 'Excluded',
  dropped: 'Excluded',
  'needs-manual': 'Excluded',
};

/**
 * Pull all listings from WordPress (published + draft).
 * Returns arrays for published and non-pipeline drafts.
 */
async function pullFromWP() {
  const user = process.env.PADELI_WP_USER;
  const pass = process.env.PADELI_WP_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing PADELI_WP_USER or PADELI_WP_APP_PASSWORD');
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'User-Agent': 'PadeliSync/1.0' };
  const BASE = 'https://padeli.com/wp-json/wp/v2/listing';

  async function fetchAll(status) {
    const results = [];
    let page = 1;
    while (true) {
      const url = `${BASE}?status=${status}&per_page=100&page=${page}&_fields=id,title,slug,author,date,status,link,meta`;
      const res = await fetch(url, { headers });
      if (res.status === 400) break;
      if (!res.ok) throw new Error(`WP API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      if (data.length === 0) break;
      results.push(...data);
      const totalPages = parseInt(res.headers.get('X-WP-TotalPages') || '1', 10);
      if (page >= totalPages) break;
      page++;
    }
    return results;
  }

  const [published, drafts] = await Promise.all([
    fetchAll('publish'),
    fetchAll('draft'),
  ]);

  // Separate pipeline trials from real drafts
  const realDrafts = drafts.filter(d => d.author !== PIPELINE_AUTHOR_ID);
  const pipelineTrials = drafts.filter(d => d.author === PIPELINE_AUTHOR_ID);

  return { published, realDrafts, pipelineTrials };
}

/**
 * Detect country code from a WP listing's address or meta.
 */
function detectCountry(wp) {
  const addr = (wp.meta?._address || wp.meta?._friendly_address || '').toLowerCase();
  if (/\bindonesia\b|\bbali\b|\bdenpasar\b|\bcanggu\b|\bubud\b|\bseminyak\b|\bkuta\b|\buluwatu\b|\bsanur\b/.test(addr)) return 'ID';
  if (/\bunited states\b|\busa\b|\b(ny|nyc|nj|fl|ca|ga|tn)\b|\bnew york\b|\bmiami\b|\bnashville\b|\batlanta\b/.test(addr)) return 'US';
  if (/\baustralia\b|\bact\b|\bvic\b|\bnsw\b|\bqld\b|\bwa\b|\bsa\b|\btas\b/.test(addr)) return 'AU';
  if (/\bdubai\b|\buae\b|\babu dhabi\b/.test(addr)) return 'AE';
  if (/\buk\b|\bunited kingdom\b|\bengland\b|\bscotland\b|\bwales\b|\bnorthern ireland\b|\bbelfast\b/.test(addr)) return 'GB';
  // Default to GB — most listings are UK
  return 'GB';
}

/**
 * Extract a clean club object from a WP listing with full meta.
 */
function wpToClub(wp, displayStatus) {
  const meta = wp.meta || {};
  const name = (wp.title?.rendered || '').replace(/&#\d+;/g, '&').replace(/&#8217;/g, "'").replace(/&amp;/g, '&');
  const country = detectCountry(wp);

  // Parse city from address (take the city part before postcode/country)
  let city = '';
  const addr = meta._friendly_address || meta._address || '';
  if (addr) {
    // Try to extract city: usually the second-to-last or third-to-last comma-separated part
    const parts = addr.split(',').map(s => s.trim());
    if (parts.length >= 3) city = parts[parts.length - 3];
    else if (parts.length === 2) city = parts[0];
    else city = parts[0];
  }

  return {
    pool_id: null,
    name,
    address: addr,
    city,
    region: '',
    status: displayStatus,
    padeli_listing_id: wp.id,
    _padeli_link: wp.link || null,
    source: 'wordpress',
    phone: meta._phone || '',
    email: meta._email || '',
    website: meta._website || '',
    playtomic_url: meta._playtomic_url || meta._booking_link || '',
    courts_total: null,
    _cc: country,
    discovered_at: wp.date || null,
  };
}

function buildUnifiedProperties() {
  return {
    Name: { title: {} },
    Country: { select: { options: [] } },
    City: { rich_text: {} },
    Region: { rich_text: {} },
    Status: {
      select: {
        options: [
          { name: 'Discovered', color: 'default' },
          { name: 'Ready', color: 'purple' },
          { name: 'Needs Review', color: 'yellow' },
          { name: 'In Progress', color: 'blue' },
          { name: 'Drafted', color: 'orange' },
          { name: 'Published', color: 'green' },
          { name: 'Excluded', color: 'red' },
        ],
      },
    },
    Operator: { select: { options: [] } },
    'Locked At': { date: {} },
    Website: { url: {} },
    Phone: { phone_number: {} },
    Email: { email: {} },
    'Playtomic URL': { url: {} },
    'WP Listing ID': { number: {} },
    'Padeli Link': { url: {} },
    Courts: { number: {} },
    Source: { select: { options: [] } },
    'Pool ID': { number: {} },
    UID: { rich_text: {} },
    Discovered: { date: {} },
  };
}

function clubToUnifiedProperties(club, countryCode) {
  const displayStatus = DISPLAY_STATUS_MAP[club.status] || 'Discovered';
  const uid = `${countryCode}-${club.pool_id || 0}`;

  const props = {
    Name: { title: [{ text: { content: club.name || '' } }] },
    Country: { select: { name: countryCode } },
    City: { rich_text: [{ text: { content: club.city || '' } }] },
    Region: { rich_text: [{ text: { content: club.region || '' } }] },
    Status: { select: { name: displayStatus } },
    UID: { rich_text: [{ text: { content: uid } }] },
    Source: club.source ? { select: { name: club.source } } : undefined,
    'Pool ID': { number: typeof club.pool_id === 'number' ? club.pool_id : null },
  };

  if (club.website) props.Website = { url: club.website };
  if (club.phone) props.Phone = { phone_number: club.phone };
  if (club.email) props.Email = { email: club.email };
  if (club.playtomic_url) props['Playtomic URL'] = { url: club.playtomic_url };
  if (club.padeli_listing_id != null) {
    props['WP Listing ID'] = { number: Number(club.padeli_listing_id) };
  }
  if (club._padeli_link) props['Padeli Link'] = { url: club._padeli_link };
  if (club.courts_total != null) props.Courts = { number: Number(club.courts_total) };
  if (club.discovered_at) props.Discovered = { date: { start: club.discovered_at.slice(0, 10) } };

  // Remove undefined values
  for (const key of Object.keys(props)) {
    if (props[key] === undefined) delete props[key];
  }

  return props;
}

/**
 * Sync ALL country sheets + WP data to a single unified Notion database.
 *
 * @param {object} [options]
 * @param {boolean} [options.skipWP]          Skip WordPress pull
 * @param {boolean} [options.includeExcluded] Include duplicate/dropped/not_a_venue
 * @returns {Promise<object>}
 */
async function syncAllToNotion(options = {}) {
  // 1. Find all country sheets
  const files = readdirSync(DATA_DIR).filter(f => /^[A-Z]{2}-clubs\.json$/.test(f));
  const countryCodes = files.map(f => f.slice(0, 2));

  if (countryCodes.length === 0) throw new Error('No country sheets found in data/');
  console.log(`\nFound country sheets: ${countryCodes.join(', ')}`);

  // 2. Load all clubs with country tag
  const allClubs = [];
  for (const cc of countryCodes) {
    const clubs = loadSheet(cc);
    for (const club of clubs) {
      allClubs.push({ ...club, _cc: cc });
    }
  }
  console.log(`Total clubs from JSON: ${allClubs.length}`);

  // 3. Pull from WordPress
  let wpPublished = [];
  let wpRealDrafts = [];
  let wpPipelineTrials = [];

  if (!options.skipWP) {
    console.log('\nPulling from WordPress...');
    try {
      const wp = await pullFromWP();
      wpPublished = wp.published;
      wpRealDrafts = wp.realDrafts;
      wpPipelineTrials = wp.pipelineTrials;
      console.log(`  Published: ${wpPublished.length}`);
      console.log(`  Mark's drafts: ${wpRealDrafts.length}`);
      console.log(`  Pipeline trials (skipped): ${wpPipelineTrials.length}`);
    } catch (err) {
      console.warn(`  WP pull failed (continuing without): ${err.message}`);
    }
  }

  // 4. Match WP published listings to club entries
  const byWpId = new Map();
  const byNormName = new Map();
  for (let i = 0; i < allClubs.length; i++) {
    if (allClubs[i].padeli_listing_id) byWpId.set(Number(allClubs[i].padeli_listing_id), i);
    const key = normalise(allClubs[i].name);
    if (key && !byNormName.has(key)) byNormName.set(key, i);
  }

  let pubMatched = 0;
  let pubAdded = 0;
  for (const wp of wpPublished) {
    let idx = byWpId.has(wp.id) ? byWpId.get(wp.id) : -1;
    if (idx === -1) {
      const key = normalise(wp.title?.rendered || '');
      if (key && byNormName.has(key)) idx = byNormName.get(key);
    }

    if (idx !== -1) {
      const club = allClubs[idx];
      club.status = 'published';
      club.padeli_listing_id = wp.id;
      club._padeli_link = wp.link;
      // Enrich from WP meta if JSON fields are empty
      const meta = wp.meta || {};
      if (!club.phone && meta._phone) club.phone = meta._phone;
      if (!club.email && meta._email) club.email = meta._email;
      if (!club.website && meta._website) club.website = meta._website;
      if (!club.playtomic_url && (meta._playtomic_url || meta._booking_link)) {
        club.playtomic_url = meta._playtomic_url || meta._booking_link;
      }
      if (!club.address && (meta._friendly_address || meta._address)) {
        club.address = meta._friendly_address || meta._address;
      }
      pubMatched++;
    } else {
      // Published on WP but not in any JSON sheet — create enriched entry
      allClubs.push(wpToClub(wp, 'published'));
      pubAdded++;
    }
  }
  console.log(`\nWP published: ${pubMatched} matched to JSON, ${pubAdded} new (WP-only)`);

  // 5. Add Mark's real drafts (not in JSON) as "Drafted"
  let draftAdded = 0;
  for (const wp of wpRealDrafts) {
    let idx = byWpId.has(wp.id) ? byWpId.get(wp.id) : -1;
    if (idx === -1) {
      const key = normalise(wp.title?.rendered || '');
      if (key && byNormName.has(key)) idx = byNormName.get(key);
    }

    if (idx !== -1) {
      // Already in JSON — mark as drafted if not already published
      if (allClubs[idx].status !== 'published') {
        allClubs[idx].status = 'drafted';
        allClubs[idx].padeli_listing_id = wp.id;
      }
    } else {
      allClubs.push(wpToClub(wp, 'drafted'));
      draftAdded++;
    }
  }
  if (draftAdded > 0) console.log(`Added ${draftAdded} of Mark's WP drafts`);

  // 6. Filter excluded if needed
  const displayClubs = options.includeExcluded
    ? allClubs
    : allClubs.filter(c => (DISPLAY_STATUS_MAP[c.status] || 'Discovered') !== 'Excluded');

  console.log(`\nClubs for Notion: ${displayClubs.length} (${allClubs.length - displayClubs.length} excluded)`);

  // 7. Load or create unified Notion database
  let dbMeta;
  let isFirstRun = false;

  if (existsSync(UNIFIED_DB_FILE)) {
    dbMeta = JSON.parse(readFileSync(UNIFIED_DB_FILE, 'utf-8'));
    console.log(`\nExisting Notion DB: ${dbMeta.database_url}`);
  } else {
    console.log('\nCreating unified Notion database...');
    const body = {
      parent: { page_id: SYSTEMS_PAGE_ID },
      title: [{ type: 'text', text: { content: 'Padeli Club Tracker' } }],
      properties: buildUnifiedProperties(),
    };
    const result = await notionFetch('/databases', { method: 'POST', body: JSON.stringify(body) });
    dbMeta = { database_id: result.id, database_url: result.url, created_at: now() };
    writeFileSync(UNIFIED_DB_FILE, JSON.stringify(dbMeta, null, 2), 'utf-8');
    isFirstRun = true;
    console.log(`Created: ${dbMeta.database_url}`);
  }

  const databaseId = dbMeta.database_id;
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  if (isFirstRun) {
    // Create all pages in batches
    console.log(`\nCreating ${displayClubs.length} pages in batches of 10...`);
    const batches = [];
    for (let i = 0; i < displayClubs.length; i += 10) {
      batches.push(displayClubs.slice(i, i + 10));
    }

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const promises = batch.map(club =>
        notionFetch('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties: clubToUnifiedProperties(club, club._cc),
          }),
        })
      );
      await Promise.all(promises);
      created += batch.length;
      if ((b + 1) % 10 === 0 || b === batches.length - 1) {
        console.log(`  ${created}/${displayClubs.length} created`);
      }
      if (b < batches.length - 1) await sleep(350);
    }
  } else {
    // Query existing, match by UID, update or create
    console.log('Querying existing Notion pages...');
    const existingPages = await queryAllNotionPages(databaseId);
    console.log(`Found ${existingPages.length} existing pages in Notion.`);

    const pageByUID = new Map();
    for (const page of existingPages) {
      const uidProp = page.properties.UID;
      if (uidProp && uidProp.rich_text && uidProp.rich_text.length > 0) {
        pageByUID.set(uidProp.rich_text[0].plain_text, page);
      }
    }

    const toCreate = [];
    const toUpdate = [];

    for (const club of displayClubs) {
      const uid = `${club._cc}-${club.pool_id || 0}`;
      const existingPage = pageByUID.get(uid);

      if (existingPage) {
        // Check if status or key fields changed
        const existingStatus = existingPage.properties.Status?.select?.name || '';
        const newStatus = DISPLAY_STATUS_MAP[club.status] || 'Discovered';
        const existingWpId = existingPage.properties['WP Listing ID']?.number;
        const newWpId = club.padeli_listing_id != null ? Number(club.padeli_listing_id) : null;

        if (existingStatus !== newStatus || existingWpId !== newWpId) {
          toUpdate.push({ pageId: existingPage.id, club });
        } else {
          unchanged++;
        }
      } else {
        toCreate.push(club);
      }
    }

    // Update
    if (toUpdate.length > 0) {
      console.log(`Updating ${toUpdate.length} pages...`);
      const batches = [];
      for (let i = 0; i < toUpdate.length; i += 10) {
        batches.push(toUpdate.slice(i, i + 10));
      }
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const promises = batch.map(({ pageId, club }) =>
          notionFetch(`/pages/${pageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: clubToUnifiedProperties(club, club._cc) }),
          })
        );
        await Promise.all(promises);
        updated += batch.length;
        if (b < batches.length - 1) await sleep(350);
      }
    }

    // Create new
    if (toCreate.length > 0) {
      console.log(`Creating ${toCreate.length} new pages...`);
      const batches = [];
      for (let i = 0; i < toCreate.length; i += 10) {
        batches.push(toCreate.slice(i, i + 10));
      }
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const promises = batch.map(club =>
          notionFetch('/pages', {
            method: 'POST',
            body: JSON.stringify({
              parent: { database_id: databaseId },
              properties: clubToUnifiedProperties(club, club._cc),
            }),
          })
        );
        await Promise.all(promises);
        created += batch.length;
        if (b < batches.length - 1) await sleep(350);
      }
    }
  }

  console.log(`\n=== Unified Notion Sync Complete ===`);
  console.log(`  Database: ${dbMeta.database_url}`);
  console.log(`  Created:   ${created}`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Total:     ${displayClubs.length}`);

  return { database_id: databaseId, database_url: dbMeta.database_url, created, updated, unchanged, total: displayClubs.length };
}

// ---------------------------------------------------------------------------
// Notion-backed production queue (multi-machine safe)
// ---------------------------------------------------------------------------

/**
 * Return the operator name for this machine.
 * Set via PADELI_OPERATOR env var, or falls back to OS hostname.
 * @returns {string}
 */
function getOperatorName() {
  if (process.env.PADELI_OPERATOR) return process.env.PADELI_OPERATOR;
  try {
    return require('node:os').hostname().split('.')[0];
  } catch {
    return 'unknown';
  }
}

/**
 * Migrate the existing unified Notion DB to add multi-machine properties.
 * Safe to run multiple times — Notion ignores properties that already exist.
 * @returns {Promise<{migrated: boolean}>}
 */
async function migrateNotionSchema() {
  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) throw new Error('No unified Notion DB found. Run sync-all first.');

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  // PATCH adds new properties without affecting existing ones
  await notionFetch(`/databases/${databaseId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      properties: {
        Status: {
          select: {
            options: [
              { name: 'Discovered', color: 'default' },
              { name: 'Ready', color: 'purple' },
              { name: 'Needs Review', color: 'yellow' },
              { name: 'In Progress', color: 'blue' },
              { name: 'Drafted', color: 'orange' },
              { name: 'Published', color: 'green' },
              { name: 'Excluded', color: 'red' },
            ],
          },
        },
        Operator: { select: { options: [] } },
        'Locked At': { date: {} },
        Notes: { rich_text: {} },
        'Qualification Score': { number: {} },
        'Priority Score': { number: {} },
        Brand: { rich_text: {} },
      },
    }),
  });

  console.log('Notion schema migrated: added In Progress status, Operator, Locked At, Notes');
  return { migrated: true };
}

/**
 * Query the unified Notion DB for the next N pending pools for a country,
 * then atomically claim each one by setting status to "In Progress".
 *
 * This is the multi-machine-safe replacement for getNextBatch().
 *
 * @param {string} countryCode — ISO alpha-2 (e.g. "AE")
 * @param {number} n — how many pools to claim
 * @param {object} [options]
 * @param {string} [options.city] — filter by city (case-insensitive partial match)
 * @returns {Promise<Array<object>>} — array of claimed pool objects
 */
async function getNextBatchFromNotion(countryCode, n, options = {}) {
  const cc = countryCode.toUpperCase();
  const operator = getOperatorName();

  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) throw new Error('No unified Notion DB found. Run sync-all first.');

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  // Build filter: Status = Discovered OR Ready, AND Country = CC
  // "Ready" venues have been pre-qualified by qualify-queue.js — prefer these.
  // "Discovered" venues haven't been qualified yet — still claimable if no Ready available.
  const filterConditions = [
    { or: [
      { property: 'Status', select: { equals: 'Ready' } },
      { property: 'Status', select: { equals: 'Discovered' } },
    ]},
    { property: 'Country', select: { equals: cc } },
  ];

  // Optional city filter
  if (options.city) {
    filterConditions.push({
      property: 'City',
      rich_text: { contains: options.city },
    });
  }

  // Query Notion for claimable pools — Ready (pre-qualified) and Discovered
  // Priority Score descending puts highest-quality venues first (qualify-queue sets this)
  // Request more than needed in case some claims fail (race condition safety)
  const queryBody = {
    filter: { and: filterConditions },
    sorts: [
      { property: 'Priority Score', direction: 'descending' },
      { property: 'Pool ID', direction: 'ascending' },
    ],
    page_size: Math.min(n * 2, 100),
  };

  const queryResult = await notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify(queryBody),
  });

  const candidates = queryResult.results || [];
  if (candidates.length === 0) {
    console.log(`  No pending pools found for ${cc}`);
    return [];
  }

  console.log(`  Found ${candidates.length} pending pools for ${cc}, claiming ${Math.min(n, candidates.length)}...`);

  // Claim pools one at a time — if another machine claimed it between
  // our query and our PATCH, the status won't be "Discovered" anymore.
  // We verify after claiming by checking the response.
  const claimed = [];
  const lockedAt = new Date().toISOString();

  for (const page of candidates) {
    if (claimed.length >= n) break;

    const pageId = page.id;
    const poolId = page.properties['Pool ID']?.number;
    const name = page.properties.Name?.title?.[0]?.plain_text || '';

    try {
      // Claim by setting to In Progress with operator and timestamp
      await notionFetch(`/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            Status: { select: { name: 'In Progress' } },
            Operator: { select: { name: operator } },
            'Locked At': { date: { start: lockedAt } },
          },
        }),
      });

      // Extract full pool data from the Notion page properties
      const pool = notionPageToPool(page, cc);
      claimed.push(pool);
      console.log(`    Claimed pool ${poolId}: ${name}`);

      // Small delay between claims to stay within rate limits
      if (claimed.length < n) await sleep(150);
    } catch (err) {
      console.log(`    Failed to claim pool ${poolId}: ${err.message} — skipping`);
    }
  }

  // Also update local JSON to stay in sync (best-effort)
  try {
    const localData = loadSheet(cc);
    for (const pool of claimed) {
      const entry = localData.find(c => c.pool_id === pool.pool_id);
      if (entry) {
        entry.status = 'in_progress';
        entry.updated_at = now();
      }
    }
    saveSheet(cc, localData);
  } catch (err) {
    console.log(`  Local JSON sync skipped: ${err.message}`);
  }

  console.log(`  Claimed ${claimed.length} pools for operator "${operator}"`);
  return claimed;
}

/**
 * Convert a Notion page from the unified Club Tracker back into a pool object
 * that the listing pipeline can consume.
 *
 * @param {object} page — Notion page object
 * @param {string} countryCode — ISO alpha-2
 * @returns {object} — pool object matching master sheet format
 */
function notionPageToPool(page, countryCode) {
  const p = page.properties;

  const getText = (prop) => {
    if (!prop) return '';
    if (prop.rich_text && prop.rich_text.length > 0) return prop.rich_text[0].plain_text || '';
    if (prop.title && prop.title.length > 0) return prop.title[0].plain_text || '';
    return '';
  };
  const getNumber = (prop) => (prop && prop.number != null) ? prop.number : null;
  const getUrl = (prop) => (prop && prop.url) ? prop.url : '';
  const getSelect = (prop) => (prop && prop.select) ? prop.select.name : '';
  const getPhone = (prop) => (prop && prop.phone_number) ? prop.phone_number : '';
  const getEmail = (prop) => (prop && prop.email) ? prop.email : '';
  const getDate = (prop) => (prop && prop.date && prop.date.start) ? prop.date.start : '';

  return {
    pool_id: getNumber(p['Pool ID']),
    name: getText(p.Name),
    address: getText(p.Address),
    city: getText(p.City),
    region: getText(p.Region),
    country_code: countryCode,
    phone: getPhone(p.Phone),
    email: getEmail(p.Email),
    website: getUrl(p.Website),
    playtomic_url: getUrl(p['Playtomic URL']),
    padeli_listing_id: getNumber(p['WP Listing ID']),
    courts_total: getNumber(p.Courts),
    source: getSelect(p.Source),
    status: 'in_progress',
    discovered_at: getDate(p.Discovered),
    _notion_page_id: page.id,
  };
}

/**
 * Update a single pool's status in the unified Notion DB.
 * This is the multi-machine-safe replacement for updateStatus() + linkListing().
 *
 * @param {string} countryCode — ISO alpha-2
 * @param {number} poolId — the pool_id to update
 * @param {string} newStatus — raw status (e.g. 'drafted', 'duplicate', 'dropped')
 * @param {object} [meta] — optional metadata to update
 * @param {number} [meta.wpListingId] — WP listing ID to link
 * @param {string} [meta.notes] — notes to set
 * @param {string} [meta.padeliLink] — padeli.com URL
 * @returns {Promise<{updated: boolean}>}
 */
async function updateNotionPoolStatus(countryCode, poolId, newStatus, meta = {}) {
  const cc = countryCode.toUpperCase();

  if (!VALID_STATUSES.has(newStatus)) {
    throw new Error(`Invalid status "${newStatus}". Valid: ${[...VALID_STATUSES].join(', ')}`);
  }

  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) throw new Error('No unified Notion DB found.');

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  // Find the page by Pool ID + Country
  const queryResult = await notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Pool ID', number: { equals: poolId } },
          { property: 'Country', select: { equals: cc } },
        ],
      },
      page_size: 1,
    }),
  });

  if (!queryResult.results || queryResult.results.length === 0) {
    console.log(`  [notion] Pool ${poolId} not found in Notion for ${cc}`);
    return { updated: false };
  }

  const pageId = queryResult.results[0].id;
  const displayStatus = DISPLAY_STATUS_MAP[newStatus] || 'Discovered';

  const props = {
    Status: { select: { name: displayStatus } },
  };

  // Clear operator and lock when moving out of in_progress
  if (newStatus !== 'in_progress') {
    props.Operator = { select: null };
    props['Locked At'] = { date: null };
  }

  if (meta.wpListingId != null) {
    props['WP Listing ID'] = { number: Number(meta.wpListingId) };
  }

  if (meta.padeliLink) {
    props['Padeli Link'] = { url: meta.padeliLink };
  }

  if (meta.notes) {
    props.Notes = { rich_text: [{ text: { content: meta.notes.slice(0, 2000) } }] };
  }

  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });

  console.log(`  [notion] Pool ${poolId} → ${displayStatus}${meta.wpListingId ? ` (WP ${meta.wpListingId})` : ''}`);

  // Also update local JSON (best-effort)
  try {
    const localData = loadSheet(cc);
    const entry = localData.find(c => c.pool_id === poolId);
    if (entry) {
      entry.status = newStatus;
      entry.updated_at = now();
      if (meta.wpListingId != null) entry.padeli_listing_id = meta.wpListingId;
      if (meta.notes) entry.notes = entry.notes ? `${entry.notes}; ${meta.notes}` : meta.notes;
      saveSheet(cc, localData);
    }
  } catch (err) {
    // Non-blocking — Notion is the source of truth
  }

  return { updated: true };
}

/**
 * Find and release pools that have been in "In Progress" state for too long.
 * Resets them back to "Discovered" so they can be picked up again.
 *
 * @param {number} [maxMinutes=120] — maximum age in minutes before considering stale
 * @returns {Promise<{released: number, stale: Array<{poolId: number, operator: string, lockedAt: string}>}>}
 */
async function releaseStaleNotionLocks(maxMinutes = 120) {
  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) throw new Error('No unified Notion DB found.');

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  // Query all "In Progress" pools
  const queryResult = await notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Status', select: { equals: 'In Progress' } },
      page_size: 100,
    }),
  });

  const inProgress = queryResult.results || [];
  if (inProgress.length === 0) {
    console.log('  No in-progress pools found');
    return { released: 0, stale: [] };
  }

  const cutoff = new Date(Date.now() - maxMinutes * 60 * 1000);
  const stale = [];

  for (const page of inProgress) {
    const lockedAtProp = page.properties['Locked At'];
    const lockedAt = lockedAtProp?.date?.start ? new Date(lockedAtProp.date.start) : null;
    const operatorProp = page.properties.Operator;
    const operator = operatorProp?.select?.name || 'unknown';
    const poolId = page.properties['Pool ID']?.number;
    const name = page.properties.Name?.title?.[0]?.plain_text || '';

    // If no lock timestamp or lock is older than cutoff, it's stale
    if (!lockedAt || lockedAt < cutoff) {
      stale.push({ pageId: page.id, poolId, name, operator, lockedAt: lockedAt?.toISOString() || 'unknown' });
    }
  }

  if (stale.length === 0) {
    console.log(`  ${inProgress.length} pools in progress, none stale (cutoff: ${maxMinutes}min)`);
    return { released: 0, stale: [] };
  }

  console.log(`  Found ${stale.length} stale locks (older than ${maxMinutes}min):`);

  for (const entry of stale) {
    try {
      await notionFetch(`/pages/${entry.pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          properties: {
            Status: { select: { name: 'Discovered' } },
            Operator: { select: null },
            'Locked At': { date: null },
          },
        }),
      });
      console.log(`    Released pool ${entry.poolId}: ${entry.name} (was ${entry.operator})`);
      await sleep(150);
    } catch (err) {
      console.log(`    Failed to release pool ${entry.poolId}: ${err.message}`);
    }
  }

  return { released: stale.length, stale };
}

/**
 * Show the current production queue status from Notion.
 * Returns counts by status and any in-progress pools with their operators.
 *
 * @param {string} [countryCode] — optional filter by country
 * @returns {Promise<object>}
 */
async function getNotionQueueStatus(countryCode) {
  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) throw new Error('No unified Notion DB found.');

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  // Query all pages (or filtered by country)
  const filter = countryCode
    ? { property: 'Country', select: { equals: countryCode.toUpperCase() } }
    : undefined;

  const allPages = [];
  let cursor = undefined;

  while (true) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;

    const result = await notionFetch(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    allPages.push(...result.results);
    if (!result.has_more) break;
    cursor = result.next_cursor;
  }

  // Count by status
  const byStatus = {};
  const inProgressDetails = [];

  for (const page of allPages) {
    const status = page.properties.Status?.select?.name || 'Unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;

    if (status === 'In Progress') {
      inProgressDetails.push({
        poolId: page.properties['Pool ID']?.number,
        name: page.properties.Name?.title?.[0]?.plain_text || '',
        operator: page.properties.Operator?.select?.name || 'unknown',
        lockedAt: page.properties['Locked At']?.date?.start || 'unknown',
        country: page.properties.Country?.select?.name || '',
      });
    }
  }

  return { total: allPages.length, byStatus, inProgressDetails };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function cli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const countryCode = args[1];

  // Commands that don't need a country code
  const noCountryCommands = new Set(['sync-all', 'wp-summary', 'migrate-schema', 'release-stale', 'queue-status']);
  if (noCountryCommands.has(command)) {
    // handled in switch below — skip country check
  } else if (!command || !countryCode) {
    console.log('Usage:');
    console.log('  node master-sheet.js summary <CC>');
    console.log('  node master-sheet.js status <CC> <status>');
    console.log('  node master-sheet.js backup <CC>');
    console.log('  node master-sheet.js import <CC> <file.json>');
    console.log('  node master-sheet.js next <CC> <N>');
    console.log('  node master-sheet.js sync-notion <CC>');
    console.log('  node master-sheet.js sync-all');
    console.log('  node master-sheet.js wp-summary');
    console.log('');
    console.log('Multi-machine production:');
    console.log('  node master-sheet.js claim <CC> <N>        # claim N pools from Notion queue');
    console.log('  node master-sheet.js queue-status [CC]     # show Notion queue status');
    console.log('  node master-sheet.js release-stale [mins]  # release stale locks (default 120min)');
    console.log('  node master-sheet.js migrate-schema        # add multi-machine properties to Notion DB');
    process.exit(1);
  }

  const cc = countryCode ? countryCode.toUpperCase() : null;

  switch (command) {
    case 'summary': {
      const summary = getSummary(cc);
      console.log(`\n=== ${cc} Club Sheet Summary ===\n`);
      console.log(`Total clubs: ${summary.total}\n`);

      console.log('By Status:');
      for (const [status, count] of Object.entries(summary.by_status).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${status.padEnd(15)} ${count}`);
      }

      console.log('\nBy City:');
      for (const [city, count] of Object.entries(summary.by_city).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${city.padEnd(25)} ${count}`);
      }

      console.log('\nBy Source:');
      for (const [source, count] of Object.entries(summary.by_source).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${source.padEnd(20)} ${count}`);
      }
      break;
    }

    case 'status': {
      const status = args[2];
      if (!status) {
        console.log('Usage: node master-sheet.js status <CC> <status>');
        console.log(`Valid statuses: ${[...VALID_STATUSES].join(', ')}`);
        process.exit(1);
      }
      if (!VALID_STATUSES.has(status)) {
        console.error(`Invalid status "${status}". Valid: ${[...VALID_STATUSES].join(', ')}`);
        process.exit(1);
      }
      const clubs = getByStatus(cc, status);
      console.log(`\n=== ${cc} Clubs with status "${status}" (${clubs.length}) ===\n`);
      for (const club of clubs) {
        const wpId = club.padeli_listing_id ? ` [WP#${club.padeli_listing_id}]` : '';
        console.log(`  #${club.pool_id}  ${club.name} — ${club.city}${wpId}`);
      }
      if (clubs.length === 0) console.log('  (none)');
      break;
    }

    case 'backup': {
      try {
        const dest = backupSheet(cc);
        console.log(`Backup created: ${dest}`);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      break;
    }

    case 'import': {
      const filePath = args[2];
      if (!filePath) {
        console.log('Usage: node master-sheet.js import <CC> <file.json>');
        process.exit(1);
      }
      const absPath = require('node:path').resolve(filePath);
      if (!existsSync(absPath)) {
        console.error(`File not found: ${absPath}`);
        process.exit(1);
      }
      const raw = readFileSync(absPath, 'utf-8');
      let clubs;
      try {
        clubs = JSON.parse(raw);
      } catch (e) {
        console.error(`Invalid JSON: ${e.message}`);
        process.exit(1);
      }
      if (!Array.isArray(clubs)) {
        console.error('JSON file must contain an array of club objects.');
        process.exit(1);
      }
      const result = addClubs(cc, clubs);
      console.log(`\n=== Import to ${cc} ===`);
      console.log(`  Added:   ${result.added}`);
      console.log(`  Skipped: ${result.skipped} (duplicates)`);
      console.log(`  Total:   ${result.total}`);
      break;
    }

    case 'next': {
      const n = parseInt(args[2], 10) || 10;
      const batch = getNextBatch(cc, n);
      console.log(`\n=== Next ${n} pending clubs for ${cc} (showing ${batch.length}) ===\n`);
      for (const club of batch) {
        const src = club.source ? ` [${club.source}]` : '';
        console.log(`  #${club.pool_id}  ${club.name} — ${club.city}${src}`);
      }
      if (batch.length === 0) console.log('  (none pending)');
      break;
    }

    case 'sync-notion': {
      syncToNotion(cc).catch(err => {
        console.error(`Notion sync failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case 'sync-all': {
      syncAllToNotion({ includeExcluded: args.includes('--include-excluded') }).catch(err => {
        console.error(`Unified sync failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case 'wp-summary': {
      pullFromWP().then(wp => {
        console.log(`\n=== WordPress Summary ===`);
        console.log(`  Published listings: ${wp.published.length}`);
        console.log(`  Mark's drafts:      ${wp.realDrafts.length}`);
        console.log(`  Pipeline trials:    ${wp.pipelineTrials.length} (will be skipped)`);
      }).catch(err => {
        console.error(`WP pull failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case 'claim': {
      const n = parseInt(args[2], 10) || 5;
      getNextBatchFromNotion(cc, n).then(claimed => {
        console.log(`\n=== Claimed ${claimed.length} pools for ${cc} ===\n`);
        for (const pool of claimed) {
          console.log(`  #${pool.pool_id}  ${pool.name} — ${pool.city}`);
        }
        if (claimed.length === 0) console.log('  (none available)');
      }).catch(err => {
        console.error(`Claim failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case 'migrate-schema': {
      migrateNotionSchema().then(() => {
        console.log('Schema migration complete.');
      }).catch(err => {
        console.error(`Migration failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case 'release-stale': {
      const maxMins = parseInt(args[1], 10) || 120;
      releaseStaleNotionLocks(maxMins).then(result => {
        console.log(`\nReleased ${result.released} stale locks.`);
      }).catch(err => {
        console.error(`Release failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    case 'queue-status': {
      const filterCC = args[1] || null;
      getNotionQueueStatus(filterCC).then(result => {
        console.log(`\n=== Notion Queue Status${filterCC ? ` (${filterCC})` : ''} ===\n`);
        console.log(`Total: ${result.total}\n`);
        console.log('By Status:');
        for (const [status, count] of Object.entries(result.byStatus).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${status.padEnd(15)} ${count}`);
        }
        if (result.inProgressDetails.length > 0) {
          console.log('\nIn Progress:');
          for (const item of result.inProgressDetails) {
            console.log(`  #${item.poolId}  ${item.name} — ${item.country} (${item.operator}, since ${item.lockedAt})`);
          }
        }
      }).catch(err => {
        console.error(`Queue status failed: ${err.message}`);
        process.exit(1);
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log('Commands: summary, status, backup, import, next, sync-notion, sync-all, wp-summary, claim, queue-status, release-stale, migrate-schema');
      process.exit(1);
  }
}

// Run CLI if executed directly
if (require.main === module) {
  cli();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadSheet,
  saveSheet,
  addClubs,
  updateStatus,
  linkListing,
  getByStatus,
  getSummary,
  backupSheet,
  syncFromWP,
  getNextBatch,
  bulkUpdateStatus,
  syncToNotion,
  pullFromWP,
  syncAllToNotion,
  // Multi-machine production queue (Notion-backed)
  getOperatorName,
  migrateNotionSchema,
  getNextBatchFromNotion,
  updateNotionPoolStatus,
  releaseStaleNotionLocks,
  getNotionQueueStatus,
};
