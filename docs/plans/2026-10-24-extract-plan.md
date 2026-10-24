# Plan: `extract` v1 (TS/JS import graphs -> `.exd`, budgeted cut, router-aware)

Status: APPROVED by the user (session 9, 2026-10-24): all 8 open questions answered with the recommended option. Fable planner, read-only. Builds on `docs/research/2026-10-23-extract.md` (measured oxc run, aggregation sketch, command surface) and Appendix A of `docs/plans/2026-10-23-diagram-axi-plan.md:297-301` (user decision: v1 = TS/JS static imports via oxc-parser + oxc-resolver). No extract code exists yet in `src/` (grep for extract/oxc/tree-sitter hits only docs and `package-lock.json:667`, `@oxc-project/types@0.155.0` pulled in transitively).

## 1. Scope

### 1a. Options

| option | languages | cost | fidelity | verdict |
|---|---|---|---|---|
| A. oxc-parser + oxc-resolver (research 3.1, Appendix A) | TS, JS, TSX/JSX, CJS `require`, dynamic `import()` | 2 MIT deps, ~2.9 MB JS + one platform binding (~1.6 MB parser, ~1.9 MB resolver; npm installs only the matching `optionalDependencies` entry); node `^20.19 \|\| >=22.12` | resolver handles tsconfig `paths`, `exports`, `extensionAlias .js->.ts`; measured 57 files / 201 edges / 0 unresolved / 24 ms | **recommended** (user already chose it) |
| B. zero-dep regex scanner + own resolver | ESM/CJS TS/JS | 0 deps, ~300 lines | misses imports in odd positions, approximates `isType`, must reimplement `paths`/`exports` | fallback if A's binding fails on a CI OS |
| C. TypeScript compiler API | TS/JS + call graph | `typescript` 9.1 MB at runtime (today devDep only), ~1 s load; TS 7 has no API (research 3.2) | exact | no: cold start and dead-end API |
| D. web-tree-sitter + grammars | many | 4.7 MB wasm + 1-2 MB per grammar; name-only resolution | heuristic | v1.5 for Python, not v1 |

### 1b. v1 = `extract imports`, graph levels file + folder

- In: TS/JS/TSX/JSX/MJS/CJS files under `<path>`; edges = static imports, re-exports, dynamic imports, `require()`; type-only edges tagged (`isType`), hidden by default. Containment tree = directories. External packages counted, not drawn (`--externals count|show`). Tests and generated/vendored paths filtered. One `.exd` plus one JSON sidecar.
- Out (v1): call graphs (v1.5, `confidence` tagged), exported-symbol nodes (sidecar carries an `exports` count only), Python/Go/Rust/Java, barrel see-through (A->index->B rewritten to A->B needs symbol matching; v1.5), `extract open|check|doctor`, drawing inside `extract` (it emits; `draw` renders), monorepo `--level package` (workspace packages are treated as directories in v1).

## 2. The core problem: hundreds of nodes vs ~25

Real repos: this one has 98 `src/*.ts` files; the router fits excalidraw at <= 25 nodes, edges <= 2 x nodes, <= 8 arrows per node, <= 6 cross-group edges, group depth <= 2 (`src/engines/route.ts:29-51`, limits imported from `src/lint/rules.ts:9-21`). The pipeline below is designed so the emitted `.exd` passes `check` with 0 errors and no HARD quality row, and the router line is honest about the rest.

Pipeline (pure functions, `src/extract/aggregate.ts` then `src/extract/to-exd.ts`): RawGraph -> filter -> cut -> roll-up -> hubs -> cycles -> emit.

