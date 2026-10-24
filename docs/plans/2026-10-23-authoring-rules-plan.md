---
title: Authoring rules - check lints, draw quality line, syntax tips, compliance evidence
type: feat
date: 2026-10-23
base: main @ 8a4efa4
status: plan (no code)
---

# Authoring rules: rules agents can follow, built into the tool

## Goal capsule

- **Objective:** an agent that only reads command output learns, at the moment it matters, which input shapes produce bad diagrams and what to type instead. Three surfaces: `check` lints with copy-pasteable fixes, a `quality:` line on `draw` / `inspect` / `check` (the QA checker's geometry moved into shipped `src/quality/`), and a `syntax tips` slice. A compliance script proves the rules work on held-out fuzz seeds.
- **Authority:** user brief > this plan > implementer judgment. Lints are warnings; nothing here changes layout, generator or profile semantics; quality issues never fail `draw`.
- **Non-goals:** fixing layout defects; auto-rewriting the agent's DSL inside `draw`; new deps.

## 0. Evidence (out/rules-evidence/{features,ablate}.mjs on out/fuzz-s3 + out/fuzz-s4, 4800 renders, 28 HARD)

Each fuzz case was regenerated with `generate(seed, profile)` (deterministic) to read input features that `meta` lacks (degree, label words, reciprocal pairs). HARD = renders with >= 1 HARD finding; crossings = mean `arrow-crossings` count (SOFT busyness).

| feature bucket | renders | HARD % | crossings | note |
|---|---|---|---|---|
| edges per node pair <= 2 / > 2 | 4164 / 636 | 0.29 / **2.52** | 31 / 6 | 8.7x HARD; top codes label-on-foreign-arrow, arrowheads-crowded, parallel-edges-close |
| max node degree <= 8 / > 8 | 3784 / 1016 | 0.24 / **1.87** | 24 / 44 | 7.8x; degree 13+: 3.1 % |
| diamond degree <= 4 / > 4 | 3512 / 1288 | 0.34 / **1.24** | 15 / **64** | hub shape at degree >= 7: diamond 3.0 %, ellipse 1.1 %, rect 1.0 %, cylinder 0.0 % |
| edges/node <= 2 / > 2 | 3780 / 1020 | 0.19 / **2.06** | 20 / 57 | density is the 2nd strongest single predictor |
| edge label words <= 3 / > 3 | 1832 / 2968 | 0.22 / 0.81 | **8 / 40** | 4-5 words: 0.8 %; word count beats char count |
| edge label chars <= 24 / > 24 | 3164 / 1636 | 0.51 / 0.73 | 22 / 39 | weak alone; 41+ chars: 45.6 % aspect-ratio |
| reciprocal pairs none / distinct labels / same-or-no label | 2880 / 1292 / 628 | 0.1 / 1.3 / 1.1 | 20 / 25 / **70** | same-label pairs triple the crossings |
| nodes <= 25 / > 25 | 4320 / 480 | 0.60 / 0.42 | 19 / **110** | busyness only, not HARD: keep as a soft "busy" lint |
| group nesting depth <= 2 / 3 | 4704 / 96 | 0.60 / 0.00 | 28 / 6 | no evidence; existing `deep-nesting` stays as is |
| group title <= 24 / > 24 chars | 4588 / 212 | 0.61 / 0.00 | 29 / 4 | **no lint** (candidate rejected) |
| direction DOWN+UP / RIGHT+LEFT | 2400 / 2400 | 0.85 / 0.35 | 28 / 28 | route-ratio 17 % vs 5 %; aspect-ratio 11 % vs 27 %; a hint, not a lint |
| **all candidate lints satisfied** / >= 1 violated | 1200 / 3600 | **0.00 / 0.78** | **2.7 / 36** | leave-one-out: dropping any single rule keeps 0.00 % (rules overlap); excluding tiny+unicode profiles: 560 compliant renders, 0.00 %, crossings 10 vs 39 |

Decisions from the data: ship `parallel-edges`, `busy-node`, `diamond-hub`, `dense-graph`, `wordy-edge-label` (words primary, chars secondary at 30), `reciprocal-pair`, `many-nodes` (>25, busyness wording); drop long-group-title; keep `too-many-nodes` 60, `deep-nesting` 2, `long-label` 40 unchanged. 12 of 68 curated corpus files will gain warnings (edge-multi-edge-k4/k5, edge-triple-parallel, edge-dup-fanout-cross-product, day-oauth-flow: parallel; edge-fan-out-14, edge-fan-in-12-to-cylinder: busy-node; day-event-driven-pubsub, edge-fan-out-14: diamond-hub; edge-label-wider-than-gap, edge-long-single-line-label, edge-brackets-in-labels: wordy label; edge-60-nodes: many-nodes). All are stress tests; lints are warnings, so no corpus edits. `test/fixtures/arch.exd` triggers none (check test "0 warnings" holds).

## 1. New `check` lints (src/lint/rules.ts, warnings; exit 1 only with --strict)

All run on the parsed `Graph` only (no layout), after a successful parse, in `lint(graph)` (moved from `check.ts` to `src/lint/rules.ts`; `check.ts` imports it). Positions: the node's/first edge's `line,col`. Suggestion text is literal DSL the agent can paste; `<id>` placeholders are filled with real ids. `check` prints the first warning's suggestion in its `suggestion:` line (already does); additionally, when more than one lint code fires, the help[] gets `excalidraw-cli-axi syntax tips` as its last line.

| code | fires when | message (one line) | suggestion (concrete) |
|---|---|---|---|
| `parallel-edges` | > 2 edges between one unordered pair {a,b} (self-loops excluded); one warning per pair | `4 edges between 'app' and 'authz'; parallel arrows crowd arrowheads and labels` | `merge them: app -> authz : redirect\ncode + secret` (labels of all a->b edges joined by `\n`, unlabeled ones dropped; when both directions exist: `app <-> authz : <joined labels>`) |
| `busy-node` | a node has > 8 incident edges (loops count once) | `'hub' has 12 edges; ports get closer than an arrowhead` | `split 'hub' into two nodes or move its neighbours into a group: group g1 "Workers" { w1[...]  w2[...] }` |
| `diamond-hub` | a diamond has > 4 incident edges | `diamond 't1' has 5 connections; diamonds route poorly past 4` | `make it a rectangle: t1[orders topic]` (same label, same style) |
| `dense-graph` | nodes >= 6 and edges > 2 x nodes | `55 edges on 22 nodes (2.5 per node); expect many crossings` | `drop secondary edges or split into two diagrams; keep edges <= 2 x nodes` |
| `wordy-edge-label` | an edge label line has > 3 words, or > 30 chars (the 40-char `long-label` still exists and wins when both apply: emit only `long-label` then) | `label of edge a -> b has 6 words; keep edge labels to 3 words` | `shorten it: a -> b : <first 3 words>` or, for 4-6 words, `break it: a -> b : <w1 w2 w3>\n<rest>` |
| `reciprocal-pair` | a->b and b->a both exist, exactly one each, and their labels are equal or both absent (`<->` and `--` edges are excluded) | `'a -> b' and 'b -> a' carry the same label; two arrows where one two-headed arrow reads better` | `a <-> b : <label>` (or `a <-> b`) |
| `many-nodes` | 25 < nodes <= 60 (above 60 `too-many-nodes` fires instead) | `diagram has 31 nodes; readability drops past 25 (crossings grow ~5x)` | `group related nodes (group id "Title" { ... }) or split into two .exd files` |

Not shipped (evidence): long group titles (0 % HARD), direction lint on `check` (direction affects aspect/route-ratio but `check` does not lay out; the direction hint lives on the quality line, section 2). `DiagnosticCode` in `src/dsl/ast.ts` gains the seven codes. Existing fixtures: `d.exd` (1 warning), `many.exd` (61 nodes: only `too-many-nodes`, since `many-nodes` is suppressed above 60), `long.exd` (10-word node label: `long-label` once, `wordy-edge-label` is edge-only) keep their exact expectations.

AE-L1. `a[A]\nb[B]\na -> b : x\na -> b : y\na -> b : z` -> `check: ok, 0 errors, 1 warning`, row `3,1,parallel-edges,...`, `suggestion: merge them: a -> b : x\ny\nz`.
AE-L2. `t1{T}` with 5 edges -> `diamond-hub` with `suggestion: make it a rectangle: t1[T]`; the same node with 9 edges also gets `busy-node` (two rows, two codes).
AE-L3. `a -> b : ok` and `b -> a : ok` -> `reciprocal-pair`, suggestion `a <-> b : ok`; with `b -> a : fail` -> nothing.
AE-L4. `a -> b : validate the payload against schema` (5 words, 38 chars) -> `wordy-edge-label` only; a 45-char label -> `long-label` only.
AE-L5. `check test/qa/corpus/edge-multi-edge-k4.exd` exits 0 with 1 warning; `--strict` exits 1. `npm run qa` is unaffected (qa.mjs never calls check).

## 2. `quality:` line on draw, inspect, check (src/quality/)

**Move, do not copy.** `scripts/qa/{geom,analyze,rules-extra}.mjs` become `src/quality/{geom,analyze,rules-extra}.ts` (typed loosely: `type El = Record<string, any>`-style `SceneElement` interface, same algorithms, same RULES/TOL tables, same sorted deterministic output). The three `.mjs` files turn into 3-line re-exports from `../../dist/quality/*.js` (so `scripts/qa.mjs`, `fuzz.mjs`, `shrink.mjs`, `promote.mjs`, `run.mjs` keep their imports; they already `requireBuild()`). Tests `test/qa.test.ts` and `test/layout-corpus.test.ts` switch their import to `../src/quality/analyze.js` and drop the `@ts-expect-error`. Acceptance for the move: `node scripts/qa.mjs` report.json byte-identical before/after on the same build, and `node scripts/fuzz.mjs --seed 4 --count 60` reproduces `out/fuzz-s4/report.json` findings exactly (diff on `byCode` and `findings`).

**New module `src/quality/hints.ts`:** `qualityHints(scene, graph?) -> QualityRow[]` where `QualityRow = {code, detail, fix}`. It runs `analyzeScene`, keeps every HARD finding plus the SOFT codes `arrow-crossings` (only when count > 2 x edges or > 20), `aspect-ratio`, `route-ratio` (only when >= 3 arrows hit it) and `text-exceeds-inscribed` is **excluded** (fires on 56 % of renders; pure noise for agents). Findings are folded one row per `(code, cause)`; `fix` maps layout findings to input-level edits using the id scheme (`edge-<index>` -> `graph.edges[index]`, `node-<id>`; for `.excalidraw` input without a graph, bindings give the node ids and the fix names them):

| finding (layout) | cause test | fix text |
|---|---|---|
| label-on-foreign-arrow, parallel-edges-close, arrowheads-crowded on a pair with >= 3 edges | parallel count | `merge parallel edges a -> b (4) into one: a -> b : l1\nl2` |
| arrowheads-crowded / arrow-through-node on a node with > 8 edges | degree | `'hub' has 12 edges: split it or group its neighbours` |
| any HARD on a diamond with > 4 edges | shape+degree | `make 'hub' a rectangle: hub[Label]` |
| label-on-foreign-arrow / label-label-overlap / label-on-node with a label > 3 words | label words | `shorten label of a -> b to 3 words` |
| zone-title-crossed | group | `shorten the title of group 'g' or move 'x' out of it` |
| arrow-crossings high | density | `55 edges on 22 nodes: drop secondary edges or split the diagram` |
| aspect-ratio > 4 and taller than wide in DOWN/UP (or wider than tall in RIGHT/LEFT) | direction | `try dir RIGHT (long chains read better left-to-right)` / `try dir DOWN` |
| anything else HARD | none | `layout defect, not an input problem: report the .exd with 'excalidraw-cli-axi inspect <file> --fields quality'` |

**TOON shape** (after `scene:`, before `warnings[]`): `quality: ok` or
```
quality[2]{code,detail,fix}:
  label-on-foreign-arrow,"label ""retry"" crossed by edge-3","merge parallel edges a -> b (4) into one: a -> b : retry\npoll"
  arrow-crossings,"180 crossings on 64 edges","drop secondary edges or split the diagram; keep edges <= 2 x nodes"
```
Rows sorted HARD first, then by code; cap 8 rows, then `quality: 11 issues, 8 shown` style note via the existing truncate helper. `draw` adds `${TOOL} syntax tips` to help[] when quality is not ok (replacing `syntax style`). `inspect` prints the line always (also for foreign `.excalidraw` files; fixes then name scene ids). `check` prints it too (it parses already; layout+build is ~10 ms) so `check` is a complete pre-flight; `--strict` does **not** count quality rows, only lint warnings (quality has its own flag below).

**Exit codes:** quality never changes `draw`/`inspect`/`check` exit codes. New boolean flag `--strict-quality` on `draw` and `check`: exit 1 when any HARD-severity quality row exists (files are still written first, like a render failure). Help text: `treat HARD layout findings as errors (exit 1); files are still written`.

**Runtime budget:** `analyzeScene` measured at 0.8 ms (3 nodes/15 edges), 4.6 ms (25/64), 16 ms (57/75, 219 elements). Budget: <= 50 ms on 60 nodes / 120 edges, asserted by a test on `test/qa/corpus/edge-60-nodes.exd` (< 150 ms with vitest overhead). `draw` without render stays < 400 ms (plan target); no new flag to disable it.

**Files < 500 lines:** analyze.mjs (343) + its header comments fits `src/quality/analyze.ts`; rules-extra (241) and geom (282) likewise; hints.ts new (~200). `src/commands/shared.ts` (222) gains `qualityBlock(rows)` (~25 lines).

## 3. `syntax tips` slice (src/guide/slices.ts) and SKILL.md

New slice `tips`, summary "rules that keep diagrams clean (what check and draw warn about)", rules (each <= 1 line, total slice <= 350 tokens incl. help[]):
1. `<= 2 arrows per node pair; merge: a -> b : first\nsecond (check: parallel-edges)`
2. `<= 8 arrows on one node; group or split hubs (busy-node); diamonds <= 4 arrows, else use a rectangle (diamond-hub)`
3. `edge labels <= 3 words; node labels <= 40 chars per line, break with \n (wordy-edge-label, long-label)`
4. `a -> b and b -> a with one meaning: a <-> b : label (reciprocal-pair)`
5. `<= 25 nodes and edges <= 2 x nodes per diagram; groups nest 2 deep max; split otherwise (many-nodes, dense-graph)`
6. `chains and pipelines: dir RIGHT; trees and flows: dir DOWN (draw prints quality: with a fix per finding)`
Example (parses clean, zero lint warnings): a 5-node pipeline using `<->`, a `\n` merged label and `dir RIGHT`. help: `$ check <file.exd>`, `$ draw <file.exd> --png`, `$ syntax edges`. `INDEX_COVERS.tips = "limits that keep layouts clean"`. SKILL.md golden path step 2 becomes: "Write the diagram to `diagram.exd`; keep the `syntax tips` limits (<= 2 arrows per pair, <= 8 per node, 3-word edge labels)", and step 3 gains "read the `quality:` line; apply its `fix` and rerun". Regenerate with `npm run skill:gen`. Tests (test/guide.test.ts, existing loops cover it automatically once `tips` is in SLICES): budget for both tool prefixes, example parses with no diagnostics, help[] present; add: the `tips` example yields zero warnings from `lint()`.

## 4. Validation: compliance evidence (scripts/qa/compliance.mjs, new; no gen/profiles changes)

`node scripts/qa/compliance.mjs --report out/fuzz-s3/report.json[,out/fuzz-s4/report.json] [--fix] [--out out/compliance]`
- **Filter mode (default):** for every case in the report(s), regenerate `generate(seed, profile, {rtl})`, parse the text with `dist/dsl/parser.js`, run `lint(graph)` from `dist/lint/rules.js` (single source of truth: compliant = zero warnings among the seven new codes + `deep-nesting`/`too-many-nodes`). Join with the report's per-render `hard` and `arrow-crossings` detail. Print TOON: `compliance: <n> renders`, `classes[2]{class,renders,hard,hard_rate,avg_crossings,route_ratio_rate}` (compliant vs violating), `by_rule[k]{rule,violating_renders,hard_rate,avg_crossings}` (leave-one-out as in section 0), `profiles[]` for the compliant subset. Writes `out/compliance/report.json`. Exit 1 when compliant HARD rate > 0.5 % or violating HARD rate <= compliant (the claim failed); exit 0 otherwise.
- **Fix mode (`--fix`, stretch):** for violating cases, apply the lints' own suggestions mechanically on the model, then `emit()` and redraw in the report's directions with `drawCase` from run.mjs: merge parallel edges (keep the first edge, join labels by `\n`, use `<->` when both directions exist), diamond-hub -> rect, wordy labels -> first 3 words, reciprocal same-label -> one `<->`; `busy-node`, `dense-graph`, `many-nodes` are not auto-fixable (reported as `unfixed`). Output `fixed[]{rule,cases,hard_before,hard_after,crossings_before,crossings_after}`. This is the measurable claim: "applying the suggestions removes HARD findings in N of M violating renders".
- **Claim to record in this file's Results:** on seeds 3+4 (held out), compliant inputs 0.00 % HARD (1200 of 4800 renders; 560 outside tiny/unicode), violating 0.78 %; crossings 2.7 vs 36. Fix mode target: >= 80 % of `parallel-edges` violators HARD-clean after the merge (expect ~all: the 15 multi-edge HARD renders all have maxParallel >= 3).
- `test/compliance.test.ts`: unit-tests the model fixers (pure functions in `scripts/qa/fixes.mjs`) on 4 tiny models and asserts `lint()` reports zero new-code warnings on each fixed model's emitted text.

## 5. Implementation units (Sonnet; one worktree each; A owns integration)

| unit | owner | files (exclusive) | depends | acceptance |
|---|---|---|---|---|
| A quality module move | `quality-core` | `src/quality/{geom,analyze,rules-extra}.ts` (new), `scripts/qa/{geom,analyze,rules-extra}.mjs` (re-exports), `test/qa.test.ts` + `test/layout-corpus.test.ts` import lines, `tsconfig.json` only if needed (none expected) | none | `npm test` green; `node scripts/qa.mjs` report.json identical to pre-move on the same build; `node scripts/fuzz.mjs --seed 4 --count 60` byCode/findings equal to out/fuzz-s4; each new file < 500 lines; `npm run build` emits `dist/quality/*.js` |
| B lints | `lint` | `src/lint/rules.ts` (new; `lint()` moves here), `src/commands/check.ts` (import + help tips line), `src/dsl/ast.ts` (codes), `test/lint.test.ts` (new: AE-L1..L5 + fixture expectations) | none | all 7 codes with the exact suggestion strings of section 1; existing check tests pass unchanged; `check` on every `test/qa/corpus/*.exd` exits 0 |
| C hints + command wiring | `quality-cli` | `src/quality/hints.ts`, `src/commands/{draw,inspect}.ts`, `src/commands/shared.ts` (`qualityBlock`, `--strict-quality` reader), `check.ts` quality line (coordinate: B lands first, C edits only the run() tail), `test/quality.test.ts` (new) | A, B | TOON shape of section 2 on `test/fixtures/crash-multi-edge.exd` and `edge-multi-edge-k4.exd`; `quality: ok` on `arch.exd`; `--strict-quality` exit 1 on a HARD case with files written; `edge-60-nodes` quality < 150 ms in-test; `axi-axi validate` 0 fail (TOON `[N]{...}` headers, help[] intact, stderr silent) |
| D tips slice + skill | `docs-cli` | `src/guide/slices.ts`, `src/skill/content.ts`, `skills/excalidraw-cli-axi/SKILL.md` (generated), `test/guide.test.ts` (one added assertion) | B (for the zero-warnings assertion) | budget <= 350 tokens both prefixes; `npm run skill:check` passes; index lists `tips` |
| E compliance | `qa-evidence` | `scripts/qa/compliance.mjs`, `scripts/qa/fixes.mjs`, `test/compliance.test.ts`, `package.json` script `qa:compliance` (A merges) | A, B | filter mode reproduces the section 0 numbers on out/fuzz-s3+s4 within rounding; exit codes as specified; `--fix` prints before/after; runs < 60 s filter, < 10 min fix on the dev box |

Order: A and B in parallel -> C and D and E -> A merges, then gate: `npm run build && npm test` green, `npm run qa` 100 % (corpus + fuzz-corpus), `node scripts/fuzz.mjs --seed 3` and `--seed 4` gated pass rates unchanged (99.8 % / 99.1 %) or better, `npx -y axi-axi validate "node bin/excalidraw-cli-axi.js" --dir .` 0 fail, every file < 500 lines, `npm run skill:check` passes, `node scripts/qa/compliance.mjs --report out/fuzz-s3/report.json,out/fuzz-s4/report.json` exit 0. Append the compliance TOON and the commit hash to this file's Results.

## 6. Open questions (only if needed)

1. `check` printing the `quality:` line means `check` now lays out the graph (still no file writes, ~10 ms). Accept, or keep `check` lint-only and leave quality to `draw`/`inspect`? Plan assumes accept.
2. `reciprocal-pair` suggests `<->`, which drops directionality. For request/response pairs with the same label this is right; confirm the lint should stay a warning (never `--strict`-relevant by default) or be excluded from `--strict`. Plan assumes it is an ordinary warning.

## Decisions (orchestrator, 2026-10-23)

1. Accepted: `check` lays out the graph (no writes) and prints the `quality:` line.
2. `reciprocal-pair` stays an ordinary warning but is EXCLUDED from `--strict` (stylistic; `<->` drops directionality). All other new lints count under `--strict`.
