---
title: QA stage 2 - edge-case taxonomy, seeded fuzzer, shrinker, promotion, checker gaps
type: qa
date: 2026-10-23
base: main @ 935618f
status: plan (no code)
---

# QA stage 2: edge cases, fuzzing, shrinking, promotion

## Goal capsule

- **Objective:** production confidence that `draw` never produces a diagram with a HARD geometric defect, including for inputs no human wrote: a seeded random generator feeds `scripts/qa/analyze.mjs`, failures are shrunk to minimal `.exd` repros and promoted into `test/qa/corpus/` as permanent regressions.
- **Release bar (user requirement):** pass rate >= 90 % of renders with zero HARD findings, stretch 99 %. Curated corpus: aim 100 %, never below 99 %. Fuzz: >= 90 % per profile and overall (99 % stretch); hard profiles (`dense`, `stress-60`) are reported separately but count toward the overall number.
- **Definitions:** a *render* is one (`.exd` file, direction) pair drawn by the built CLI (`draw`, no PNG unless `--png`). A render *passes* when `analyzeScene` plus the runner rules yield 0 HARD findings (SOFT ignored). *Pass rate* = passing renders / total renders, one decimal, exactly as `scripts/qa.mjs` computes `passRate` today. Fuzz reports pass rate per profile (`profiles[]{profile,renders,passed,passRate,topCode}`) and overall.
- **Boundaries:** this plan touches only `scripts/qa/**`, `scripts/*.mjs` (new files), `test/qa/**`, `test/*.test.ts` (new files), `docs/plans/`. `src/layout/**` and `src/scene/**` belong to the concurrent fix agent; findings against them are *reported*, not fixed here.
- **Authority:** user brief and the pass-rate requirement > this plan > implementer judgment.

## 0. Facts the implementer must respect (read from source on 935618f)

- Lexer: ids are `[A-Za-z_][A-Za-z0-9_]*` with internal `-` allowed only when followed by an id char; `#` starts a comment wherever a token may start; a label body runs to the first closer (`]`, `)`, `}`, `)]`) on the same line, so a label may not contain its own closer; `\n` literal splits lines; edge labels are raw rest-of-line after `:` (quote to keep `#`). Arrows must be whitespace-delimited.
- Parser: colon rule (edge `:` = label; node/group `:` = style; no inline node style on an edge line); `dir`/`title`/`group` are only keywords in their syntactic position but the generator must still avoid them as ids; node and group ids share one namespace; `direction` in the DSL beats `--direction`; fan-out `a, b -> c, d` is a cross product; a chain label applies to every edge of the statement; empty / whitespace labels are errors; `dir` and `title` only at top level.
- Layout (`dagre-layout.ts`): node min 120x60, diamond x1.6/x1.4, ellipse x1.3/x1.3, cylinder h x1.25; `nodesep 40, ranksep 60, edgesep 20`; groups are inflated into node sizes and recomputed bottom-up with 24 px pad + title room; empty groups become 160x80 leaves. `route.ts`: ports spread along one side (`PORT_SPACING 28`, side span 0.7 / 0.5 for curved); pair lanes `PAIR_GAP 46`; alt edges of a pair (2nd, 4th, ...) take the cross axis or an L; **self-loops are excluded from routing and fall back to dagre's inflated-coordinate points** (the source of the 16 `arrow-detached`). `labels.ts`: slot search along the route then dense scan; label anchoring by inserting collinear vertices so Excalidraw's middle-vertex rule lands on the chosen spot.
- `check` lint: `too-many-nodes` > 60 is a *warning*; `deep-nesting` > 2 warning; `long-label` > 40 chars warning. None blocks `draw`, so the fuzzer may exceed them.
- Checker (`analyze.mjs`): 12 HARD, 6 SOFT rules; edge-label box recomputed from the arrow (labelPosition or middle vertex/segment); cylinder = body + cap keyed by `nodeKey`; zones keyed by `zone-` / `zone-title-` id prefixes and `groupIds[0]`.
- Baseline 935618f: 135/176 = 76.7 %. HARD by code: label-on-foreign-arrow 44, arrow-detached 16 (self-loops), label-on-node 10, parallel-edges-close 8 (k >= 3 between one pair), arrow-through-node 6, label-label-overlap 2.

## 1. Edge-case taxonomy

Legend: **C** covered by the 44-file corpus (file named), **P** partially, **G** gap. Priority = likelihood in real agent use x risk of a HARD defect: H / M / L.

