# Plan: skill-driven engine selection (A: weaknesses text, B: QA-driven routing, C: agent-choice eval)

Status: APPROVED by the user (session 8, 2026-10-24): all six open questions answered with the recommended option (crossGroup 6 + `cross-group-edges` lint; long-label routing; no mermaid for .exd; golden-path sentence; eval bar 22/24 + 100% kinds/README, L2 manual; spot check skipped). Implementation not started. Fable planner, read-only; numbers re-derived from `out/` (no QA job run).

## 1. Evidence

### 1a. Apples-to-apples?

- Checker, held-out fuzz: `out/fuzz-{excalidraw,d2,mermaid}-s3|s4/report.json`, same seeds and case seeds, same checker (d2/mermaid skip `label-stored-offset`, `text-exceeds-inscribed`). d2 vs mermaid is a clean comparison.
- Checker excalidraw vs others is NOT usable: excalidraw scores 98.6-100% everywhere, but vision rejected 15 of its 32 gated held-out renders (`out/review-r5-excalidraw/all-verdicts.json`). The checker is blind to stacked arrowheads, bundled corridors, label overflow, tiny text.
- Vision held-out: all three engines reviewed the same 40 cases (`sample.txt` identical across `out/review-r5-*`), 4 per profile, plus the same 100 realistic and 156 edge curated renders. Different commits (excalidraw c604dd7, d2 851b256, mermaid 7a4e5ba), each the shipped state. n = 4 per profile is small.
- Not used: `out/bakeoff-review/summary.md` (pre-round baseline), mermaid r1, dev seeds s1/s2.

### 1b. Per profile (gated %, checker s3 / s4; vision = yes on 4 sampled held-out renders)

| profile | ex checker | ex vision | d2 checker | d2 vision | mm checker | mm vision | best |
|---|---|---|---|---|---|---|---|
| realistic-small | 100 / 100 | 4/4 | 98.3 / 100 | 4/4 | 96.7 / 99.2 | 4/4 | tie |
| realistic-medium | 100 / 100 | 2/4 | 96.7 / 97.1 | 4/4 | 81.3 / 82.5 | 4/4 | d2 |
| multi-edge | 97.5 / 99.2 | 2/4 | 70.4 / 75.0 | 4/4 | 85.0 / 81.3 | 4/4 | d2 or mermaid (1c) |
| labels-heavy | 100 / 99.6 | 0/4 | 87.5 / 90.8 | 4/4 | 92.5 / 94.2 | 4/4 | d2 / mermaid |
| groups-nested | 99.6 / 99.6 | 1/4 | 100 / 98.8 | 4/4 | 82.9 / 75.4 | 4/4 | d2 |
| hubs | 100 / 100 | 0/4 | 93.8 / 93.3 | 4/4 | 98.3 / 98.3 | 4/4 | d2 or mermaid |
| dense (report-only) | 97.5 / 99.2 | 0/4 | 87.9 / 82.9 | 3/4 | 73.8 / 78.8 | 3/4 | d2 |
| stress-60 (report-only) | 96.3 / 98.3 | 0/4 | 90.8 / 81.3 | 1/4 | 51.2 / 55.0 | 1/4 | d2 (all bad) |
| tiny / unicode | 100 | 8/8 | 100 | 8/8 | 95-99 | 8/8 | tie |
| curated realistic (100) / edge (156), vision | 98 / 150 | | 98 / 150 | | 92 / 150 | | ex = d2 > mermaid |

### 1c. Per router measure (held-out cases regenerated with `scripts/qa/gen.mjs`, `measureGraph`, joined to per-case HARD count; gated profiles)

