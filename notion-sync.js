/**
 * notion-sync.js — Post-pipeline Notion sync for all Padeli agents.
 *
 * Called automatically at the end of listing and blog pipelines to keep
 * Notion dashboards in sync without manual CLI runs.
 *
 * Four sync targets:
 *   syncListingToNotion(venue, pipelineResult)  — update Club Tracker
 *   syncBlogToNotion(brief, wpPost)             — update Blog Tracker
 *   syncTournamentToNotion(record)              — update Tournament Tracker
 *   logAgentRun(agentName, action, details)     — append to Agent History DB
 *
 * All functions are safe — errors are caught and logged, never thrown.
 * A Notion failure must never break the pipeline.
 *
 * Node.js v24+ — zero external dependencies.
 */

const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const DATA_DIR = join(__dirname, '..', 'data');
const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const SYSTEMS_PAGE_ID = '346d1b51-fb30-8096-9126-e397b0c4ca91';
const AGENT_REGISTRY_DB = '35bd1b51-fb30-81f0-9ea4-ea1f2adfa713';
const OPERATIONS_BOARD_DB = '35bd1b51-fb30-81cb-842c-ce4cb517da9a';
const DELIVERABLES_DB = '35bd1b51-fb30-81f4-9973-de40d13ab0e3';

// Cached Agent History DB ID — resolved on first use
const AGENT_HISTORY_DB_FILE = join(DATA_DIR, 'agent-history-db.json');
let _agentHistoryDbId = null;

// Cached agent page IDs — resolved on first use per agent name
const _agentPageIdCache = new Map();

// ---------------------------------------------------------------------------
// Notion API helpers
// ---------------------------------------------------------------------------

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
      console.log(`  [notion-sync] Rate limited — waiting ${wait / 1000}s...`);
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

// ---------------------------------------------------------------------------
// 1. syncListingToNotion — update Club Tracker after listing pipeline
// ---------------------------------------------------------------------------

/**
 * Update or create a single venue in the unified Notion Club Tracker
 * after the listing pipeline completes.
 *
 * @param {object} venue     — venue object with name, city, country_code, pool_id, etc.
 * @param {object} result    — pipeline result with pushed, listingId, stages, etc.
 * @returns {Promise<{synced: boolean, action: string}>}
 */
async function syncListingToNotion(venue, result) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping listing sync');
      return { synced: false, action: 'skipped' };
    }

    // Load the unified DB ID
    const dbFile = join(DATA_DIR, 'unified-notion-db.json');
    if (!existsSync(dbFile)) {
      console.log('  [notion-sync] No unified Notion DB found — skipping listing sync');
      return { synced: false, action: 'no_db' };
    }

    const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
    const databaseId = dbMeta.database_id;

    // Determine new status based on pipeline result
    let status = 'drafted';
    if (result.pushed && result.stages?.push === 'done') {
      status = 'drafted'; // pipeline pushes as WP draft
    } else if (result.stages?.push === 'failed') {
      status = 'needs-manual';
    }

    // Try to find existing page by pool_id or name
    const searchFilter = venue.pool_id != null
      ? { property: 'Pool ID', number: { equals: venue.pool_id } }
      : { property: 'Name', title: { equals: venue.name || '' } };

    const existing = await notionFetch(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ filter: searchFilter, page_size: 1 }),
    });

    const props = buildListingProps(venue, result, status);

    if (existing.results && existing.results.length > 0) {
      // Update existing page
      const pageId = existing.results[0].id;
      await notionFetch(`/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      });
      console.log('  [notion-sync] Club Tracker updated (existing page patched)');
      return { synced: true, action: 'updated' };
    } else {
      // Create new page
      await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: props,
        }),
      });
      console.log('  [notion-sync] Club Tracker updated (new page created)');
      return { synced: true, action: 'created' };
    }
  } catch (err) {
    console.log(`  [notion-sync] Listing sync failed (non-blocking): ${err.message}`);
    return { synced: false, action: 'error', error: err.message };
  }
}

function buildListingProps(venue, result, status) {
  const displayStatus = {
    drafted: 'Drafted', published: 'Published', 'needs-manual': 'Excluded',
  }[status] || status;

  const props = {
    Name: { title: [{ text: { content: venue.name || '' } }] },
    Status: { select: { name: displayStatus } },
    // Clear multi-machine lock fields when pipeline completes
    Operator: { select: null },
    'Locked At': { date: null },
  };

  if (venue.city) props.City = { rich_text: [{ text: { content: venue.city } }] };
  if (venue.phone) props.Phone = { phone_number: venue.phone };
  if (venue.website) props.Website = { url: venue.website };
  if (venue.pool_id != null) props['Pool ID'] = { number: venue.pool_id };
  if (venue.courts_total != null) props.Courts = { number: Number(venue.courts_total) || null };
  if (venue.source) props.Source = { select: { name: venue.source } };
  if (venue.country_code) props.Country = { select: { name: venue.country_code } };
  if (venue.email) props.Email = { email: venue.email };
  if (venue.playtomic_url) props['Playtomic URL'] = { url: venue.playtomic_url };
  if (venue.address) props.Address = { rich_text: [{ text: { content: venue.address } }] };
  if (venue.google_rating != null) props['Google Rating'] = { number: Number(venue.google_rating) || null };
  if (venue.google_review_count != null) props['Google Reviews'] = { number: Number(venue.google_review_count) || null };

  // Add WP Listing ID from pipeline result
  const listingId = venue.listingId || result.wpResponse?.id;
  if (listingId) props['WP Listing ID'] = { number: Number(listingId) };

  // Add Padeli link — use clean permalink if slug available, fallback to query string
  if (listingId) {
    const slug = venue.slug || venue.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    props['Padeli Link'] = { url: slug ? `https://padeli.com/listing/${slug}/` : `https://padeli.com/?post_type=listing&p=${listingId}` };
  }

  return props;
}

// ---------------------------------------------------------------------------
// 2. syncBlogToNotion — update Blog Tracker after blog pipeline
// ---------------------------------------------------------------------------

