# QA review dashboard (local, not part of the npm package)

Astro + Starlight + React islands over the QA artefacts in `out/review/` (built from the course-dashboard-kit
template). It shows reviewer verdicts (V1..V10) next to the checker result and the new SOFT visual-rule codes.

```
cd dashboard
npm install
npm run dev        # runs gen:pages first, then http://localhost:4321/
npm run check      # gen:pages, astro check, astro build, scripts/check-dashboard.mjs
npm run build && npm run preview
```

Run astro only through the npm scripts (`gen:pages` must run first). Generated files (`src/generated/`,
`src/content/docs/review/`, `public/review/`) are git-ignored; never edit them.

## Where the data comes from

`kit.config.json`: `reviewRoot` (default `../out/review`, relative to this folder; absolute paths work),
`analyzerPath` (built `dist/quality/analyze.js`; when missing, visual-rule codes are skipped with a warning),
`sets` (how renders map to the four sets) and `rounds`. Per round: `verdicts` (all-verdicts.json),
`gallery` (gallery-data.json, optional), `qaDir`/`fuzzDir` (PNG folders), `qaReport` (qa/report.json) and
`fuzzReports` (fuzz `report.json` files, paths relative to the round's reviewRoot).

In a worktree without `out/` or `dist/`, copy nothing: create `kit.config.local.json` (git-ignored, shallow-merged
over `kit.config.json`) with absolute `reviewRoot` and `analyzerPath`, or set `QA_REVIEW_ROOT` / `QA_ANALYZER_PATH`.

## Add a round (for example round 4), no code changes

1. Put the round's artefacts in a folder shaped like `out/review/`: `all-verdicts.json`, `qa/*.png` (+ `*.excalidraw`,
   `report.json`), `fuzz/*.png`, optionally `gallery-data.json`.
2. Append an entry to `rounds` in `kit.config.json`:
   `{ "id": "round-4", "label": "Round 4", "reviewRoot": "../out/review-r4", "verdicts": "all-verdicts.json", "qaDir": "qa", "fuzzDir": "fuzz", "qaReport": "qa/report.json", "fuzzReports": [{ "id": "s5", "label": "Fuzz seed 5", "path": "../final-s5/report.json" }] }`
   (omit `reviewRoot` to reuse the top-level one; keep `id` unique and URL-safe).
3. `npm run check`. A new sidebar group, set pages and a row in the round comparison table appear; the overview
   lists the latest round first.

## Per-engine rounds (round-5-excalidraw, round-5-d2, round-5-mermaid)

A round may carry an optional `engine` (`excalidraw`, `d2` or `mermaid`). The three round-5 entries in `kit.config.json`
read `../out/review-r5-<engine>/` (same layout as `out/review/`) and fuzz reports `../fuzz-<engine>-s3|s4/report.json`.
The engine shows in the round comparison table (Engine column), the round heading, the set page description and the
grid's count line; rows carry `engine`. Rounds without the field (round-3, a later round-4) show `-`.

- **SVG thumbnails.** A render `qa/x-DOWN.png` may have a twin `qa/x-DOWN.svg` next to it. Grid thumbnails use the SVG
  when present; the full-size dialog always shows the PNG. The SVG is optional per row; `check` verifies every twin
  that exists is copied to `public/` and `dist/`.
- **Missing data is a warning.** A configured round whose `all-verdicts.json` does not exist yet is skipped with a
  warning by `gen:pages` and `check` (a missing fuzz report is a warning too). Only "no round has data at all" fails.
- **Fixtures.** `test-fixtures/` holds a few synthetic rows per engine (same JSON shape as the real files; the pictures
  say SYNTHETIC). `npm run check:fixtures` sets `DASHBOARD_FIXTURES=1`: a round without real data falls back to
  `test-fixtures/<its reviewRoot folder name>` and is flagged "synthetic fixture" on the overview and set pages. Real
  data always wins. `npm run fixtures:make` regenerates them (needs sharp; output is committed). The mermaid fixture has
  no seed-4 fuzz report on purpose, to exercise the warning.

## Engine bake-off page (Excalidraw vs D2 vs Mermaid)

`kit.config.json` has a `bakeoff` block (`root` defaults to `../out/bakeoff-review`; absolute paths work, and
`kit.config.local.json` can override the whole block). `root` holds `manifest.json` (one entry per scenario with the three
PNG paths) and `verdicts.json` (one row per scenario x engine: V1..V10, `classes`, `notes`, `best`, `bestWhy`).
`npm run bakeoff:aggregate` merges reviewer packets `verdicts-0N.json` into `verdicts.json`, `summary.json` and
`summary.md`. `npm run gen:pages` then writes the sidebar group "Engine bake-off" (a Summary page with acceptance per
engine and set, failure classes and best engine per diagram kind, and a Scenarios page with the three images side by
side). Remove the `bakeoff` block to hide it; `scripts/check-bakeoff.mjs` (run by `npm run check`) verifies parity.

## Checks (`npm run check`)

Every source row has a PNG that exists (and every SVG twin; engine rounds also match their configured engine) (public/ and dist/); per-set, accepted and per-V-check counts equal the
source JSON; pages exist for every round and set; fuzz profile counts equal the fuzz reports; no broken
`href`/`src` in `dist/`; files under 500 lines; description frontmatter has no `": "`.