### 1.1 Topology
| # | Dimension | Status | Pri |
|---|---|---|---|
| T1 | Reciprocal pair k=2, flow axis / cross axis / under a parent | C edge-reciprocal-flow-axis, -cross-axis, -chain | H |
| T2 | Multi-edge k=3 same direction + 1 back | C edge-triple-parallel | H |
| T3 | Multi-edge k=4..5 (lanes exceed side span 0.7 x 120 px = 84 px with PAIR_GAP 46) | G | H |
| T4 | Multi-edge mixed kinds between one pair (`->`, `-->`, `<->` all a->b) | G | M |
| T5 | Self-loop: unlabeled, labeled, 2 loops on one node, loop on diamond/ellipse/cylinder, loop on a node inside a group, loop in RIGHT/LEFT | P edge-self-loop-label (rect only, DOWN) | H |
| T6 | Cycle length 2..6, cycle with every edge labeled | C edge-cycle-5; P 3-cycle (day-tool-calling-loop) | M |
| T7 | Long chain 12+ nodes on one line | G (longest chain 5) | M |
| T8 | Fan-out 1->8 one label, fan-in 8->1 distinct labels | C edge-fan-out-8, edge-fan-in-8-labeled | H |
| T9 | Fan-out 1->12+ (ports compress to 0.7 x 120 px: 12 ports < 10 px apart) | G | H |
| T10 | Hub with in+out+reciprocal from 6+ nodes | C edge-many-labeled-into-one | H |
| T11 | Complete bipartite K3,3 / K4,4 all labeled | G | M |
| T12 | Dense random (edges ~ 2.5 x nodes) | P edge-60-nodes (sparse layered) | M |
| T13 | Disconnected components | C edge-disconnected-components | L |
| T14 | 1 node; 2 nodes no edge; 2 nodes one edge; 1 node with self-loop only; title-only + 1 node | G | M |
| T15 | Skip-rank edges (a->b->c->d plus a->d, a->c) labeled, which pass alongside intermediate nodes | P day-incident-runbook | H |
| T16 | Edges whose endpoints share a rank (cross-axis siblings) with 3+ such pairs | P edge-reciprocal-cross-axis | M |
| T17 | 60+ nodes with groups and labels (not just a layered grid) | G | M |

### 1.2 Geometry / text
| # | Dimension | Status | Pri |
|---|---|---|---|
| X1 | Extreme node size disparity (1-char label next to 60-char label, 3-line next to 1-line) | P edge-long-single-line-label, edge-short-labels (not mixed) | H |
| X2 | Edge label wider than the gap between its nodes (label 300 px, ranksep 60) | P edge-long-single-line-label | H |
| X3 | Multiline edge labels 3+ lines (tall label box vs ranksep 60) | C edge-multiline-labels | M |
| X4 | CJK / emoji (avg-width fallback: under/over-measure) | C edge-cjk-emoji | M |
| X5 | RTL (Arabic/Hebrew), combining marks, zero-width joiner emoji sequences | G | L |
| X6 | Labels with leading/trailing/multiple internal spaces, tabs, `\n` at start/end (`[\nfoo]`) | G | M |
| X7 | Labels containing other brackets (`a[f(x) -> y]`, `b(see [1])`, `c{x: {y}}` is impossible, `d[(a (b) c)]`) | G | M |
| X8 | Diamonds/ellipses with long labels (inscribed area rule, port geometry on curved sides with many ports) | P day-decision-tree | H |
| X9 | Cylinder as hub with many ports (cap ellipse vs ports on top) | P day-queue-workers (db), edge-fan-in-8-labeled (sink) | H |
| X10 | Diagram title wider than the whole diagram / 3-line title | G | M |
| X11 | Edge labels identical text on many edges (`: yes` x8) | P day-decision-tree | L |

### 1.3 Groups
| # | Dimension | Status | Pri |
|---|---|---|---|
| G1 | Nesting depth 3 with cross edges | C edge-deep-nesting-cross-edges | M |
| G2 | Empty group, single-child group | C edge-empty-group; G single-child | M |
| G3 | Sibling groups with many (6+) edges between them, both directions | P edge-cross-group-edges | H |
| G4 | Edge from deep interior to outside node, outside node placed by dagre beside the zone | P edge-deep-nesting-cross-edges | H |
| G5 | Group title longer than its content (`needW` widening path) | G | H |
| G6 | Group with no title; group with title but `:color` only; nested untitled | G | M |
| G7 | Nested group inside group whose only other child is one node (title vs node overlap) | G | H |
| G8 | Node declared outside, referenced inside a group (membership is first-group-wins) | G | M |
| G9 | 5+ sibling groups in one rank (zone-intrusion from inflation slack 10) | G | M |
| G10 | Edges between two nodes inside the same small group (labels vs zone title) | P day-k8s-deployment | H |
| G11 | Self-loop on a node in a group (loop points escape zone) | G | H |