/**
 * Create or update a single blog post in the Notion Blog Tracker
 * after the blog pipeline completes.
 *
 * @param {object} brief           — pipeline brief with title, slug, market, post_type, focus_keyword
 * @param {object} wpPost          — WP REST response { id, link, status, ... }
 * @param {object} [pipelineResult] — optional pipeline result with qc_attempts, word_count, etc.
 * @returns {Promise<{synced: boolean, action: string}>}
 */
async function syncBlogToNotion(brief, wpPost, pipelineResult) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping blog sync');
      return { synced: false, action: 'skipped' };
    }

    const dbFile = join(DATA_DIR, 'blog-notion-db.json');
    if (!existsSync(dbFile)) {
      console.log('  [notion-sync] No Blog Tracker DB found — skipping blog sync');
      return { synced: false, action: 'no_db' };
    }

    const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
    const databaseId = dbMeta.database_id;

    const wpPostId = wpPost?.id;
    if (!wpPostId) {
      console.log('  [notion-sync] No WP post ID — skipping blog sync');
      return { synced: false, action: 'no_wp_id' };
    }

    // Check if page already exists by WP Post ID
    const existing = await notionFetch(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: 'WP Post ID', number: { equals: wpPostId } },
        page_size: 1,
      }),
    });

    const props = buildBlogProps(brief, wpPost, pipelineResult);

    if (existing.results && existing.results.length > 0) {
      const pageId = existing.results[0].id;
      await notionFetch(`/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      });
      console.log('  [notion-sync] Blog Tracker updated (existing page patched)');
      return { synced: true, action: 'updated' };
    } else {
      await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: props,
        }),
      });
      console.log('  [notion-sync] Blog Tracker updated (new page created)');
      return { synced: true, action: 'created' };
    }
  } catch (err) {
    console.log(`  [notion-sync] Blog sync failed (non-blocking): ${err.message}`);
    return { synced: false, action: 'error', error: err.message };
  }
}

function buildBlogProps(brief, wpPost, pipelineResult) {
  const title = brief.title || '';
  const wpStatus = wpPost?.status || 'draft';
  const notionStatus = wpStatus === 'publish' ? 'Published' : 'Drafted';

  const props = {
    Title: { title: [{ text: { content: title.slice(0, 2000) } }] },
    Status: { select: { name: notionStatus } },
    'WP Post ID': { number: wpPost.id },
    Slug: { rich_text: [{ text: { content: brief.slug || '' } }] },
    Author: { select: { name: 'Ryan Spence' } },
    'Date Published': { date: { start: new Date().toISOString().slice(0, 10) } },
  };

  if (brief.post_type) {
    const typeMap = {
      'city_listicle': 'City Listicle',
      'product_listicle': 'Product Listicle',
      'pillar': 'Pillar Page',
      'cluster': 'Article',
      'leaf': 'Article',
      'how_to': 'How-To Guide',
    };
    const displayType = typeMap[brief.post_type] || brief.post_type;
    props['Post Type'] = { select: { name: displayType } };
  }

  if (brief.market) props.Market = { select: { name: brief.market.toUpperCase() } };
  if (brief.focus_keyword) props['Focus Keyword'] = { rich_text: [{ text: { content: brief.focus_keyword.slice(0, 2000) } }] };
  if (wpPost.link) props.URL = { url: wpPost.link };
  if (brief.word_count) props['Word Count'] = { number: Number(brief.word_count) || null };
  if (brief.category) props.Category = { multi_select: [{ name: brief.category }] };
  if (brief.tier) props.Tier = { select: { name: String(brief.tier) } };
  if (pipelineResult?.qc_attempts) props['QC Attempts'] = { number: pipelineResult.qc_attempts };

  return props;
}

// ---------------------------------------------------------------------------
// 3. logAgentRun — append to Agent History DB
// ---------------------------------------------------------------------------

/**
 * Log a pipeline run to the Agent History database in Notion.
 *
 * @param {string} agentName  — e.g. "Padeli Create Listing"
 * @param {string} action     — e.g. "Created", "Published", "Discovered"
 * @param {string} details    — human-readable summary of what happened
 * @returns {Promise<{logged: boolean}>}
 */
async function logAgentRun(agentName, action, details) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping agent history log');
      return { logged: false };
    }

    const dbId = await resolveAgentHistoryDb();
    if (!dbId) {
      console.log('  [notion-sync] Agent History DB not found — skipping log');
      return { logged: false };
    }

    const entryTitle = `${agentName}: ${action}`;
    const now = new Date().toISOString();

    await notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          Entry: { title: [{ text: { content: entryTitle.slice(0, 2000) } }] },
          Action: { select: { name: action } },
          Date: { date: { start: now.slice(0, 10) } },
          Details: { rich_text: [{ text: { content: (typeof details === 'string' ? details : JSON.stringify(details) || '').slice(0, 2000) } }] },
          Session: { rich_text: [{ text: { content: now } }] },
        },
      }),
    });

    console.log(`  [notion-sync] Agent History logged: ${entryTitle}`);
    return { logged: true };
  } catch (err) {
    console.log(`  [notion-sync] Agent History log failed (non-blocking): ${err.message}`);
    return { logged: false, error: err.message };
  }
}

/**
 * Also increment the Total Runs counter on the Agent Registry row.
 */
async function incrementAgentRuns(agentName) {
  try {
    if (!process.env.NOTION_API_KEY) return;

    // Query for the agent row
    const result = await notionFetch(`/databases/${AGENT_REGISTRY_DB}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100 }),
    });

    if (!result.results) return;

    for (const row of result.results) {
      const titleProp = row.properties['Agent Name'] || row.properties['Name'] ||
        Object.values(row.properties).find(p => p.type === 'title');
      if (!titleProp?.title?.[0]?.plain_text) continue;

      if (titleProp.title[0].plain_text === agentName) {
        const currentRuns = row.properties['Total Runs']?.number || 0;
        await notionFetch(`/pages/${row.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: { 'Total Runs': { number: currentRuns + 1 } },
          }),
        });
        console.log(`  [notion-sync] Agent Registry: ${agentName} runs → ${currentRuns + 1}`);
        return;
      }
    }
  } catch (err) {
    console.log(`  [notion-sync] Agent runs increment failed (non-blocking): ${err.message}`);
  }
}

/**
 * Resolve the Agent History DB ID — query Notion once, cache locally.
 */
async function resolveAgentHistoryDb() {
  // Check cached
  if (_agentHistoryDbId) return _agentHistoryDbId;

  // Check file cache
  if (existsSync(AGENT_HISTORY_DB_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(AGENT_HISTORY_DB_FILE, 'utf-8'));
      if (cached.database_id) {
        _agentHistoryDbId = cached.database_id;
        return _agentHistoryDbId;
      }
    } catch { /* ignore */ }
  }

  // Search Notion for Agent History database under the War Room
  try {
    const searchResult = await notionFetch('/search', {
      method: 'POST',
      body: JSON.stringify({
        query: 'Agent History',
        filter: { value: 'database', property: 'object' },
        page_size: 5,
      }),
    });

    for (const item of searchResult.results || []) {
      const title = item.title?.[0]?.plain_text || '';
      if (title === 'Agent History') {
        _agentHistoryDbId = item.id;
        // Cache to file
        writeFileSync(AGENT_HISTORY_DB_FILE, JSON.stringify({
          database_id: item.id,
          database_url: item.url,
          resolved_at: new Date().toISOString(),
        }, null, 2), 'utf-8');
        return _agentHistoryDbId;
      }
    }
  } catch (err) {
    console.log(`  [notion-sync] Could not search for Agent History DB: ${err.message}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. resolveAgentPageId — lookup agent page in Agent Registry (cached)
// ---------------------------------------------------------------------------

/**
 * Query the Agent Registry DB for a row matching agentName, cache and return
 * the page ID for use in relation properties.
 *
 * @param {string} agentName — e.g. "Padeli Create Listing"
 * @returns {Promise<string|null>} — Notion page ID or null
 */
async function resolveAgentPageId(agentName) {
  try {
    if (_agentPageIdCache.has(agentName)) return _agentPageIdCache.get(agentName);

    const result = await notionFetch(`/databases/${AGENT_REGISTRY_DB}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100 }),
    });

    if (!result.results) return null;

    for (const row of result.results) {
      const titleProp = row.properties['Agent Name'] || row.properties['Name'] ||
        Object.values(row.properties).find(p => p.type === 'title');
      if (!titleProp?.title?.[0]?.plain_text) continue;

      if (titleProp.title[0].plain_text === agentName) {
        _agentPageIdCache.set(agentName, row.id);
        return row.id;
      }
    }

    console.log(`  [notion-sync] Agent "${agentName}" not found in Agent Registry`);
    return null;
  } catch (err) {
    console.log(`  [notion-sync] resolveAgentPageId failed (non-blocking): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5. logToOperationsBoard — create a task row after pipeline run
// ---------------------------------------------------------------------------

/**
 * Create a new row in the Operations Board DB to track a pipeline task.
 *
 * @param {string} agentName  — e.g. "Padeli Create Listing"
 * @param {string} taskTitle  — e.g. "Create listing: Nordic Padel Tullamarine"
 * @param {string} status     — one of "Backlog", "In Progress", "Completed", "Failed"
 * @param {string} details    — human-readable summary
 * @returns {Promise<{logged: boolean}>}
 */
async function logToOperationsBoard(agentName, taskTitle, status, details) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping Operations Board log');
      return { logged: false };
    }

    const agentPageId = await resolveAgentPageId(agentName);
    const now = new Date().toISOString().slice(0, 10);

    // Operations Board schema: Task (title), Stage (select), Started (date),
    // Completed (date), Summary (rich_text), Agent (relation), Status (select)
    const detailsStr = typeof details === 'string' ? details : JSON.stringify(details) || '';
    const properties = {
      Task: { title: [{ text: { content: (taskTitle || '').slice(0, 2000) } }] },
      Stage: { select: { name: status } },
      Started: { date: { start: now } },
      Completed: status === 'Completed' ? { date: { start: now } } : undefined,
      Summary: { rich_text: [{ text: { content: detailsStr.slice(0, 2000) } }] },
    };
    // Remove undefined fields
    Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);

    if (agentPageId) {
      properties.Agent = { relation: [{ id: agentPageId }] };
    }

    await notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: OPERATIONS_BOARD_DB },
        properties,
      }),
    });

    console.log(`  [notion-sync] Operations Board logged: ${taskTitle}`);
    return { logged: true };
  } catch (err) {
    console.log(`  [notion-sync] Operations Board log failed (non-blocking): ${err.message}`);
    return { logged: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 6. logDeliverable — create a deliverable row after pipeline run
// ---------------------------------------------------------------------------

/**
 * Create a new row in the Deliverables DB to track a pipeline output.
 *
 * @param {string} agentName       — e.g. "Padeli Create Listing"
 * @param {string} title           — e.g. "Nordic Padel Tullamarine"
 * @param {string} deliverableType — "Listing", "Blog Post", or "Discovery Report"
 * @param {number} wpId            — WordPress post/listing ID
 * @param {string} url             — live or preview URL
 * @returns {Promise<{logged: boolean}>}
 */
async function logDeliverable(agentName, title, deliverableType, wpId, url) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping Deliverable log');
      return { logged: false };
    }

    const agentPageId = await resolveAgentPageId(agentName);
    const now = new Date().toISOString().slice(0, 10);

    const properties = {
      Deliverable: { title: [{ text: { content: (title || '').slice(0, 2000) } }] },
      Type: { select: { name: deliverableType } },
      Date: { date: { start: now } },
      Status: { select: { name: 'Draft' } },
    };

    if (agentPageId) {
      properties.Agent = { relation: [{ id: agentPageId }] };
    }

    if (wpId != null) {
      properties['WP ID'] = { number: Number(wpId) };
    }

    if (url) {
      properties.URL = { url: url };
    }

    await notionFetch('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: DELIVERABLES_DB },
        properties,
      }),
    });

    console.log(`  [notion-sync] Deliverable logged: ${title} (${deliverableType})`);
    return { logged: true };
  } catch (err) {
    console.log(`  [notion-sync] Deliverable log failed (non-blocking): ${err.message}`);
    return { logged: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Convenience: full post-pipeline sync (call one function, does everything)
// ---------------------------------------------------------------------------

/**
 * Run all Notion syncs after a listing pipeline completes.
 * Safe — catches all errors internally.
 */
async function afterListingPipeline(venue, pipelineResult) {
  console.log('\n--- Notion Sync ---');

  const listingSync = await syncListingToNotion(venue, pipelineResult);

  const details = [
    `Venue: ${venue.name || 'unknown'}`,
    `City: ${venue.city || 'unknown'}`,
    `Country: ${venue.country_code || 'unknown'}`,
    `WP ID: ${venue.listingId || pipelineResult.wpResponse?.id || 'none'}`,
    `Stages: ${Object.entries(pipelineResult.stages || {}).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `Errors: ${(pipelineResult.errors || []).length}`,
  ].join(' | ');

  const hasPushFailure = pipelineResult.stages?.push === 'failed';
  const hasErrors = (pipelineResult.errors || []).length > 0;
  const action = pipelineResult.pushed ? 'Created' : (hasErrors ? 'Failed' : 'Fixed');
  const opsStatus = pipelineResult.pushed ? 'Completed' : (hasPushFailure || hasErrors ? 'Failed' : 'Completed');

  await logAgentRun('Padeli Create Listing', action, details);
  await incrementAgentRuns('Padeli Create Listing');
  await logToOperationsBoard('Padeli Create Listing', `Create listing: ${venue.name}`, opsStatus, details);

  if (pipelineResult.pushed) {
    await logDeliverable('Padeli Create Listing', venue.name, 'Listing', venue.listingId || pipelineResult.wpResponse?.id, `https://padeli.com/?p=${venue.listingId || pipelineResult.wpResponse?.id}`);
  }

  console.log('--- Notion Sync Complete ---\n');
  return { listing: listingSync };
}

/**
 * Run all Notion syncs after a blog pipeline completes.
 * Safe — catches all errors internally.
 */
async function afterBlogPipeline(brief, wpPost, pipelineResult) {
  console.log('\n--- Notion Sync ---');

  const blogSync = await syncBlogToNotion(brief, wpPost, pipelineResult);

  const details = [
    `Title: ${brief.title || 'unknown'}`,
    `Type: ${brief.post_type || 'unknown'}`,
    `Market: ${brief.market || 'unknown'}`,
    `WP ID: ${wpPost?.id || 'none'}`,
    `Slug: ${brief.slug || 'unknown'}`,
    `QC attempts: ${pipelineResult?.qc_attempts || 1}`,
  ].join(' | ');

  const blogPushed = !!(wpPost?.id);
  const blogAction = blogPushed ? 'Created' : 'Failed';
  const blogOpsStatus = blogPushed ? 'Completed' : 'Failed';

  await logAgentRun('Padeli Produce Article', blogAction, details);
  await incrementAgentRuns('Padeli Produce Article');
  await logToOperationsBoard('Padeli Produce Article', `Write article: ${brief.title}`, blogOpsStatus, details);

  if (blogPushed) {
    await logDeliverable('Padeli Produce Article', brief.title, 'Blog Post', wpPost.id, wpPost.link);
  }

  console.log('--- Notion Sync Complete ---\n');
  return { blog: blogSync };
}

/**
 * Run Notion syncs after a club discovery pipeline completes.
 * Safe — catches all errors internally.
 *
 * @param {string} country    — country code or name
 * @param {object[]} clubs    — array of discovered club objects
 * @param {string} [source]   — source label (e.g. 'playtomic+matchi+google_places')
 * @returns {Promise<{logged: boolean}>}
 */
async function afterDiscoveryPipeline(country, clubs, source) {
  console.log('\n--- Notion Sync (Discovery) ---');

  try {
    const details = [
      `Country: ${country}`,
      `Clubs found: ${clubs.length}`,
      `Source: ${source || 'multi-source'}`,
    ].join(' | ');

    await logAgentRun('Padeli Discover Clubs', 'Discovered', details);
    await incrementAgentRuns('Padeli Discover Clubs');
    await logToOperationsBoard(
      'Padeli Discover Clubs',
      `Discover clubs: ${country} (${clubs.length} found)`,
      'Completed',
      details
    );

    // Sync individual clubs to the unified Club Tracker
    const clubSync = await syncDiscoveredClubsToNotion(country, clubs);

    console.log('--- Notion Sync Complete ---\n');
    return { logged: true, ...clubSync };
  } catch (err) {
    console.log(`  [notion-sync] Discovery sync failed (non-blocking): ${err.message}`);
    console.log('--- Notion Sync Complete ---\n');
    return { logged: false, error: err.message };
  }
}

/**
 * Push each discovered club to the unified Notion Club Tracker.
 * Creates new rows for clubs not yet in Notion, skips existing ones (by UID).
 * Uses the same schema as master-sheet.js syncAllToNotion.
 *
 * @param {string} countryCode — ISO alpha-2 country code
 * @param {object[]} clubs     — array of club objects from discover pipeline
 * @returns {Promise<{synced: number, skipped: number, errors: number}>}
 */
async function syncDiscoveredClubsToNotion(countryCode, clubs) {
  const result = { synced: 0, skipped: 0, errors: 0 };

  if (!process.env.NOTION_API_KEY) {
    console.log('  [notion-sync] NOTION_API_KEY not set — skipping club sync');
    return result;
  }

  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) {
    console.log('  [notion-sync] No unified Notion DB found — skipping club sync');
    return result;
  }

  // Filter out non-club objects (the discover pipeline sometimes passes null placeholders)
  const realClubs = clubs.filter(c => c && c.name);
  if (realClubs.length === 0) {
    console.log('  [notion-sync] No valid clubs to sync');
    return result;
  }

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  console.log(`  [notion-sync] Syncing ${realClubs.length} clubs to Club Tracker...`);

  // Query all existing UIDs to avoid duplicates (one query vs N queries)
  let existingUIDs = new Set();
  try {
    let hasMore = true;
    let startCursor = undefined;
    while (hasMore) {
      const query = { page_size: 100 };
      if (startCursor) query.start_cursor = startCursor;
      const res = await notionFetch(`/databases/${databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify(query),
      });
      for (const page of (res.results || [])) {
        const uidProp = page.properties.UID;
        if (uidProp?.rich_text?.[0]?.plain_text) {
          existingUIDs.add(uidProp.rich_text[0].plain_text);
        }
      }
      hasMore = res.has_more;
      startCursor = res.next_cursor;
    }
    console.log(`  [notion-sync] Found ${existingUIDs.size} existing clubs in Notion`);
  } catch (err) {
    console.log(`  [notion-sync] Could not query existing pages: ${err.message}`);
    // Continue anyway — worst case we create duplicates that can be cleaned up
  }

  // Push each club, batched with delays to respect rate limits
  for (const club of realClubs) {
    const uid = `${countryCode}-${club.pool_id || 0}`;

    if (existingUIDs.has(uid)) {
      result.skipped++;
      continue;
    }

    try {
      const props = buildDiscoveryProps(club, countryCode, uid);
      await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: props,
        }),
      });
      result.synced++;
      existingUIDs.add(uid); // prevent duplicates within same batch
      await sleep(350); // rate limit buffer
    } catch (err) {
      console.log(`  [notion-sync] Failed to sync "${club.name}": ${err.message}`);
      result.errors++;
    }
  }

  console.log(`  [notion-sync] Club sync done: ${result.synced} created, ${result.skipped} already existed, ${result.errors} errors`);
  return result;
}

/**
 * Build Notion properties for a discovered club.
 * Matches the unified Club Tracker schema from master-sheet.js.
 */
function buildDiscoveryProps(club, countryCode, uid) {
  const props = {
    Name: { title: [{ text: { content: club.name || '' } }] },
    Country: { select: { name: countryCode } },
    City: { rich_text: [{ text: { content: club.city || '' } }] },
    Region: { rich_text: [{ text: { content: club.region || '' } }] },
    Status: { select: { name: 'Discovered' } },
    UID: { rich_text: [{ text: { content: uid } }] },
    'Pool ID': { number: typeof club.pool_id === 'number' ? club.pool_id : null },
  };

  if (club.source) props.Source = { select: { name: club.source } };
  if (club.website) props.Website = { url: club.website };
  if (club.phone) props.Phone = { phone_number: club.phone };
  if (club.email) props.Email = { email: club.email };
  if (club.playtomic_url) props['Playtomic URL'] = { url: club.playtomic_url };
  if (club.courts_total != null) props.Courts = { number: Number(club.courts_total) };
  if (club.discovered_at) props.Discovered = { date: { start: club.discovered_at.slice(0, 10) } };
  // Rich Playtomic enrichment
  if (club.indoor_outdoor) props['Indoor/Outdoor'] = { select: { name: club.indoor_outdoor } };
  if (club.surface_type) props['Surface'] = { rich_text: [{ text: { content: club.surface_type } }] };
  if (club.playtomic_tenant_id) props['Playtomic ID'] = { rich_text: [{ text: { content: String(club.playtomic_tenant_id) } }] };
  if (club.booking_type) props['Booking Type'] = { select: { name: club.booking_type } };
  if (club.lat != null && club.lng != null) props['Coordinates'] = { rich_text: [{ text: { content: `${club.lat}, ${club.lng}` } }] };
  if (club.matchi_url) props['Matchi URL'] = { url: club.matchi_url };
  const imgCount = Array.isArray(club.images) ? club.images.length : 0;
  if (imgCount > 0) props['Images'] = { number: imgCount };
  const courtCount = Array.isArray(club.court_details) ? club.court_details.length : 0;
  if (courtCount > 0) props['Court Details'] = { rich_text: [{ text: { content: club.court_details.map(c => `${c.name || 'Court'} (${c.type || '?'}, ${c.feature || '?'})`).join('; ').slice(0, 2000) } }] };

  return props;
}

// ---------------------------------------------------------------------------
// 7. afterAuditPipeline — sync audit results back to Notion
// ---------------------------------------------------------------------------

/**
 * Run Notion syncs after an audit completes (single or batch).
 * Updates the relevant tracker row (Club Tracker or Blog Tracker) with audit
 * score and date, and logs the run to Agent History + Operations Board.
 *
 * @param {string} auditType    — 'listing' or 'post'
 * @param {object|object[]} results — single result or array of results
 * @param {object} [opts]       — { batch: bool, limit: number }
 * @returns {Promise<{logged: boolean, updated: number}>}
 */
async function afterAuditPipeline(auditType, results, opts = {}) {
  console.log('\n--- Notion Sync (Audit) ---');

  const items = Array.isArray(results) ? results : [results];
  const isBatch = opts.batch || items.length > 1;
  let updated = 0;

  // 1. Update individual tracker rows with audit score + date
  for (const result of items) {
    try {
      if (auditType === 'listing') {
        await syncAuditToClubTracker(result);
      } else {
        await syncAuditToBlogTracker(result);
      }
      updated++;
    } catch (err) {
      console.log(`  [notion-sync] Audit row update failed (non-blocking): ${err.message}`);
    }
  }

  // 2. Log the audit run
  const avgScore = items.length > 0
    ? Math.round(items.reduce((sum, r) => sum + (r.score || 0), 0) / items.length)
    : 0;

  const details = [
    `Type: ${auditType}`,
    `Items audited: ${items.length}`,
    `Avg score: ${avgScore}`,
    isBatch ? `Batch: yes` : `WP ID: ${items[0]?.wp_id || items[0]?.id || 'unknown'}`,
  ].join(' | ');

  const taskTitle = isBatch
    ? `Audit ${auditType}s (${items.length} items, avg ${avgScore})`
    : `Audit ${auditType}: ${items[0]?.title || items[0]?.name || 'unknown'} (score: ${items[0]?.score || 0})`;

  await logAgentRun('Padeli Audit Content', 'Audited', details);
  await incrementAgentRuns('Padeli Audit Content');
  await logToOperationsBoard('Padeli Audit Content', taskTitle, 'Completed', details);

  console.log(`  [notion-sync] Audit sync done: ${updated} tracker rows updated`);
  console.log('--- Notion Sync Complete ---\n');
  return { logged: true, updated };
}

/**
 * Update a Club Tracker row with audit results.
 * Finds by WP Listing ID, patches Audit Score + Last Audited.
 */
async function syncAuditToClubTracker(result) {
  if (!process.env.NOTION_API_KEY) return;

  const wpId = result.wp_id || result.id;
  if (!wpId) return;

  const dbFile = join(DATA_DIR, 'unified-notion-db.json');
  if (!existsSync(dbFile)) return;

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  const existing = await notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'WP Listing ID', number: { equals: Number(wpId) } },
      page_size: 1,
    }),
  });

  if (!existing.results?.length) {
    console.log(`  [notion-sync] No Club Tracker row for WP ID ${wpId} — skipping audit update`);
    return;
  }

  const pageId = existing.results[0].id;
  const props = {
    'Audit Score': { number: result.score || 0 },
    'Last Audited': { date: { start: new Date().toISOString().slice(0, 10) } },
  };

  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
  console.log(`  [notion-sync] Club Tracker audit updated: WP ID ${wpId}, score ${result.score}`);
}

/**
 * Update a Blog Tracker row with audit results.
 * Finds by WP Post ID, patches Audit Score + Last Audited.
 */
async function syncAuditToBlogTracker(result) {
  if (!process.env.NOTION_API_KEY) return;

  const wpId = result.wp_id || result.id;
  if (!wpId) return;

  const dbFile = join(DATA_DIR, 'blog-notion-db.json');
  if (!existsSync(dbFile)) return;

  const dbMeta = JSON.parse(readFileSync(dbFile, 'utf-8'));
  const databaseId = dbMeta.database_id;

  const existing = await notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'WP Post ID', number: { equals: Number(wpId) } },
      page_size: 1,
    }),
  });

  if (!existing.results?.length) {
    console.log(`  [notion-sync] No Blog Tracker row for WP ID ${wpId} — skipping audit update`);
    return;
  }

  const pageId = existing.results[0].id;
  const props = {
    'Audit Score': { number: result.score || 0 },
    'Last Audited': { date: { start: new Date().toISOString().slice(0, 10) } },
  };

  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
  console.log(`  [notion-sync] Blog Tracker audit updated: WP ID ${wpId}, score ${result.score}`);
}

// ---------------------------------------------------------------------------
// 8. registerSkillSOP — add a new skill card to the SOPs page + operator manual
// ---------------------------------------------------------------------------

const SOPS_PAGE = '35bd1b51-fb30-8113-9107-efb7a4e4912a';
const OPERATOR_MANUAL_PAGE = '35bd1b51-fb30-8138-b358-fa9c4c0a96ca';

/**
 * Register a new skill/pipeline on the Notion SOPs page.
 * Call this when building a new padeli skill to auto-add its SOP card.
 *
 * @param {object} skill
 * @param {string} skill.name       — e.g. "Padeli Audit Content"
 * @param {string} skill.command    — e.g. "/padeli:audit-content listings --limit 20"
 * @param {string} skill.emoji      — e.g. "🔎"
 * @param {string} skill.color      — Notion callout color e.g. "yellow_background"
 * @param {string} skill.summary    — one-line description
 * @param {string} skill.stages     — e.g. "5 layers (QC + Yoast + Expert + Live + GSC)"
 * @param {string} skill.output     — e.g. "Score + issue report"
 * @param {string} skill.time       — e.g. "1-5 min per page"
 * @param {string} skill.apis       — e.g. "WordPress, GSC/GA"
 * @param {string} skill.status     — e.g. "LIVE" or "CODE PENDING"
 */
async function registerSkillSOP(skill) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping SOP registration');
      return { registered: false };
    }

    const parts = [
      { type: 'text', text: { content: `${skill.name.toUpperCase()}\n` }, annotations: { bold: true } },
      { type: 'text', text: { content: `${skill.summary}\n\n` } },
      { type: 'text', text: { content: 'Command: ' }, annotations: { bold: true } },
      { type: 'text', text: { content: skill.command }, annotations: { code: true } },
      { type: 'text', text: { content: '\n' } },
      { type: 'text', text: { content: 'Stages: ' }, annotations: { bold: true } },
      { type: 'text', text: { content: `${skill.stages}\n` } },
      { type: 'text', text: { content: 'Output: ' }, annotations: { bold: true } },
      { type: 'text', text: { content: `${skill.output}\n` } },
      { type: 'text', text: { content: 'Time: ' }, annotations: { bold: true } },
      { type: 'text', text: { content: `${skill.time}\n` } },
      { type: 'text', text: { content: 'Status: ' }, annotations: { bold: true } },
      { type: 'text', text: { content: `${skill.status}\n\n` } },
      { type: 'text', text: { content: 'APIs: ' }, annotations: { bold: true } },
      { type: 'text', text: { content: skill.apis } },
    ];

    // Add the SOP card to the SOPs page
    await notionFetch(`/blocks/${SOPS_PAGE}/children`, {
      method: 'PATCH',
      body: JSON.stringify({
        children: [{
          object: 'block',
          type: 'callout',
          callout: {
            rich_text: parts,
            icon: { type: 'emoji', emoji: skill.emoji || '🤖' },
            color: skill.color || 'gray_background',
          },
        }],
      }),
    });

    console.log(`  [notion-sync] SOP card registered: ${skill.name}`);
    return { registered: true };
  } catch (err) {
    console.log(`  [notion-sync] SOP registration failed (non-blocking): ${err.message}`);
    return { registered: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 8. updateSkillRoadmap — move a skill between status columns automatically
// ---------------------------------------------------------------------------

const SKILLS_ROADMAP_DB = '35cd1b51-fb30-8124-bae9-d4e7b4bed7fc';

/**
 * Update a skill's status on the Skills & Systems Roadmap.
 * Call when a skill changes state (Planned → In Progress → Live).
 *
 * @param {string} skillName — e.g. "/padeli:audit-content"
 * @param {object} updates — { status?, blocker?, output?, apis?, syncs? }
 */
async function updateSkillRoadmap(skillName, updates = {}) {
  try {
    if (!process.env.NOTION_API_KEY) return { updated: false };

    // Find the row by name
    const searchRes = await notionFetch(`/databases/${SKILLS_ROADMAP_DB}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: 'Name', title: { equals: skillName } },
        page_size: 1,
      }),
    });

    const rows = searchRes.results || [];
    if (rows.length === 0) {
      // Skill not in roadmap yet — create it
      const props = {
        "Name": { title: [{ type: 'text', text: { content: skillName } }] },
      };
      if (updates.status) props["Status"] = { select: { name: updates.status } };
      if (updates.type) props["Type"] = { select: { name: updates.type } };
      if (updates.command) props["Command"] = { rich_text: [{ type: 'text', text: { content: updates.command } }] };
      if (updates.apis) props["APIs"] = { rich_text: [{ type: 'text', text: { content: updates.apis } }] };
      if (updates.output) props["Output"] = { rich_text: [{ type: 'text', text: { content: updates.output } }] };
      if (updates.blocker) props["Blocker"] = { rich_text: [{ type: 'text', text: { content: updates.blocker } }] };
      if (updates.priority) props["Priority"] = { select: { name: updates.priority } };
      if (updates.syncs) props["Auto-Syncs To"] = { rich_text: [{ type: 'text', text: { content: updates.syncs } }] };

      await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({ parent: { database_id: SKILLS_ROADMAP_DB }, properties: props }),
      });
      console.log(`  [notion-sync] Roadmap: created ${skillName} (${updates.status || 'Planned'})`);
      return { updated: true, action: 'created' };
    }

    // Update existing row
    const pageId = rows[0].id;
    const props = {};
    if (updates.status) props["Status"] = { select: { name: updates.status } };
    if (updates.blocker !== undefined) props["Blocker"] = { rich_text: updates.blocker ? [{ type: 'text', text: { content: updates.blocker } }] : [] };
    if (updates.output) props["Output"] = { rich_text: [{ type: 'text', text: { content: updates.output } }] };
    if (updates.apis) props["APIs"] = { rich_text: [{ type: 'text', text: { content: updates.apis } }] };
    if (updates.syncs) props["Auto-Syncs To"] = { rich_text: [{ type: 'text', text: { content: updates.syncs } }] };
    if (updates.priority) props["Priority"] = { select: { name: updates.priority } };

    if (Object.keys(props).length > 0) {
      await notionFetch(`/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      });
    }

    console.log(`  [notion-sync] Roadmap: updated ${skillName} → ${updates.status || 'no status change'}`);
    return { updated: true, action: 'patched' };
  } catch (err) {
    console.log(`  [notion-sync] Roadmap update failed (non-blocking): ${err.message}`);
    return { updated: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 9. syncTournamentToNotion — update Tournament Tracker after tournament publish
// ---------------------------------------------------------------------------

const TOURNAMENT_DB_FILE = join(DATA_DIR, 'tournament-notion-db.json');

// Tier slug → display name for Notion select
const TIER_DISPLAY = {
  'major': 'Major', 'p1': 'P1', 'p2': 'P2',
  'fip-gold': 'FIP Gold', 'fip-silver': 'FIP Silver', 'fip-bronze': 'FIP Bronze',
  'fip-promises': 'FIP Promises', 'national': 'National',
  'league': 'League', 'local-social': 'Local/Social',
};

// Source slug → display name
const SOURCE_DISPLAY = {
  'appt': 'APPT', 'fip': 'FIP', 'playtomic': 'Playtomic',
  'lta': 'LTA', 'manual': 'Manual',
};

/**
 * Create or update a single tournament in the Notion Tournament Tracker.
 *
 * @param {object} record — normalised tournament record from tournament-schema.js
 * @param {object} [opts] — { status: string } override Notion status
 * @returns {Promise<{synced: boolean, action: string}>}
 */
async function syncTournamentToNotion(record, opts = {}) {
  try {
    if (!process.env.NOTION_API_KEY) {
      console.log('  [notion-sync] NOTION_API_KEY not set — skipping tournament sync');
      return { synced: false, action: 'skipped' };
    }

    if (!existsSync(TOURNAMENT_DB_FILE)) {
      console.log('  [notion-sync] No Tournament Tracker DB found — run scripts/create-tournament-notion-db.js first');
      return { synced: false, action: 'no_db' };
    }

    const dbMeta = JSON.parse(readFileSync(TOURNAMENT_DB_FILE, 'utf-8'));
    const databaseId = dbMeta.database_id;

    if (!record.dedup_key) {
      console.log('  [notion-sync] Tournament has no dedup_key — skipping');
      return { synced: false, action: 'no_key' };
    }

    // Check if tournament already exists by dedup_key
    const existing = await notionFetch(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: 'Dedup Key', rich_text: { equals: record.dedup_key } },
        page_size: 1,
      }),
    });

    const props = buildTournamentProps(record, opts);

    if (existing.results && existing.results.length > 0) {
      const pageId = existing.results[0].id;
      await notionFetch(`/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: props }),
      });
      console.log(`  [notion-sync] Tournament Tracker updated: ${record.name}`);
      return { synced: true, action: 'updated' };
    } else {
      await notionFetch('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: props,
        }),
      });
      console.log(`  [notion-sync] Tournament Tracker created: ${record.name}`);
      return { synced: true, action: 'created' };
    }
  } catch (err) {
    console.log(`  [notion-sync] Tournament sync failed (non-blocking): ${err.message}`);
    return { synced: false, action: 'error', error: err.message };
  }
}