| bucket | excalidraw (blind) | d2 | mermaid |
|---|---|---|---|
| fits, n=2308 | 100 | 97.7 | 94.4 |
| parallel pair only failing measure, n=88 | 100 | 94.3 | 90.9 |
| max edges per pair >= 3, n=588 | 98.6 | 73.3 | 85.5 |
| busy (degree > 8) only, n=192 | 100 | 97.4 | 100 |
| degree 12+, n=428 | 98.6 | 76.4 | 90.0 |
| dense (edges > 2 x nodes), n=264 | 98.9 | 70.1 | 81.4 |
| nested (depth 3), n=96 | 100 | 97.9 | 78.1 |
| cross-group 6-9 / 10-14 / 15+, n=332/300/380 | 100 | 94.0 / 97.0 / 96.6 | 85.5 / 82.7 / 76.8 |
| >= 2 groups and fits, n=192 | 100 | 100 | 78.6 |
| self-loops >= 1, n=1360 | 99.4 | 96.0 | 83.2 |

Reading: "d2 multi-edge ~70%" is driven by cases that are also dense/busy. With a parallel pair as the only problem d2 is 94% (vision 4/4), so routing parallel edges to d2 is right (excalidraw vision 2/4). Mermaid beats d2 only on hubs/dense by checker (vision ties) and loses badly with groups.

### 1d. The 15 excalidraw held-out vision rejects

9 of 15 already get `suggest d2`. 6 misses: 4 labels-heavy (all carry the `long-label` lint, > 40 chars), 2 groups-nested that fit with 7 and 9 cross-group edges. Curated rejects agree (`edge-cross-group-edges` 8 cross edges; `edge-long-single-line-label`). d2 and mermaid passed all of these.

### 1e. Gaps

Vision n = 4 per profile. No new 70-min fuzz run needed (routing does not change renders). Optional spot check: `node scripts/fuzz.mjs --profile labels-heavy,groups-nested --count 12 --seed 5 --png --keep-passing` for excalidraw (~3 min) + 2 Sonnet vision packets (~20 min). No gated data above 25 nodes (stress-60 report-only; d2 >> mermaid). realistic-medium: no new node/ratio rule justified.

## 2. Item B: routing (`src/engines/route.ts`)

Invariant: the tool recommends; `--engine auto` applies; explicit `--engine` wins; `.exd` is never silently rewritten.

1. Keep every existing measure -> d2.
2. New measure `longLabels` = node/edge labels with a line > `MAX_LINE` (40, from rules.ts); fails when > 0; prefix `text`, `"3 long labels"` / `"1 long label"`; lint peer `long-label`; last in `failures()`. Example: `engine: suggest d2 (text: 2 long labels); add --engine d2` (14 tokens).
3. `crossGroup` 9 -> 6 with a lint peer: `MAX_CROSS_GROUP = 6` in `src/lint/rules.ts`, warning `cross-group-edges` (add to `DiagnosticCode` in `src/dsl/ast.ts`), message `"<n> edges cross group boundaries; cross-group routes tangle past 6"`, suggestion `"move linked nodes into one group or split the diagram"`. Corpus impact: `edge-cross-group-edges` (8), `edge-deep-nesting-cross-edges` (7), `edge-sibling-groups-many-edges` (9) and some fuzz repros gain a warning; `day-cicd-pipeline`, `day-multi-agent-orchestration` sit at 6 and stay clean.
4. Mermaid is never suggested for `.exd` graphs by shape (vision ties or loses vs d2; group weakness; shipped label bugs). Mermaid stays the `--target markdown|github` and kind route.
5. `src/guide/routing-slice.ts` rule 4 adds "<= 6 cross-group edges, no label line > 40 chars".

Tests: `test/route.test.ts` (long-label rows 40/41, cross rows 6/7, `ROUTE_LIMITS` adds `crossGroup: 6, labelLine: 40`, `EXPLAINS` adds `long-label`, `cross-group-edges`, measures add `longLabels: 0`); `test/lint.test.ts` (new warning at 7, silent at 6); `test/guide-engines.test.ts:170`; `test/cli-engines.test.ts:33,42` (check fixture labels); `test/commands.test.ts` (new code); `scripts/qa/compliance.mjs`, `fixes.mjs` (new code, not auto-fixable); `README.md` line 58. No QA/vision re-run required.