### 1.4 Directions x everything
All corpus files run in 4 dirs (qa.mjs rewrites `dir`). Gaps: UP/LEFT are `reverse=true` paths in `sidesFor` corner logic; T3/T5/T9/G11 must be exercised in all 4 directions. The fuzzer covers this by default.

### 1.5 Styles / arrows / DSL oddities that parse but stress layout
| # | Dimension | Status | Pri |
|---|---|---|---|
| D1 | All arrow kinds + flags | C edge-all-arrow-styles-and-flags | L |
| D2 | `<->` with label on a reciprocal pair (both heads + 2 directed) | G | M |
| D3 | `--` lines in cycles (no arrowhead: checker still treats as arrow) | P day-network-topology | L |
| D4 | Duplicate fan-out cross-product `a, b -> c, d : L` repeated twice (k=2 pairs x 4) | G | H |
| D5 | Chain with one label on every edge `a -> b -> c -> d -> e : step` | P day-etl-pipeline (2) | M |
| D6 | All nodes implicit (edges only, ids as labels, `rect` shapes) | P edge-disconnected-components | M |
| D7 | Declaration after use inside a group (`a -> b` top-level, then `group g { b[B] }`): b's owner is top-level, zone without b | G | M |
| D8 | Statement with `;` separators, trailing spaces, CRLF, BOM | G | L |
| D9 | `bold` arrows (strokeWidth 4) in parallel lanes: visual gap smaller than geometric | G | L |
| D10 | Same label text as node id, ids that are prefixes of each other (`a`, `a1`, `a-1`), id `cap`, `node`, `zone` (checker `nodeKey` strips `node-`/`cap-` prefixes: node ids `cap-x` would alias) | G | M (checker risk) |

Priority H gaps feed section 5 (curated) and the fuzzer profiles (section 2).

## 2. Generator ("fuzzer") design

**File:** `scripts/qa/gen.mjs` (pure: `generate(seed, profile, opts) -> { text, meta }`), driven by `scripts/fuzz.mjs`. No new dependencies.

- **PRNG:** mulberry32 or splitmix32 over a 32-bit seed, with `rng.int(a,b)`, `rng.pick(arr)`, `rng.chance(p)`, `rng.shuffle` (Fisher-Yates). Case seed = `hash32(runSeed, caseIndex)` so `--seed S --count N` is reproducible and any single case can be regenerated with `--case <seed>`.
- **Model first, text second:** build `{title?, dir?, nodes[], edges[], groups[]}` then serialise with `emit()`. The emitter guarantees validity: ids from a reserved-word-free alphabet (`n0..`, `g0..`, or realistic words from a small wordlist, never `dir|direction|title|group`); labels filtered of their own closer and of `#` (edge labels containing `#` are quoted); every node declared on its own line (style allowed there), edges reference bare ids, except in `implicit` mode where some nodes are declared inline on the first edge; groups emitted as blocks with children declared inside; `dir` omitted (the runner sets direction); optional `title`.
- **Validity oracle:** `fuzz.mjs` runs the built CLI `check` first (or parses via `dist/dsl/parser.js`); a parse *error* is a generator bug and is counted as `gen-invalid` (fails the fuzz run with exit 2, never blamed on layout).
- **Profiles** (`scripts/qa/profiles.mjs`, each a parameter object: node range, edge density, label probability and length distribution, shape mix, group count/depth, multi-edge k distribution, self-loop probability, title probability):