function buildTournamentProps(record, opts = {}) {
  // Determine Notion status
  let notionStatus = opts.status || 'New';
  if (record.padeli_post_id) notionStatus = 'Published';
  else if (record.status === 'drafted') notionStatus = 'Approved';

  // Check if tournament is in the past
  if (record.end_date || record.start_date) {
    const endStr = record.end_date || record.start_date;
    const endDate = new Date(endStr + 'T23:59:59');
    if (endDate < new Date()) notionStatus = 'Past';
  }

  const props = {
    'Name': { title: [{ text: { content: (record.name || '').slice(0, 2000) } }] },
    'Dedup Key': { rich_text: [{ text: { content: record.dedup_key || '' } }] },
    'Status': { select: { name: notionStatus } },
  };

  // Country
  if (record.country_code) {
    props['Country'] = { select: { name: record.country_code.toUpperCase() } };
  }

  // City
  if (record.city) {
    props['City'] = { rich_text: [{ text: { content: record.city } }] };
  }

  // Tier
  if (record.tier) {
    const tierName = TIER_DISPLAY[record.tier] || record.tier;
    props['Tier'] = { select: { name: tierName } };
  }

  // Source
  if (record.source) {
    const srcName = SOURCE_DISPLAY[record.source] || record.source;
    props['Source'] = { select: { name: srcName } };
  }

  // Dates
  if (record.start_date) {
    props['Start Date'] = { date: { start: record.start_date } };
  }
  if (record.end_date) {
    props['End Date'] = { date: { start: record.end_date } };
  }

  // Categories
  if (record.categories && record.categories.length > 0) {
    props['Categories'] = {
      multi_select: record.categories.map(c => ({ name: c })),
    };
  }

  // Registration
  if (record.registration_status) {
    const regMap = {
      'open': 'Open', 'closed': 'Closed',
      'coming-soon': 'Coming Soon', 'cancelled': 'Cancelled',
    };
    const regName = regMap[record.registration_status] || record.registration_status;
    props['Registration'] = { select: { name: regName } };
  }

  // WP Post ID
  if (record.padeli_post_id) {
    props['WP Post ID'] = { number: Number(record.padeli_post_id) };
    const slug = record.slug || record.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    props['Padeli Link'] = { url: `https://padeli.com/tournament/${slug}/` };
  }

  // URLs
  if (record.source_url) {
    props['Source URL'] = { url: record.source_url };
  }
  if (record.poster_image_url) {
    props['Poster URL'] = { url: record.poster_image_url };
  }

  // Venue
  if (record.venue_name) {
    props['Venue'] = { rich_text: [{ text: { content: record.venue_name.slice(0, 2000) } }] };
  }

  // Fee
  const fee = record.fee_pro || record.fee_amateur || record.fee_raw;
  if (fee) {
    props['Fee'] = { rich_text: [{ text: { content: String(fee).slice(0, 2000) } }] };
  }

  // Prize
  if (record.prize_total) {
    props['Prize Total'] = { rich_text: [{ text: { content: String(record.prize_total).slice(0, 2000) } }] };
  }

  // Organiser
  if (record.organiser) {
    props['Organiser'] = { select: { name: record.organiser } };
  }

  // Circuit
  if (record.circuit) {
    props['Circuit'] = { rich_text: [{ text: { content: record.circuit } }] };
  }

  // Scraped date
  if (record.discovered_at) {
    props['Scraped At'] = { date: { start: record.discovered_at.slice(0, 10) } };
  }

  // Published date
  if (record.published_at) {
    props['Published At'] = { date: { start: record.published_at.slice(0, 10) } };
  }

  return props;
}