## 3. Item A: SKILL.md weaknesses (`src/skill/content.ts`)

SKILL.md 960 tokens, cap 1400 (`test/guide.test.ts:157`); draft ~260 tokens. Import `ROUTE_LIMITS`/lint constants so numbers do not drift. Insert after the engine table:

```
## Known weaknesses (measured on held-out QA)

- excalidraw: hubs with > 8 arrows, > 2 arrows between one pair, labels over 40 chars per line and > 6 cross-group edges come out tangled (stacked arrowheads, labels drifting onto other arrows). `check` flags each; shorten or regroup first, then follow `engine: suggest d2`. Keep it for <= 25 nodes, short labels, or when the user must edit by hand.
- d2: still crowds arrowheads on hairballs (edges > 2 x nodes, 50+ nodes) and sets multi-line edge labels tight. Best for nested or cross-linked groups, hubs, parallel edges, sequence/class/ER.
- mermaid: weakest with groups (nested subgraphs, many cross-group edges), self-loops, and long single-word labels (wrap mid-word); unreadable past 50 nodes. Use it when the output must render in Markdown/GitHub or for state/timeline/gitgraph/mindmap; for a README with hubs or parallel edges it is as good as d2.
- every engine: edges > 2 x nodes or > 50 nodes read badly everywhere; split the diagram instead of switching engine.
```

Golden path step 5 adds: "If `check` printed `engine: suggest d2`, draw with `--engine d2` (or `--engine auto`) unless the user asked for an editable Excalidraw file." Table row 1: "boxes and arrows that fit (<= 25 nodes, sparse, short labels)". `test/guide.test.ts`: contains "## Known weaknesses", "mid-word", "--engine d2"; cap unchanged. Regenerate: `npm run build && npm run skill:gen`; CI `skill:check` guards drift.

## 4. Item C: agent-choice eval

"Right" = engine/extension/flags the router and kind table produce, plus the stated destination.

- Ground truth `test/skill-eval/tasks.json`, ~24 tasks `{id, prompt, expect: {engine, ext, flags[], alsoOk?}, label_source}`: 7 kinds; 3 README/GitHub (one sequence -> `.mmd`); 4 fitting graphs -> excalidraw; 6 outgrowing graphs in prose -> `.exd` + `--engine d2|auto` (alsoOk `.d2`); 2 "edit by hand" -> excalidraw; 2 traps (ER for README -> mermaid; state machine as boxes -> mermaid). Reference `.exd` under `test/skill-eval/ref/`.
- L1 deterministic `test/skill-eval.test.ts` (in `npm test`): `route()`/kind detection returns `expect.engine` per task; SKILL.md contains each task's cue. Zero cost.
- L2 agent sample `scripts/skill-eval.mjs`: `emit` writes `out/skill-eval/packet-NN.md` (SKILL.md + 8 tasks + answer format `id | engine | file | flags`); orchestrator runs 3 Sonnet subagents, no tools; `score` prints TOON per task/category/overall. Pass bar: >= 22/24 engine+ext correct and 100% on kinds and README tasks; one SKILL-text iteration allowed. ~15 min, 3 x ~6k tokens. Manual, not CI.

## 5. Units (Sonnet, separate worktrees, disjoint files)