| profile | nodes | edges | labels | groups | special |
|---|---|---|---|---|---|
| realistic-small | 4-10 | n..1.5n, mostly DAG-ish | 60 % edges, 1-3 words | 0-1 | matches day-* mix (shapes 60/15/15/10) |
| realistic-medium | 10-25 | 1.2n..1.8n | 50 % | 1-3, depth <= 2 | 1-2 back edges, 1 reciprocal pair |
| multi-edge | 3-8 | each pair k in {2,3,4,5} weighted 40/30/20/10 | 90 % | 0 | mixes `<->`, reverse, self-loops 30 % |
| labels-heavy | 5-12 | 1.5n | 100 %, 3-12 words, 20 % multiline, 10 % 60-char | 0-1 | node labels 1-char to 70-char |
| groups-nested | 6-20 | n | 50 % | 2-6, depth <= 3, 10 % empty, 20 % single-child, titles 0-40 chars | 70 % of edges cross a boundary, 15 % loops inside |
| hubs | 6-14 | star/bipartite K(3..5, 3..5) | 70 % | 0 | fan 8-14 into a diamond/ellipse/cylinder hub |
| dense | 12-25 | 2.5n random | 40 % | 0-2 | expected hardest |
| stress-60 | 50-70 | 1.3n layered + 10 % random | 30 % | 2-4 | exceeds `too-many-nodes` on purpose |
| tiny | 1-3 | 0-3 incl. loops | 50 % | 0-1 | T14 |
| unicode | 4-10 | n | 80 % CJK/emoji/mixed | 0-1 | X4/X5 (RTL only when `--rtl`) |

- **Budget:** draw-only ~0.1 s/case, `--jobs 4` => ~40 renders/s. Default run: `--count 60` per profile x 10 profiles x 4 dirs = 2400 renders ~ 60-90 s; `--count 200` (8000 renders) stays under 5 min. CI smoke: `--count 10`.
- **CLI:** `node scripts/fuzz.mjs [--seed <n>] [--count <n>] [--profile <list|all>] [--dirs DOWN,RIGHT,UP,LEFT] [--jobs <n>] [--out out/fuzz] [--png] [--keep-passing] [--shrink] [--promote] [--case <seed>] [--emit-only]`. Default seed: 1 (deterministic); `--seed random` prints the chosen seed first. Unknown flag exit 2 listing flags (same style as qa.mjs).
- **Output layout:** `out/fuzz/<profile>/<seed>-<dir>.{exd,excalidraw[,png]}`; passing cases are deleted unless `--keep-passing`; `out/fuzz/report.json` same shape as qa.mjs (`summary`, `rules`, `byCode`, `cases`, `findings`) plus `profiles[]` and per case `{profile, seed, meta}`; `out/fuzz/failures.toon` one line per failing render for grep.
- **TOON stdout:** `fuzz: pass|fail`, `seed`, `renders`, `hard`, `pass_rate`, `profiles[N]{profile,renders,passed,pass_rate,top_code}`, `by_code[...]`, `failing[...]` (first 25), `help[]`. Exit 1 when overall or any profile is below the configured bar (`--bar 90`, `--profile-bar 90`); exit 0 otherwise.
- **Reuse:** import `RULES, analyzeScene` from `scripts/qa/analyze.mjs` and factor `runDraw`, `pool`, `table/val`, `DIR_LINE` out of `scripts/qa.mjs` into `scripts/qa/run.mjs` so qa.mjs and fuzz.mjs share them (qa.mjs output must not change).

## 3. Shrinker

**File:** `scripts/qa/shrink.mjs` (`shrink(text, {code, dir, oracle}) -> {text, steps}`), CLI `node scripts/shrink.mjs <file.exd> --dir DOWN [--code <hard-code>] [--out <path>]`.

- **Oracle:** `draw` the candidate text in the fixed direction, analyse; *reproduces* iff the target HARD code (default: the lexicographically first HARD code of the original) is present. Any parse error = candidate rejected. Memoise by text hash.
- **Representation:** parse to the model via `dist/dsl/parser.js` (AST), apply reductions on the AST, re-emit with the generator's `emit()`. This keeps candidates valid by construction and makes the result canonical.
- **Reduction passes (fixed order, repeat until a full cycle makes no progress):** (1) remove edges, ddmin-style (halves, then quarters, ... then single); (2) remove nodes that have no remaining edges, then nodes with edges (removing their edges); (3) flatten groups (lift children) then delete empty groups; drop group titles; (4) drop the diagram title; (5) drop styles/flags; convert `-->`/`-.->`/`<->`/`--` to `->`; (6) shorten labels: edge label -> first word -> `x`; node label -> first word -> `A`; multiline -> single; CJK -> `x`; (7) rename ids to `a, b, c...` in first-appearance order (only if still reproduces; purely cosmetic). Each accepted step is logged.
- **Determinism:** no randomness; ties broken by declaration order. Same input -> same output.
- **Output:** minimal `.exd` with a header: `# fuzz repro: code=<code> dir=<DIR> profile=<p> seed=<s> steps=<n> from <orig nodes>n/<e>e to <min>`. Bounded: max 400 oracle calls (print `shrink: budget exhausted` and keep the best so far).
- **Interaction with the fixing agent:** shrink against the *current* build; the stored repro records the code it reproduced so re-triage after a fix is mechanical.