/**
 * Batch sync multiple tournament records to Notion.
 * Used after a scraper run to push all new/updated tournaments.
 *
 * @param {object[]} records — array of normalised tournament records
 * @param {object} [opts] — { status: string, limit: number }
 * @returns {Promise<{synced: number, skipped: number, errors: number}>}
 */
async function batchSyncTournamentsToNotion(records, opts = {}) {
  const result = { synced: 0, skipped: 0, errors: 0 };

  if (!process.env.NOTION_API_KEY) {
    console.log('  [notion-sync] NOTION_API_KEY not set — skipping tournament batch sync');
    return result;
  }

  if (!existsSync(TOURNAMENT_DB_FILE)) {
    console.log('  [notion-sync] No Tournament Tracker DB found — skipping batch sync');
    return result;
  }

  const limit = opts.limit || records.length;
  const toSync = records.slice(0, limit);

  console.log(`  [notion-sync] Batch syncing ${toSync.length} tournaments to Notion...`);

  for (const record of toSync) {
    try {
      const res = await syncTournamentToNotion(record, opts);
      if (res.synced) result.synced++;
      else result.skipped++;
      await sleep(350); // rate limit buffer
    } catch (err) {
      console.log(`  [notion-sync] Failed: ${record.name}: ${err.message}`);
      result.errors++;
    }
  }

  console.log(`  [notion-sync] Tournament batch sync done: ${result.synced} synced, ${result.skipped} skipped, ${result.errors} errors`);
  return result;
}

