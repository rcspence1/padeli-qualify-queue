---
name: padeli:qualify-queue
description: "Pre-qualify the Notion production queue before running create-listing. 10-layer sweep: dedup (internal + WP), name cleaning, Playtomic liveness, Google Places verification, website check, geographic validation, completeness scoring, brand detection, priority ranking. Moves venues from Discovered → Ready / Needs Review / Excluded. Use before any batch listing production."
user-invocable: true
---

# Padeli Qualify Queue

Run BEFORE `/padeli:create-listing` on any country. Sweeps all "Discovered" venues in Notion, verifies them across Playtomic, Google, and their own websites, and sorts them into Ready (produce), Needs Review (check manually), or Excluded (skip) with reasons.

**Pipeline:** query Notion → dedup (internal) → dedup (vs WP) → clean names → Playtomic check → Google Places check → website check → geo validation → completeness score → brand detection → priority score → update Notion

**Result:** When you run `next 5 AE` after qualifying, every venue in the queue is verified, enriched, and ranked by priority. No wasted pipeline runs.

---

## Input Modes

### Mode 1: Qualify a country

```
/padeli:qualify-queue AE
/padeli:qualify-queue GB
/padeli:qualify-queue ES --limit 50
```

Processes all "Discovered" venues for that country.

### Mode 2: Dry run (preview only)

```
/padeli:qualify-queue AE --dry-run
```

Runs all checks but doesn't update Notion. Shows what would happen.

### Mode 3: Fast mode (skip website checks)

```
/padeli:qualify-queue AE --skip-website
```

Skips Layer 6 (website verification). Faster for large batches — website checks take ~1s each.

### Mode 4: Single venue

```
/padeli:qualify-queue single <notion-page-id>
```

Qualify one specific venue by its Notion page ID.

---

## Execution Steps

### Step 1: Parse Input

Extract country code and options from user's message.

### Step 2: Run Qualification

```bash
node -e "
const { qualifyCountry } = require('./qualify-queue');
qualifyCountry('{CC}', { dryRun: false, limit: null }).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

For dry run:
```bash
node -e "
const { qualifyCountry } = require('./qualify-queue');
qualifyCountry('{CC}', { dryRun: true }).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

For single venue:
```bash
node -e "
const { qualifySingle } = require('./qualify-queue');
qualifySingle('{NOTION_PAGE_ID}').then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Or via CLI:
```bash
cd ~/Projects/padeli-qualify-queue
node qualify-queue.js AE
node qualify-queue.js AE --dry-run
node qualify-queue.js AE --limit 50
node qualify-queue.js AE --skip-website
node qualify-queue.js single <notion-page-id>
```

### Step 3: Review Results

The module logs progress at each layer and prints a summary:

```
QUALIFICATION COMPLETE — AE
  Total processed:  447
  Ready:            312  (70%)
  Needs Review:      48  (11%)
  Excluded:          87  (19%)
    - Duplicates:    45
    - Already live:  12
    - Junk names:     3
    - Inactive:      14
    - Unverifiable:  13
```

Present this summary to Ryan. If there are "Needs Review" venues, offer to show the list so he can decide on them.

### Step 4: Proceed to Production

After qualification, the production queue is clean:

```
/padeli:create-listing next 5 AE
```

This now only pulls "Ready" venues, ranked by priority score.

---

## The 10 Layers

| Layer | What it checks | Data source | Action |
|-------|---------------|-------------|--------|
| 1. Internal dedup | Same Playtomic ID, coordinates within 100m, same website | Notion data | Exclude duplicates, keep best record |
| 2. WP dedup | Already published/drafted on padeli.com | WP REST API | Exclude already-live venues |
| 3. Name cleaning | Junk names, source suffixes, formatting | Text analysis | Fix or exclude |
| 4. Playtomic check | Tenant active? Courts bookable? | Playtomic API | Exclude inactive, enrich with court/surface data |
| 5. Google Places | Real venue? Rating? Reviews? | Google Places API | Enrich with rating/reviews/Place ID |
| 6. Website check | Site live? Padel content? Equipment shop? | HTTP + headless Chrome | Exclude equipment shops |
| 7. Geography | Coordinates in correct country? City name? | Bounding box check | Flag mis-tagged venues |
| 8. Completeness | How much data do we have? (0-10) | All above | Score for readiness |
| 9. Brand detection | Part of a chain? (Just Padel, Game4Padel, etc.) | Name matching | Tag brand in Notion |
| 10. Priority | Which venues will produce the best listings? (0-100) | All above | Rank production order |

## What Gets Written to Notion

After qualification, each venue's Notion row is enriched with:
- **Status** → Ready / Needs Review / Excluded
- **Qualification Score** (0-10)
- **Priority Score** (0-100)
- **Google Rating** + **Google Reviews** + **Google Place ID**
- **Verified court count** + **Surface types** + **Indoor/Outdoor**
- **City (English)** — normalised from Arabic/local names
- **Brand** — if part of a chain
- **Notes** — exclusion reason if excluded

---

## Dependencies

- Node.js v24+ (native fetch, no npm packages, zero external deps)
- All modules bundled at repo root:
  - `qualify-queue.js` — this skill's engine
  - `discover-clubs.js` — Playtomic tenant fetcher
  - `place-id-backfill.js` — Google Places lookup
  - `shell-creator.js` — name matching + WP duplicate search
  - `site-renderer.js` — headless Chrome for JS-rendered websites
  - `master-sheet.js` — Notion production queue
  - `notion-sync.js` — Notion API patterns
  - `wp-client.js`, `config.js`, `utils.js` — shared helpers
- Env vars (in `~/.zshrc`):
  - `NOTION_API_KEY` — Notion integration key
  - `GOOGLE_PLACES_API_KEY` — Google Places API key
  - `PADELI_WP_USER` / `PADELI_WP_APP_PASSWORD` — WP auth (for duplicate check)
  - `PADELI_OPERATOR` — operator name for Notion claim locking

---

## Recommended Workflow

1. **Discover:** `/padeli:discover-clubs AE` → raw venues into Notion
2. **Qualify:** `/padeli:qualify-queue AE` → sweep and sort the queue
3. **Produce:** `/padeli:create-listing next 5 AE` → only Ready venues, highest priority first
4. **Publish:** Bulk publish in WordPress
5. **Post-publish:** `/padeli:post-publish all AE` → cross-link + index