## 4. Promotion workflow

- `node scripts/fuzz.mjs --shrink --promote` (or `scripts/promote.mjs <repro.exd>`): for each failing render, shrink, then compute a **signature** = `code + ":" + sha1(canonical model JSON with ids renamed, labels normalised to length class {1,short,long,multi}, flags dropped)` first 8 hex. Skip if `test/qa/corpus/fuzz-<code>-<hash>.exd` exists or any existing corpus file produces the same signature (dedup against hand-written cases too: compute signatures for the 44 files).
- File name `test/qa/corpus/fuzz-<code>-<hash8>.exd`; header lines: `# Fuzz repro (auto-promoted): <code> in <DIR>; profile <p>, seed <s>, run seed <S>, base <commit>.` followed by `# Minimal: <n> nodes, <e> edges, <g> groups.` The `qa.test.ts` rule that every corpus file starts with `# ` keeps holding.
- Promoted files run in all 4 directions like every corpus file; the header's direction is informational.
- Cap per run: `--promote-max 10` (default) so one bad build does not dump 200 files; the rest are left in `out/fuzz/shrunk/` for review.
- Triage: every promoted file is either a layout bug (goes to the fix loop) or a checker false positive (checker fix + a `test/qa.test.ts` case proving why; the corpus file stays as a regression once it passes).

### Iteration loop and stop rule (user requirement)

1. `npm run qa` (curated, 4 dirs) -> must be 100 % after the fix agent lands; otherwise block.
2. `npm run fuzz` (default seed 1, count 60/profile) -> per-profile and overall pass rate.
3. If overall < 90 % or any profile < 90 %: `--shrink --promote`, triage, hand the top 3 codes (by count) with minimal repros to the fix agent; after the fix, rerun 1 and 2 with the *same seed* (regression check) and with `--seed <iteration>` (fresh coverage).
4. Stop when: overall >= 90 % and every profile >= 90 % (release), or >= 99 % (stretch, stop). Stall rule: 2 consecutive iterations without the overall pass rate improving by >= 1 point, or with the same top code -> stop and report to the user with the per-profile table and the open repro list. Report `dense`/`stress-60` separately in the same table; they are expected lowest but still count overall.
5. Each iteration's numbers are appended to `docs/plans/<this file>` "Results" with commit hash and seed (bind evidence to an exact commit).

## 5. New curated cases (hand-written, 20 files)

Each starts with a `# Edge case:` header. Sketches (direction line omitted; runner supplies it):