/**
 * Run all Notion syncs after a tournament pipeline completes.
 * Safe — catches all errors internally.
 *
 * @param {object} record — normalised tournament record
 * @param {object} publishResult — { pushed, postId, mediaId }
 * @returns {Promise<{tournament: object}>}
 */
async function afterTournamentPipeline(record, publishResult) {
  console.log('\n--- Notion Sync (Tournament) ---');

  const tournamentSync = await syncTournamentToNotion(record, {
    status: publishResult?.pushed ? 'Published' : 'Approved',
  });

  const details = [
    `Tournament: ${record.name || 'unknown'}`,
    `Country: ${record.country_code || 'unknown'}`,
    `Tier: ${record.tier || 'unknown'}`,
    `Source: ${record.source || 'unknown'}`,
    `WP ID: ${record.padeli_post_id || publishResult?.postId || 'none'}`,
  ].join(' | ');

  const action = publishResult?.pushed ? 'Created' : 'Drafted';
  const opsStatus = publishResult?.pushed ? 'Completed' : 'In Progress';

  await logAgentRun('Padeli Create Tournament', action, details);
  await incrementAgentRuns('Padeli Create Tournament');
  await logToOperationsBoard('Padeli Create Tournament', `Publish tournament: ${record.name}`, opsStatus, details);

  if (publishResult?.pushed) {
    const wpId = record.padeli_post_id || publishResult?.postId;
    await logDeliverable('Padeli Create Tournament', record.name, 'Tournament', wpId, `https://padeli.com/?p=${wpId}`);
  }

  console.log('--- Notion Sync Complete ---\n');
  return { tournament: tournamentSync };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  syncListingToNotion,
  syncBlogToNotion,
  syncTournamentToNotion,
  batchSyncTournamentsToNotion,
  syncDiscoveredClubsToNotion,
  syncAuditToClubTracker,
  syncAuditToBlogTracker,
  logAgentRun,
  incrementAgentRuns,
  resolveAgentPageId,
  logToOperationsBoard,
  logDeliverable,
  afterListingPipeline,
  afterBlogPipeline,
  afterDiscoveryPipeline,
  afterAuditPipeline,
  afterTournamentPipeline,
  registerSkillSOP,
  updateSkillRoadmap,
};