1. **Filter.** Drop externals (counted; `--externals count` adds one node `npm (12 packages)`, `show` adds up to 5 heaviest then `+k more`), test files (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`; `--tests` keeps), `node_modules`, `dist`/`build`/`out`, `.d.ts`, `--exclude <globs>` (comma-separated: string flags keep the last value, `src/cli/args.ts`), type-only edges (`--types` keeps, drawn `-.->`). Nothing is dropped silently: every filter has a count in the summary.
2. **Containment cut** to `--max-nodes N` (default 25 = `MANY_NODES`). Visible set starts as the root's direct children (dirs collapsed, files as is). Repeatedly expand the collapsed dir with the highest `subtreeFiles * (1 + weightedDegree)` while `visible <= N`; ties by path. Single-child chains (`src/main/java/com/x`) compress into one node. Expanded dirs become `group`s only to depth 2 (`MAX_DEPTH`); deeper expansions flatten with a path-prefixed label. `--expand <id,...>` forces dirs open; `--level file` disables collapsing (cut by `--focus` only), `--level dir` never expands below depth 1.
3. **Roll-up.** Edges between leaves sum into one edge per ordered visible pair; label `x7` when weight > 1 (one word: `wordy-edge-label` stays quiet). A->B and B->A both survive (2 edges per pair = `MAX_PARALLEL`); self-edges (intra-dir) are dropped and counted. Dynamic-only edges draw dashed `-->`.
4. **Hubs.** A visible node whose rolled-up degree > `MAX_DEGREE` (8) keeps its box, loses its incoming edges and is labelled `ast.ts\nused by 20` with `:yellow`; `--hubs show` restores the edges. Lint-consistent (`busy-node` never fires) and it is what makes layered import graphs legible (research 5.4: `dsl/ast.ts` had 20 of 57 dependents).
5. **Cycles.** Tarjan SCC on the visible rolled-up graph; member nodes get `:red`, the summary prints `cycles: 1 (layout/route.ts, layout/repair.ts)`, the sidecar lists SCCs. Edges take no color in the DSL (`src/guide/slices.ts:44`), so cycle marking lives on nodes.
6. **Focus.** `--focus <path>` BFS from that file or dir, `--depth N` (default 2), `--dir out|in|both` (default `both`); the reached subgraph then goes through steps 2-5; unreached neighbours collapse into one stub `... +k more` per visible node, with the expand command in `help[]`.
7. **Emit.** `title "imports: src (19 of 98 files)"`, `dir DOWN`; ids `f_<path>` / `g_<path>` sanitized to `[A-Za-z0-9_]` (lexer id rules `src/dsl/lexer.ts:13-19,99-105`; prefixes avoid the keywords `dir|direction|title|group`, `src/dsl/parser.ts:122-124`), deduped with `_2`. Labels: file basename; collapsed dir `layout/ (17 files)`; cut to `MAX_LINE` 40 chars (`long-label` never fires). Nodes declared inside their group body; edges after all groups.

Router interaction: with dirs drawn as groups, most inter-dir edges are cross-group (`crossGroupEdges` counts ungrouped nodes as their own group, `src/lint/rules.ts:193-197`), so the default view of any real repo prints `engine: suggest d2 (cross-linked: 14 cross-group edges); add --engine d2`. This is intended: the research table (section 6) already routes nested import graphs > 12 nodes to d2 (ELK, containers), and d2 passed groups-nested 4/4 in vision (`2026-10-24-skill-engine-selection-plan.md` 1b). `extract` prints the same `recommendationLine()` and puts `draw imports.exd --engine d2 --png` first in `help[]`. `--group none` (flat, labels `layout/engine.ts`) or a small `--focus` view is the excalidraw path. `dense` can still fire after hub suppression on hairballs; it is reported, never fixed by dropping edges.

## 3. CLI surface

```
diagram-axi extract <path> [--focus <file|dir>] [--depth N] [--dir out|in|both] [--level auto|file|dir]
    [--max-nodes 25] [--expand <id,..>] [--group dir|none] [--include <globs>] [--exclude <globs>]
    [--externals hide|count|show] [--types] [--tests] [--hubs hide|show] [--tsconfig <file>]
    [--out imports] [--format exd|json] [--engine excalidraw|d2|mermaid|auto] [--force]
```

- One command, no `imports` subcommand in v1 (`extract calls` etc. arrive as subcommands later; the router in `src/cli/router.ts:45-53` resolves two-word keys, so `extract` can become an alias for `extract imports` then). `--engine` only changes which draw command `help[]` prints and silences/forces the `engine:` line like `check` (`quietRoute`, `src/commands/engine-io.ts:118-120`).
- Output (TOON, <= ~25 lines):

```
extract: ok, 98 files, 312 import edges in src (ts, js)
graph: 19 nodes (6 dirs, 13 files), 31 edges; hidden: 20 externals, 7 test files, 2 hubs (41 edges), 9 type-only
cycles: 1 (layout/route.ts, layout/repair.ts)
unresolved: 0
outputs[2]{kind,path,bytes}:
  exd,imports.exd,1834
  map,imports.exd.map.json,9120
engine: suggest d2 (cross-linked: 14 cross-group edges); add --engine d2
help[3]:
  diagram-axi draw imports.exd --engine d2 --png
  diagram-axi extract src --focus src/commands/draw.ts --depth 2
  diagram-axi extract src --expand src/layout
```

`unresolved[N]{file,specifier,reason}` (8 rows, `N of M total`) appears when > 0; `warnings[]` for a missing tsconfig (`no tsconfig found; paths aliases unresolved; pass --tsconfig`). `--format json` writes the normalized graph (research section 4 schema) instead of `.exd` for tools.
- Exit codes: 0 ok (large graphs are cut, unresolved specifiers are reported, both exit 0), 1 extraction failure (path unreadable, no source files, parser crash, refused overwrite), 2 usage (unknown flag/value, `--focus` not under `<path>`, `--depth` not a positive integer).
- Determinism: files sorted by posix path (forward slashes at the adapter boundary, research 10), edges by (from, to), stable ids, no timestamps; `meta.repo.rev`/`dirty` from `git rev-parse HEAD` / `git status --short` via `spawnSync` with a 5 s timeout, omitted outside a repo. Byte-identical `.exd` across runs and OSes (CI compares on 3 OSes).
- No network: oxc runs in-process; git is local. `extract` never loads the browser, WASM or Mermaid (lazy imports as in `getEngine`, `src/commands/engine-io.ts:53-58`).
- Sidecar `imports.exd.map.json`: `{schema:1, meta{root,langs,rev,dirty,extractor{name,version},stats{files,edges,unresolved}}, nodes{id->{path,kind,files?,loc?}}, edges[{from,to,weight,typeOnly,dynamic,evidence[{path,line}]}], hidden{externals[],tests[],hubEdges[],sccs[][]}}`. Lets an agent go box -> file without `extract open`.

## 4. Dependencies

- Add runtime `oxc-parser@0.155.0` (MIT; `parseSync(...).module.staticImports/staticExports/dynamicImports`, `isType`, byte offsets -> lines) and `oxc-resolver@11.24.2` (MIT; `extensionAlias {".js":[".ts",".tsx",".js"]}`, `tsconfig {configFile}`, `conditionNames ["import","require","node","default"]`). Exact pins like `@d2lang/d2`. Lazy `import()` inside `src/extract/ts/scan.ts`, so `draw/check/...` cold start is unchanged; `extract` adds one native binding load (ms). Compared with the 92 MB `@d2lang/d2` already shipped, the ~4 MB is minor.
- Stop condition (U-E1 acceptance 1): if the binding fails to load on any CI OS (ubuntu/windows/macos, Node 22), try `@oxc-parser/binding-wasm32-wasi` (1.67 MB, exists on npm; the resolver has no wasm build, so it would need option B's resolver), else fall back to option B for both. Report before continuing.
- `engines.node` `>=20` -> `>=20.19` (oxc requirement; `package.json`). NOTICE: two MIT entries. No Python, no binaries, no downloads.

## 5. Evaluation

1. **Unit fixture** `test/fixtures/extract/ts-app/` (~15 files, 3 dirs): tsconfig `paths` alias, `.js` specifier to a `.ts` file, `index.ts` barrel, `import type`, dynamic `import()`, `require`, a 2-file cycle, a `*.test.ts`, an external package, a `.d.ts`, a deep single-child chain. Goldens: `test/golden/extract/ts-app.raw.json` (every edge hand-verified, with lines) and `ts-app.exd`, `ts-app-focus.exd`, `ts-app-flat.exd` byte-compared (LF via `.gitattributes`). Table test for the cut on a synthetic 300-file RawGraph (budget 25 never exceeded; score ordering; chain compression; depth-2 flattening).
2. **Correctness oracle** (`test/extract-scan.test.ts`): an independent regex re-derivation (`from "x"`, `import("x")`, `require("x")`) resolved by the same resolver must agree with oxc on the fixture 100% and on this repo's `src/` with 0 unresolved and `files == glob count` (98 today; assert equality to the glob, not a constant). Every emitted rolled-up edge must be backed by >= 1 raw edge (`evidence` non-empty).
3. **Readability QA** `scripts/qa/extract.mjs` (manual, network once): clone 6 pinned public TS/JS repos into `out/extract-corpus/<name>@<sha>/` (small to large: `tj/commander.js`, `colinhacks/zod`, `honojs/hono`, `fastify/fastify`, `vitest-dev/vitest` packages/vitest, `excalidraw/excalidraw` packages/excalidraw) plus this repo; per repo run default, `--group none`, `--focus <entry> --depth 2`, `--max-nodes 15` (28 cases); each `.exd` goes through `check` (0 errors, no HARD quality row) and `draw --engine auto --svg --geometry-json` into the existing checker via `drawCase` with `text` (`scripts/qa/run.mjs`), report `out/qa-extract/report.json`. Bar: 0 HARD on every default view, >= 90% of cases HARD-clean, every case `many-nodes`/`busy-node`/`long-label`/`deep-nesting` silent (the cut guarantees these). Vision: one Sonnet packet over the 28 PNGs with V1-V10 plus two extract rules (V-E1: the entry point and its layer are identifiable; V-E2: group titles read as folders).
4. **Agent-usefulness check** (`scripts/extract-eval.mjs emit|score`, pattern of `scripts/skill-eval.mjs`): for 2 repos (this one, hono) `test/extract-eval/questions.json` holds 15 questions with answers derived from the raw graph (which folder depends on `dsl/`, what sits in a cycle, which 3 files to read first to follow `draw`). Three tool-less Sonnet agents get the TOON output, the `.exd` and the sidecar; bar >= 12/15 and every agent names the entry file for the "where to start" question. Manual, not CI.
5. CI (`npm test`): 1, 2 and the command tests; `npm run validate` (new command has `--help`, examples, TOON, exit codes).

## 6. Units (Sonnet, separate worktrees, disjoint files)

| unit | owns | depends on | gate |
|---|---|---|---|
| U-E1 scanner | `src/extract/types.ts` (RawGraph, Extractor), `src/extract/discover.ts` (walk, ignore rules, tsconfig lookup), `src/extract/ts/scan.ts` (oxc parse + resolve, lines from offsets), `src/extract/git.ts`, `test/extract-scan.test.ts`, `test/fixtures/extract/ts-app/**`, `test/golden/extract/ts-app.raw.json`; dependency lines handed to the orchestrator (installed locally in the worktree) | none; commits `types.ts` first (within 30 min) so U-E2 can import it | `npm test -- --maxWorkers=4`; acceptance 1 (binding loads on 3 OSes via a CI push of the worktree branch) else stop and report |
| U-E2 aggregate + emit | `src/extract/aggregate.ts`, `src/extract/to-exd.ts`, `src/extract/sidecar.ts`, `test/extract-aggregate.test.ts`, `test/extract-emit.test.ts`, `test/golden/extract/*.exd` | U-E1 `types.ts` only (hand-written RawGraph fixtures) | `npm test`; every golden passes `parse()` + `lint()` with 0 warnings except `cross-group-edges`/`dense-graph`, and `check` on it has no HARD row |
| U-E3 command + docs | `src/commands/extract.ts`, `src/guide/extract-slice.ts` (`syntax extract`, <= 350 tokens), `test/cli-extract.test.ts`, `README.md` (commands table line 177 area, a "Learn a codebase" section), `src/skill/content.ts` (3-line golden-path addition + root help row) and regenerated `skills/diagram-axi/SKILL.md`, `test/guide.test.ts` | U-E1 + U-E2 merged | `npm test`, `npm run skill:check` (cap 1400 at `test/guide.test.ts:158`; SKILL is at 1320 after the polish, so the addition is <= 80 tokens or the cap moves to 1500 with user OK), `npm run validate` |
| U-E4 QA + eval | `scripts/qa/extract.mjs`, `scripts/extract-eval.mjs`, `test/extract-eval/questions.json`, `package.json` scripts `qa:extract`, `extract-eval` | U-E3 | `npm test`; orchestrator runs section 5.3-5.4 and fills Results |

Orchestrator-owned edits at merge: `src/index.ts:11-25` (register `extract`), `src/render/outputs.ts` (`OutputKind` + `"exd" | "map"`, one line, so `writeTarget` in `src/commands/shared.ts:194-199` is reused), `package.json` (deps, engines, scripts), `NOTICE`, `.github/workflows/ci.yml` unchanged. Order: U-E1 || U-E2 -> merge E1, then E2 (cherry-pick + `npm test`) -> U-E3 -> U-E4 -> QA + vision + L2 -> Results + handoff -> user sign-off. Every brief: never kill processes by image name; `--jobs 3` / `--maxWorkers=4`.

## 7. Open questions (recommended first)

1. v1 languages: TS/JS only via oxc (Appendix A decision) vs add Python via web-tree-sitter now. Recommend TS/JS only; Python v1.5.
2. Default `--group dir` (folders as groups; default views route to d2) vs `--group none` default (flat, fits excalidraw more often, loses the folder picture). Recommend `dir` and follow the router.
3. Hub rule: degree > 8 (`MAX_DEGREE`, lint-consistent) vs 90th percentile (research 5.4). Recommend > 8.
4. `extract` emits only (then `draw`) vs an `--png` shortcut that draws inside `extract`. Recommend emit-only in v1: one step per command, `extract` never needs a browser.
5. `engines.node` `>=20` -> `>=20.19` for oxc. Recommend yes (Node 20.19 is the current 20.x line).
6. QA corpus: vendored fixture in CI + 6 pinned public repos cloned manually into `out/` vs fixtures only. Recommend both; pinned shas recorded in `scripts/qa/extract.mjs`.
7. Sidecar `imports.exd.map.json` written always vs only with `--map`. Recommend always (it is the drill-down path without `extract open`).
8. SKILL.md: 3-line mention + `syntax extract` slice under the 1400 cap vs raising the cap to 1500. Recommend try under the cap first.

## Results

Decisions during implementation (user, session 9): hub rule is iterative (busiest node over MAX_DEGREE loses incoming edges, outgoing capped at the 8 heaviest, `uses K (8 shown)`, repeat; `--hubs show` disables); title counts files covered by visible boxes (`100 of 100 files`), not boxes; a recurring CI-only timing flake gets a `process.env.CI` allowance, local budgets unchanged.

Merged: U-E1 `3c24f52`, `1de6d90`, `8e6057a` (tips d16c210, 2978b0d, 20fe16e; oxc binding + extract-scan 21/21 on ubuntu/windows/macos, CI run 40092794378); U-E2 `0f04c34`, `5aadcac` (tips 684b3c2, 8bec1c2); `75a8e4c` NOTICE + vitest excludes `test/fixtures/**`. Suite 1821 pass / 6 skipped. This repo's `src/`: 102 files, 393 edges, 0 unresolved, ~40 ms.

QA round 1 (session 9, main `1323b4f`; U-E4 tips 1abed8c, 18d7fc3, 3e757be): pinned corpus commander v15.0.0, zod v4.6.7, hono v4.13.13, fastify v5.12.7, vitest v5.0.5, excalidraw v0.18.1 + self (shas in `scripts/qa/extract.mjs`).
- `qa:extract`: 28/28 HARD-clean, 0 check errors; auto engine d2 in 6 cases, excalidraw in 22. Observations: 9 detached hub boxes in 7 cases; 22 crowded hub labels (>= 3 lines) in 13 cases; 6 d2 scenes >= 2500 px tall, PNG scale reduced in 18 cases (mostly wide excalidraw scenes).
- Usefulness eval (3 tool-less Sonnet agents, 15 questions on self + hono): 15/15, 15/15, 15/15, all name the entry file. Caveat: many answers are readable straight from labels/sidecar.
- Vision (3 Sonnet batches): **20/28 accepted (71%)**, default views 6/7. Rejects: excalidraw-default/none/focus, hono-none, hono-max15, vitest-none, fastify-none, zod-focus. Causes: dense graphs (25 nodes, 43-50 edges) stay on excalidraw because flat views never trip cross-group and density stays under edges > 2 x nodes; focus/entry file not marked; fastify budget spent on edge-less folders (21:1 single row); tiny grey d2 edge labels (noted, not rejected).
- User decision: one Sonnet fix round (dense -> suggest d2 incl. flat views; mark entry/focus; edge-less folders counted as isolated, not drawn; d2 edge labels if cheap), then rerun qa:extract + vision on the same 28 cases.

Fix round 1 (worktree tip 483d4fa, not merged): extract-only density rule (>= 12 connected boxes and > 1.75 edges/box or in-degree >= 7 -> suggest d2), green entry/focus marks + `entry`/`focus` label line, edge-less files dropped as `isolated: N`, path-cut labels; d2 edge-label styling skipped (would change all d2 goldens). Gates: 1949 tests, 28/28 HARD-clean.
- Vision round 2: **20/28 (71%)**, default views 4/7. Fixed: zod-focus, hono-none, hono-max15, excalidraw-focus. Regressed: fastify-default/focus (isolated rule dropped files whose only import is the hub-entry -> 4 boxes), vitest-default (entry vitest.mjs marked but edge-less), self-none (25/39 on excalidraw). Still rejected: excalidraw-default/none (25/50 too dense even on d2), vitest-none, fastify-none. Reviewer variance between rounds is visible (n = 1 image per view).
- User decision: fix round 2 (isolated = truly edge-less only; mark entry only with drawn edges; auto-lower budget for dense views; truly flat `--group none`), rerun, vision with 2 reviewers per image; if still < 90%, ship `extract` as experimental with the numbers.

Fix round 2 (worktree tips 1b6ec0f, 0380ad4): isolated = no import edge at all; files that only import a hub stay drawn and fold into their folder; partial folder opening (`+N more files`); entry marked only with a drawn edge (dist entry followed to src, else next candidate); auto budget for dense views (>= 15 connected boxes, > 1.5 edges/box; smaller cut only if it reaches 1.5 or drops the ratio >= 0.25; floor 12; prints `budget N (dense)`); engine threshold > 1.5 edges/box from 15 boxes (1.75 for 12-14) or in-degree >= 7; `--group none` warns when identical to default. Edges are written grouped by target: the only order that kept d2/ELK from routing an arrow through a box on all 28 cases (corpus-tuned workaround; the d2 behaviour is not fixed). Gates: 1967 tests (two clean reruns by the orchestrator, ~75 s), 28/28 HARD-clean.
- Vision round 3, 2 Sonnet reviewers per image: both accept 23/28 (**82%**), average **87.5%**, either accepts 26/28 (93%); default views 6/7 strict, 7/7 lenient. Rejected by both: vitest-none (3100 px wide flat view, labels on overlapping bundles). Split: hono-default, vitest-max15, self-max15. vitest views mark no entry (package entry points into unscanned dist/).
- **User decision: merge both fix rounds and ship `extract` as experimental** (`--help` summary, SKILL line and README note with the numbers and weak spots). Merged on main: `c6d7a7e`, `3be2ca3`, `5898c16`, label `f7a133b`. Suite 1966 pass / 7 skipped; SKILL.md 5477 chars (~1370 / 1400 tokens).
- Data kept in `out/` (git-ignored): `extract-corpus/` (226 MB, pinned clones), `qa-extract-r3/` (r1 data deleted after the session, numbers above) (report.json, png/, vision-packet.md — its PNG paths still point at the removed worktree; use `out/qa-extract-r3/png/`), `extract-eval/` (packets + answers).

(filled after the units merge: commits, fixture counts, `qa:extract` pass rate, vision verdicts, L2 score)