1. `edge-multi-edge-k4.exd` (T3): `a[Producer]`, `b[Consumer]`, four `a -> b : one|two|three|four`.
2. `edge-multi-edge-k5-mixed.exd` (T3/T4): `a -> b : solid`, `a --> b : dashed`, `a -.-> b : dotted`, `a <-> b : both`, `b -> a : back`.
3. `edge-self-loops-matrix.exd` (T5): `r[Rect]`, `e(Ellipse)`, `d{Diamond?}`, `c[(Cyl)]`, each with `x -> x : retry`, plus `r -> e -> d -> c`.
4. `edge-self-loop-double.exd` (T5): `w[Worker]`, `w -> w : retry`, `w -> w : poll`, `in -> w`, `w -> out`.
5. `edge-self-loop-in-group.exd` (T5/G11): `group g "Pool" :blue { w[Worker] }`, `w -> w : heartbeat`, `src -> w`.
6. `edge-chain-12-labeled.exd` (T7/D5): `s1 -> s2 -> ... -> s12 : step` on one line, nodes `s1[Stage 1]` ... declared.
7. `edge-fan-out-14.exd` (T9): `hub{Router?}` -> 14 workers, one shared label `: route`.
8. `edge-fan-in-12-to-cylinder.exd` (T9/X9): 12 services -> `db[(Metrics DB)]` with distinct labels.
9. `edge-bipartite-k4-4.exd` (T11): 4 sources x 4 sinks, every edge labeled `: a1-b3` style.
10. `edge-skip-rank-labeled.exd` (T15): chain `a -> b -> c -> d -> e`, plus `a -> c : skip1`, `a -> e : skip3`, `b -> e : skip2`, `e -> a : loop`.
11. `edge-tiny-1-node.exd` (T14): `title "Just one"`, `only[Only node]`. And `edge-tiny-2-nodes-loop.exd`: `a[A]`, `b[B]`, `a -> a : self`, `a <-> b : pair`.
12. `edge-size-disparity.exd` (X1): `t[X]` and `u[A very long node label that spans most of the row width here]`, `v[L1\nL2\nL3\nL4]`, `t -> u : m`, `u -> v : n`, `v -> t : o`, `t -> v : p`.
13. `edge-label-wider-than-gap.exd` (X2): `a[A] -> b[B] : This label is far wider than the sixty pixel rank gap between the nodes`, `b -> c[C] : and so is this one, placed between two adjacent ranks`, `a -> c : short`.
14. `edge-brackets-in-labels.exd` (X7): `f[f(x) -> y]`, `g(see [1] and [2])`, `h{is x in [0, 1)?}`, `k[(table (shard 1))]`, edges with labels containing `[`, `(`, `->`, `:`, `"issue #5"` quoted.
15. `edge-whitespace-labels.exd` (X6): `a[  padded  ]`, `b[\nleading newline]`, `c[trailing\n]`, `d[two  spaces]`, edges `: \nsecond line only`.
16. `edge-title-wider-than-diagram.exd` (X10): `title "An unusually long diagram title that is much wider than the two nodes below it"`, `a[A] -> b[B]`. And a 3-line title variant in the same file is impossible (one title) -> second file `edge-title-multiline.exd` with `title "Line one\nLine two\nLine three"` if the title accepts `\n`, else skip.
17. `edge-group-title-wider-than-content.exd` (G5/G7): `group g "A zone title far longer than the single small node inside" :green { n[N] }`, `group h "Parent" :blue { group i "Child with a long title" :purple { m[M] } }`, `n -> m : x`.
18. `edge-sibling-groups-many-edges.exd` (G3): two groups of 3 nodes, 9 cross edges (3x3) all labeled, 2 of them reversed.
19. `edge-five-sibling-groups.exd` (G9): 5 groups of 1-2 nodes in one rank fed by `root`, titles of varying length.
20. `edge-dup-fanout-cross-product.exd` (D4): `a, b -> c, d : first`, `a, b -> c, d : second`, `c, d -> a : back`.
21. `edge-id-prefix-aliases.exd` (D10): node ids `node`, `cap`, `zone_x`, `a`, `a1`, `a_1`, group `group_a`; edges among them (checker nodeKey robustness; if the checker misattributes, fix the checker, see 6).
22. `edge-declared-after-group-use.exd` (D7/G8): `x -> y : early` at top, then `group g "G" :blue { y[Y] ; z[Z] }`, `y -> z`.

Expected: several of these fail on 935618f (T3, T5, T9, X2, G5 most likely); they are the reason for the stage.

## 6. Checker gaps (new rules for `scripts/qa/analyze.mjs`)

All tolerances in px; new entries in `RULES` and `TOL`; each needs a minimal synthetic scene in `test/qa.test.ts` that triggers it and a near-miss that does not.