| unit | owns | depends on | gate |
|---|---|---|---|
| U-B router + lint | `src/engines/route.ts`, `src/lint/rules.ts`, `src/dsl/ast.ts`, `src/guide/routing-slice.ts`, `scripts/qa/compliance.mjs`, `scripts/qa/fixes.mjs`, `README.md`, `test/route.test.ts`, `test/lint.test.ts`, `test/guide-engines.test.ts`, `test/commands.test.ts`, `test/cli-engines.test.ts` | none | `npm test -- --maxWorkers=4`, `npm run qa` (0 HARD change), `npm run validate` |
| U-A skill text | `src/skill/content.ts`, `skills/diagram-axi/SKILL.md`, `test/guide.test.ts` | parallel with U-B (import constants); merge after U-B | `npm test -- --maxWorkers=4`, `npm run skill:check`, token cap |
| U-C eval | `scripts/skill-eval.mjs`, `test/skill-eval.test.ts`, `test/skill-eval/**`, `package.json` | after U-B + U-A merge | `npm test -- --maxWorkers=4`; orchestrator runs L2 once |

Order: U-B || U-A -> merge U-B, then U-A (cherry-pick + `npm test`) -> U-C -> L2 run -> Results + handoff.

## 6. Open questions (recommended first)

1. `crossGroup` 9 -> 6 with new `cross-group-edges` lint? Recommend yes. Alt: keep 9.
2. `long-label` as a routing measure? Recommend yes. Alt: SKILL bullet only.
3. Suggest mermaid for `.exd` graphs (busy/dense, no groups)? Recommend no.
4. Golden-path sentence "follow `suggest d2` unless the user wants hand editing"? Recommend yes.
5. Eval pass bar 22/24, 100% kinds/README, L2 manual? Recommend yes.
6. Optional 20-min excalidraw spot check before fixing thresholds? Recommend ship now, spot check later if needed.

## Results

Session 9 (2026-10-24), all three units merged on main (cherry-pick + `npm test` gate):

- U-B `37b10c1` (worktree tip 2108246): `longLabels` route measure (prefix `text`), `MAX_CROSS_GROUP = 6` + `cross-group-edges` lint shared with the router via `crossGroupEdges()`/`countLongLabels()` in `src/lint/rules.ts`; routing-slice, README, compliance/fixes updated. `npm run qa`: 0 HARD, 352/352 renders pass. `cross-group-edges` keeps the default `SUGGESTION_RANK` (user decision).
- U-A `83f3d29` (tip 15b135d) + `9071269` regen: "Known weaknesses" section, suggest-d2 golden-path sentence, table row 1. SKILL.md 1255 / 1400 tokens; numbers imported from `ROUTE_LIMITS`/`MAX_LINE`.
- U-C `0a7289e` (tip 6ae5781): `test/skill-eval/tasks.json` (24 tasks: kind 7, readme 3, fit 4, outgrow 6, hand 2, trap 2), 14 ref `.exd`, L1 `test/skill-eval.test.ts` (110 tests), `scripts/skill-eval.mjs emit|score`. Scoring also requires file+flags to select the engine (stricter than engine+ext).
- Suite after merge: 1661 pass / 6 skipped.
- **L2 (3 Sonnet agents, packet only): 23/24 PASS**; kind 7/7, readme 3/3, outgrow 6/6, fit 4/4, hand 2/2, trap 1/2. Miss: `trap-state-boxes` (ticket lifecycle "as boxes and arrows") answered excalidraw `.exd`; defensible given the wording, so no SKILL iteration spent. Answers in `out/skill-eval/answers-0{1,2,3}.md`.
- SKILL polish `8c2407e` (user-approved, tip 80f2cea): README row beats every other row; dense/large -> d2, split only past ~50 nodes; "keep content as is -> follow suggest d2"; `--target editable` documented. SKILL.md 1320 / 1400 tokens; suite 1662 pass / 6 skipped. **L2 round 2: 23/24 PASS** (same single miss `trap-state-boxes`); both hand tasks now answer `--target editable`. Round-1 answers kept in `out/skill-eval/r1/`.
- SKILL text gaps flagged by U-C (fixed by the polish above): "split instead of switching engine" vs dense/large -> d2; README row vs kind row precedence unstated; "shorten or regroup first" vs d2 for long labels/hubs; `--target editable` never mentioned.
