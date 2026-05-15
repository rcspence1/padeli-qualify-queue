# Padeli Qualify Queue

10-layer pre-qualification system for the Padeli listing production queue. Run before `/padeli:create-listing` to ensure only verified, high-quality venues enter the pipeline.

## What It Does

Sweeps all "Discovered" venues in the Notion Club Tracker and sorts them into:
- **Ready** — verified, enriched, prioritised. Safe to produce.
- **Needs Review** — some data but not enough confidence. Check manually.
- **Excluded** — duplicates, junk, inactive, equipment shops. Skip.

## The 10 Layers

1. **Internal dedup** — same Playtomic ID, coordinates within 100m, same website
2. **WP dedup** — already published or drafted on padeli.com
3. **Name cleaning** — junk names, source suffixes, formatting
4. **Playtomic check** — tenant active? Courts bookable? Surface types?
5. **Google Places** — real venue? Rating? Reviews? Sports type?
6. **Website check** — site live? Padel content? Equipment shop?
7. **Geography** — coordinates in correct country? City name normalisation
8. **Completeness** — 0-10 data quality score
9. **Brand detection** — franchise identification (Just Padel, Game4Padel, etc.)
10. **Priority ranking** — 0-100 composite score for production ordering

## Usage

```bash
node qualify-queue.js AE              # qualify all Discovered in AE
node qualify-queue.js AE --dry-run    # preview without updating Notion
node qualify-queue.js AE --limit 10   # only process 10
node qualify-queue.js AE --skip-website  # skip website checks (faster)
```

## Requirements

- Node.js v24+
- Part of the padeli-notion pipeline — requires the full `lib/` module set
- Environment variables: `NOTION_API_KEY`, `GOOGLE_PLACES_API_KEY`, `PADELI_WP_USER`, `PADELI_WP_APP_PASSWORD`