| code | sev | definition | tolerance |
|---|---|---|---|
| `arrowhead-inside-node` | HARD | the last point of an arrow (end with `endArrowhead`, or both ends for `<->`) lies more than 3 px *inside* its bound node's polygon (arrowhead hidden by the fill; for cylinders test body and cap) | 3 |
| `arrow-end-on-wrong-side` | SOFT | an arrow's last segment enters its bound node through a side whose outward normal has positive dot with the segment direction (i.e. approaches from behind) | n/a |
| `label-far-from-arrow` | HARD | an edge label's drawn center is more than 2 px from its own arrow's polyline (the anchor insertion failed or Excalidraw's rule differs) | 2 |
| `label-outside-zone` | HARD | an edge label whose arrow has both ends in zone Z (same `groupIds`) is drawn outside Z's rect, or a label drawn inside a zone none of its arrow's ends belong to by > 1 px | 1 |
| `zone-title-crossed` | HARD | any arrow segment crosses a zone-title text box (shrunk 1 px) | 1 |
| `arrows-collinear-overlap` | HARD | two segments of arrows of *different* node pairs are parallel (sin < 0.05), closer than 4 px and overlap along their direction by >= 24 px (they are drawn on top of each other) | 4 / 24 |
| `arrow-through-zone-title` folded into `zone-title-crossed` | | | |
| `label-outside-canvas` | SOFT | any text or arrow point lies at x<0 or y<0 or outside the scene bounds (bounds should start at MARGIN 20) | 0 |
| `multiline-text-clipped` | HARD | a node label with `lines > 1` whose height exceeds container height minus 4 px (extends `text-overflow`, already covered: add an explicit multiline test case) | 4 |
| `label-near-arrowhead` | SOFT | an edge label box is within 6 px of either end point of its own arrow (label sitting on the arrowhead) | 6 |
| `self-loop-shape` | HARD | an arrow bound to the same node at both ends has fewer than 3 points, or any point inside the node's shrunk polygon (loop collapsed onto the node) | 2 |
| `edge-label-duplicate-spot` | folded into `label-label-overlap` | | |
| `degenerate-segment` | SOFT | any arrow segment shorter than 2 px (anchoring left stacked vertices) | 2 |
| `checker-id-collision` | HARD | two scene elements map to the same `nodeKey` (e.g. node ids `cap-x` and `x`); make `nodeKey` prefix-aware: only strip `node-`/`cap-` when the element id actually starts with that *and* the remainder exists as a node id emitted by `ids.ts`; prefer reading `groupIds` `cyl-<id>` to pair caps | n/a |

Also: `parallel-edges-close` currently keys on `startBinding/endBinding`; add a test that `k=3` with one reversed edge reports each close pair once, and that `<->` counts.

## 7. Vision-review protocol (later stage, after the pass-rate bar is met)

- **What gets PNGs:** all curated corpus renders (4 dirs), all promoted fuzz repros, and a seeded random sample of N=40 *passing* fuzz renders (stratified: 4 per profile) to catch what the geometric checker cannot. `node scripts/qa.mjs --png` and `node scripts/fuzz.mjs --png --sample 40` produce them under `out/qa/` and `out/fuzz/sample/`.
- **Review packets:** `scripts/qa/gallery.mjs` writes `out/review/index.html` (static, no network): one card per render with PNG, the `.exd` source, HARD/SOFT findings, and a checklist form; and `out/review/manifest.json` listing packets of <= 12 images for vision agents.
- **Checklist per render (pass/fail/n-a each, plus one free-text line):** V1 every arrow visibly starts at and ends on its nodes; V2 no arrowhead hidden; V3 every edge label readable, adjacent to its own arrow, not over another arrow; V4 no text overlapping text; V5 node labels fit their shapes (incl. diamonds/ellipses); V6 zones enclose exactly their members and titles are readable; V7 no arrow passes through a node; V8 parallel/reciprocal edges distinguishable; V9 self-loops look like loops; V10 overall: would a human accept this diagram as-is (yes/no).
- **Feed-back:** vision results are written as `out/review/results/<case>-<dir>.json`; `gallery.mjs --merge` colours cards and lists "vision fail but checker pass" cases, which become candidates for new checker rules (section 6 process) or new curated cases.

## 8. Implementation units (Sonnet agents)

Common constraints: no changes under `src/**`; every file < 500 lines; scripts are ESM `.mjs` with no new deps; TOON output rules as in qa.mjs; deterministic outputs; nothing written to the project root. Each unit gets its own worktree; F0 is the integration owner and merges in order F0 -> F4 -> F1 -> F2 -> F3.

| unit | owner | files (exclusive) | depends | acceptance | commands |
|---|---|---|---|---|---|
| F0 shared runner | `qa-core` | `scripts/qa/run.mjs` (new: runDraw, pool, toon table, DIR_LINE, drawCase), `scripts/qa.mjs` (refactor to import it; output byte-identical), `package.json` scripts `fuzz`, `fuzz:ci`, `shrink`, `promote`, `qa:gallery` (owner-only edit) | none | `npm run qa` report.json identical to before the refactor on the same build (diff) | `node scripts/qa.mjs` |
| F1 generator + fuzz CLI | `fuzzer` | `scripts/qa/gen.mjs`, `scripts/qa/profiles.mjs`, `scripts/qa/prng.mjs`, `scripts/fuzz.mjs`, `test/fuzz-gen.test.ts` | F0 | 1000 generated cases per profile parse with 0 errors (test, via dist parser); same seed -> identical text; `--emit-only` writes .exd without drawing; default run < 120 s on the dev box with `--jobs 4`; exit codes as specified; report.json schema matches qa.mjs plus `profiles[]` | `node scripts/fuzz.mjs --count 60`, `--profile dense --seed 7` |
| F2 shrinker + promotion | `shrinker` | `scripts/qa/shrink.mjs`, `scripts/shrink.mjs`, `scripts/promote.mjs`, `scripts/qa/signature.mjs`, `test/shrink.test.ts` | F0, F1 (`emit()`, model) | shrinking `edge-triple-parallel.exd` (or any current failing corpus case) in <= 400 oracle calls yields a repro that still reproduces the code and is no larger than the input; deterministic (two runs identical); promotion dedups against the 44 files; a promoted file passes `qa.test.ts` header check | `node scripts/shrink.mjs out/fuzz/dense/123-DOWN.exd --dir DOWN`, `node scripts/fuzz.mjs --shrink --promote --promote-max 5` |
| F3 curated cases | `corpus` | `test/qa/corpus/edge-*.exd` listed in section 5 (new files only), `test/qa.test.ts` corpus count bump (>= 60) | none (can start immediately) | every file parses (`check` exit 0 or warnings only), draws in 4 dirs, and has a `# Edge case:` header naming the taxonomy id; each file documents the expected failure mode | `node scripts/qa.mjs --only edge-` |
| F4 checker rules | `checker` | `scripts/qa/analyze.mjs`, `scripts/qa/geom.mjs`, `test/qa.test.ts` (rule tests only; coordinate the corpus-count line with F3 via F0) | none | every new rule has a positive and a near-miss synthetic test; all old tests pass; `nodeKey` collision test; rule table in section 6 implemented with the stated tolerances; running on the 44 files shows no new rule firing on a render that passes vision review (spot-check 5 with `--png`) | `vitest run test/qa.test.ts`, `node scripts/qa.mjs` |
| F5 gallery (later) | `review` | `scripts/qa/gallery.mjs`, `docs/qa-review-checklist.md` | F1, F2 | index.html opens offline, lists all cards, manifest packets <= 12 | `node scripts/qa/gallery.mjs --in out/qa,out/fuzz --out out/review` |

**Gate (after the concurrent fix agent lands in `src/layout/**`, `src/scene/**`):** `npm run build && npm run qa` must report `hard: 0` on the full curated corpus (44 + ~22 new = 100 %); then `npm run fuzz` must meet the 90 % bar overall and per profile. Failures go through section 4's loop: real bug -> minimal repro to the fix agent; false positive -> F4 fixes the rule with a test proving the geometry is fine (evidence: PNG). CI: add `npm run fuzz:ci` (`--count 10 --jobs 2`, seed fixed) after `npm run qa` in `.github/workflows/ci.yml` (orchestrator-owned edit).

## 9. Risks and open questions for the user

1. **Bar semantics for fuzz:** should the 90 % per-profile bar apply to `stress-60` and `dense` from day one, or should they start as "report only" for the first two iterations and become gating once realistic profiles hit 99 %? Plan assumes gating from day one (as stated), with the stall rule as the escape.
2. **Checker tolerances are judgment calls** (collinear overlap 4 px / 24 px, label-far-from-arrow 2 px, arrowhead-inside 3 px). Accept defaults, or do you want a PNG-backed calibration pass before any new rule becomes HARD (SOFT first for one iteration)?
3. **Promotion volume:** auto-promoting into `test/qa/corpus/` grows the test corpus and `npm test` time (each file = 1 draw in `qa.test.ts`). Cap at 10 per run and a total of ~40 fuzz-* files, or keep promoted repros in `test/qa/fuzz-corpus/` run only by `scripts/qa.mjs`?
4. **RTL / combining marks (X5):** include in the `unicode` profile by default, or only behind `--rtl` (Excalidraw's RTL rendering is itself uneven, so failures may be unactionable)?
5. **Vision review cost:** N=40 sampled passing renders per iteration, plus curated and repros (~150 PNGs). OK, or smaller sample?

## Decisions (user, 2026-10-23)

1. dense and stress-60 profiles: report-only for iterations 1-2, gated at 90 % from iteration 3.
2. New checker rules ship as SOFT for one iteration, then promoted to HARD (after false-positive review).
3. Shrunk repros go to a separate `test/qa/fuzz-corpus/` (run by `scripts/qa.mjs` alongside `test/qa/corpus/`, reported separately); the hand-written corpus stays curated.
4. RTL/combining-mark labels only behind `--rtl` (not counted in the default pass rate).
5. Orchestrator note: test/qa.test.ts corpus-count line is owned by F0/orchestrator at merge; F3 does not edit it.
