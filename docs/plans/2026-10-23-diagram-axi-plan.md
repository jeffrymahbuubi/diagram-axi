---
title: diagram-axi - multi-engine umbrella CLI (excalidraw, d2, mermaid)
type: feat
date: 2026-10-23
revised: 2026-10-23 (session 2; user answers Q1-Q3 + engines/extract research applied)
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
base_commit: fee2bf1  # units that touch shared files branch from main only after layout round 4 and 6203df5 have landed (see Merge order)
---

# diagram-axi - Plan

## Goal Capsule

- **Objective:** An agent in a terminal describes a diagram once (`.exd` for boxes-and-arrows, native `.d2`/`.mmd` for sequence, class, ERD, state, timeline, gitGraph, mindmap) and gets the right-looking rendering for the context (hand-drawn whiteboard, dense clean architecture, or Markdown-inline) from one tool, offline, in one command whose output costs a few hundred tokens; every engine's graph output is held to the same measured QA bar (>= 90 % renders with 0 HARD findings, 99 % stretch) before the user relies on it.
- **Means:** An engine interface under `src/engines/<name>/` (translate, validate, render, geometry, capabilities) behind the existing AXI commands, with the current pipeline becoming the `excalidraw` engine, D2 as the `@d2lang/d2` WASM package (optional pinned binary for browser-less PNG) and a bundled Mermaid 12.2 running in our own browser page as the other two, a deterministic router that prints an engine recommendation, and the existing QA harness/dashboard extended per engine (KTD1-KTD9).
- **Authority:** User decisions (name + alias `dg-axi`, engines, hybrid DSL scope, local-only, QA bar, model roles, Mermaid in our page, extract v1 = TS/JS imports) > memory notes (`production-qa-gate`, `worktree-merge-procedure`, `no-image-name-kill`, `dashboards-use-kit`) > research (`docs/research/2026-10-23-engines.md`, `-extract.md`) > this plan > AXI spec (`axi-axi principles`) > implementer judgment.
- **Stop conditions:** Stop and report if `@d2lang/d2` fails to load in Node 24 on Windows/macOS/Linux CI or its `compile()` JSON lacks `shapes[].pos/width/height` or `connections[].route` for the fixture (U2 acceptance 1), if the Mermaid IIFE cannot run inside a second page of the existing playwright-core browser (U3 acceptance 1), if any engine's curated-corpus pass rate is below 80 % after one fix round (bake-off signal that the engine is a bad fit, not a bug), or if `axi-axi validate` needs a scaffold change.
- **Execution profile:** Fable planned; Opus orchestrates (owns `src/index.ts`, `package.json`, `NOTICE`, `.github/workflows/ci.yml`, `test/qa.test.ts` counts, all merges via worktree commit + `git cherry-pick --no-commit` + `npm test` gate, never `cp`); Sonnet implements one unit per worktree with disjoint file ownership. Every brief states: never kill processes by image name; stop only your own PIDs; use timeouts. User signs off after the per-engine QA rounds; nothing is pushed or published.

---

## Product Contract

### Summary

`diagram-axi` (alias `dg-axi`, both shipped by rename commit `6203df5`) replaces `excalidraw-cli-axi`. The same `draw / render / check / inspect / syntax / home` commands gain `--engine excalidraw|d2|mermaid` (default excalidraw) and understand three source types: `.exd` (portable graph DSL, translated to every engine), `.d2` and `.mmd` (engine-native, wrapped). `check` and `draw` print an `engine:` line that either confirms the engine or suggests a better one with the reason. A new `engines` command shows engine status and versions and optionally installs the D2 binary into the tool cache (download + SHA-256 + version pin; offline afterwards). The QA harness, fuzzer and dashboard run per engine over the shared corpus using the same geometric checker fed from engine geometry through a neutral model.

### Problem Frame

excalidraw-cli-axi is weak on dense/multi-edge graphs (fuzz `dense` profile is the floor of every round) and cannot express sequence, class, ERD, state, timeline, gitGraph or mindmap diagrams, which the user needs to learn system design and how code in a codebase interacts. D2 (ELK/TALA layout, sequence/class/ERD, optional sketch) and Mermaid (state/timeline/gitGraph/mindmap, renders inline on GitHub) cover those gaps. The D2 bake-off (`out/bakeoff/d2-bakeoff/`, d2 v0.9.0) rendered 352/352 curated+fuzz renders with ELK (median 297 ms, 0 failures); the Mermaid bake-off (`out/bakeoff/mermaid-bakeoff/`, mermaid 12.2.0) rendered 704/704; vision review of both is pending. Research (`docs/research/2026-10-23-engines.md`) verified: `@d2lang/d2@0.1.34` is byte-identical to the CLI SVG and returns compile errors with ranges plus full diagram geometry JSON; `d2 validate` is parse-only; Mermaid in our own page renders warm in ~10-60 ms vs 1.6-2 s per mermaid-cli call and exposes exact edge polylines via `data-points`.

### Key Decisions

- **Name `diagram-axi`, one package and bin, alias `dg-axi`; old bins dropped.** Already shipped in `6203df5` (bins `bin/diagram-axi.js`, `bin/dg-axi.js`). Governs R1. (user)
- **Hybrid DSL scope.** `.exd` stays the only portable DSL and covers graph diagrams on every engine; other kinds are engine-native `.d2`/`.mmd` wrapped by the same commands. Governs R2-R4. (user)
- **Agent chooses the engine; the tool recommends, never silently switches.** `draw` uses the default or `--engine`; `--engine auto` opts into following the recommendation. Governs R5. (planner)
- **D2 is the `@d2lang/d2@0.1.34` WASM package in-process (compile = check, diagram JSON = geometry, SVG byte-identical to the CLI); PNG is a screenshot of that SVG in our Chrome (D2 embeds its fonts, so machine-independent); the pinned d2 v0.9.0 binary is an optional extra (`engines install d2`) for browser-less PNG.** One SVG code path (WASM) keeps goldens, geometry and PNG consistent (WASM sketch SVG differs from CLI sketch, so the binary never produces SVG for us). Governs R6, KTD6. (planner, from research)
- **Mermaid is a pinned `mermaid@12.2.0` + `@mermaid-js/layout-elk@1.0.1` IIFE executed in our own playwright-core page (second page in the same browser the renderer launches); no mermaid-cli, no puppeteer, no Chrome download.** Governs R7, KTD3. (user)
- **Same QA bar and checker for every engine; geometry goes engine -> neutral model -> scene through a per-engine adapter; rules an engine cannot be measured on are masked and reported, never silently passed.** Governs R8-R10. (user bar, planner mechanism)
- **Archify stays a separate skill; `extract` is a later phase: v1 = TS/JS static import graphs (oxc-parser + oxc-resolver), interfaces only in this plan.** Governs R12. (user)

### Requirements

- R1. One npm package `diagram-axi` with bins `diagram-axi` and `dg-axi`; `excalidraw-cli-axi`/`exd-axi` no longer exist anywhere in `src/`, `bin/`, `skills/`, `README.md`, env vars (`DIAGRAM_AXI_*`) or cache dir (`<cache>/diagram-axi/`). Owned by `6203df5` (deferred: `src/scene/palette.ts` `SOURCE` URL, 6 goldens, 3 README examples; orchestrator finishes them right after the cherry-pick); this plan only consumes it.
- R2. `draw <file.exd> [--engine e]` produces, per engine: excalidraw -> `<base>.excalidraw` (+ `--png/--svg`); d2 -> `<base>.d2` (translated source, editable) + `<base>.svg` always + `<base>.png` on `--png`; mermaid -> `<base>.mmd` + `<base>.svg` always + `<base>.png` on `--png`. The `outputs[N]{kind,path,bytes}` table and `scene:` line keep their shape; `scene:` gains `engine <e>` and `layout <l>`.
- R3. `draw/render/check/inspect` accept `.d2` and `.mmd` files; the engine is inferred from the extension (a conflicting `--engine` is a usage error, exit 2); the diagram kind is read from `--kind`, else a `# kind: <k>` (D2) / `%% kind: <k>` (Mermaid) header, else the first keyword (`sequenceDiagram`, `stateDiagram-v2`, `timeline`, `gitGraph`, `mindmap`, `classDiagram`, `erDiagram`, `flowchart|graph`; D2 `shape: sequence_diagram|class|sql_table`), else `graph`.
- R4. `check` on a native source = full engine compile/parse (D2: WASM `compile()`, all errors in one pass, `line:col` + `endCol` + `suggestion`; Mermaid: `parse()` then a try-render, `line:col` where the parser gives it) plus size lints (`many-nodes`, `long-label` where countable), a `remote-icon` warning for D2 `icon: http(s)://` (network at render time) and the `kind:` line; `check` on `.exd` keeps today's output and adds `engine:`; with `--engine d2|mermaid` it also translates and validates the translation and reports `losses[]` (KTD2).
- R5. Routing: `check` and `draw` (when `--engine` is not explicit) print at most one line `engine: <e> (<reason>)` or `engine: suggest <e> (<reason>); add --engine <e>` using KTD4 (user decision 2026-10-23: silent when a graph fits the default excalidraw engine; printed for a suggestion, `--engine auto`, `--target` or a native source); `--engine auto` applies the suggestion. `--target markdown|github` forces mermaid for every kind; `--target editable` forces excalidraw.
- R6. `engines` lists each engine with `status: ready|missing|browser-missing`, versions (`d2 0.9.0 (wasm 0.1.34)`, `mermaid 12.2.0 + elk 1.0.1`), the PNG path in use (`png: browser|binary|none`) and the install command; `engines install d2` downloads the pinned v0.9.0 release for the current OS/arch from `github.com/d2lang/d2`, verifies SHA-256 against checksums committed in the repo, extracts into `<cache>/diagram-axi/engines/d2/<version>/`, and is a no-op when present. Nothing downloads implicitly; D2 SVG and `check` always work offline (WASM). `--d2-path` / env `DIAGRAM_AXI_D2_PATH` select a binary; a `d2` on PATH is used with a `version-mismatch` warning when it is not v0.9.0.
- R7. Mermaid renders need the same installed browser the excalidraw renderer already finds (`--browser-path`, env `DIAGRAM_AXI_BROWSER_PATH`, discovery); no puppeteer, no Chrome download; the bundle is prebuilt into `dist/render/mermaid-elk.iife.js` and its version pinned in `package.json` and printed by `engines`.
- R8. `scripts/qa.mjs --engine <e>` and `scripts/fuzz.mjs --engine <e>` run the shared corpus (68 curated + 20 fuzz-corpus + seeds) through `draw --engine <e> --svg`, obtain geometry via the engine adapter and run `analyzeScene` with the engine's rule mask; reports go to `out/qa-<e>/` and `out/fuzz-<e>-s<seed>/` with the same `report.json` schema plus `engine`, `layout` and `rules_skipped[]`.
- R9. Pass bar per engine for graph diagrams: curated >= 99 % (aim 100 %), fuzz >= 90 % per profile and overall, measured on held-out seeds 3-4 after fixes developed on seeds 1-2; vision review V1-V10 on all curated PNGs and a stratified sample of 40 passing fuzz renders; results reviewed in the local dashboard; user sign-off. Native kinds (no graph geometry): render-success rate 100 % on the native sample corpus + overlap/bounds checks + vision review only.
- R10. The dashboard shows one round per engine (`round-<n>-<engine>`), the same four sets, and a cross-engine comparison row; no code changes beyond an `engine` field and the comparison row.
- R11. Token budget: `home` and every `syntax [engine] <topic>` slice <= 350 tokens (chars/4, enforced by `test/guide.test.ts`); `SKILL.md` <= 1,400 tokens; `engine:` and `kind:` lines <= 20 tokens each; `--help` of every command lists `--engine` once.
- R12. `extract` (code -> `.exd`) is specified as an interface and command sketch only (Appendix A); no implementation in this plan.

### Scope Boundaries

- In: three engines, graph translation to all of them, native wrapping of seven kinds, routing, optional D2 binary management, QA/dashboard per engine, SKILL/README, migration of tests, NOTICE/licence entries.
- Out (this plan): new `.exd` syntax for non-graph kinds; share links or accounts; Archify integration; `extract` implementation; D2 `layers/scenarios/steps` (multi-board: rendered as-is, not measured); Mermaid themes beyond `base` + the eight palette colors and diagram types beyond the eight listed; D2 `play`; remote icon fetching; TALA as a QA-gated layout (available via `--layout tala`, measured later).

### Acceptance Examples

- AE1. `dg-axi check dense.exd` (34 edges, 3 parallel pairs) -> `check: ok ...`, `quality[...]`, `engine: suggest d2 (dense: 34 edges, 3 parallel pairs); add --engine d2`, exit 0.
- AE2. `dg-axi draw dense.exd --engine d2 --png` -> `outputs[3]` (d2, svg, png), `scene: 20 nodes, 34 edges, 2 groups, 1587x1047 px, direction RIGHT, engine d2, layout elk`, `quality: ok`, `help[3]`.
- AE3. `dg-axi draw login.mmd` where line 1 is `sequenceDiagram` -> `kind: sequence`, `engine: mermaid (native .mmd)`, `outputs[1]` svg beside the input (the `.mmd` is never rewritten); `--png` adds png; `quality: n/a (kind sequence has no graph rules)`.
- AE4. `dg-axi draw a.exd --engine d2 --png` with no browser found and no cached binary -> `.d2` and `.svg` written, exit 1, `error: no PNG renderer for d2 (browser not found, binary not installed)`, `suggestion: --browser-path <chrome>, or diagram-axi engines install d2 (needs network once), or --d2-path <exe>`.
- AE5. `dg-axi check bad.d2` -> `check: failed, 2 errors`, `errors[2]{line,col,endCol,code,message,suggestion}` mapped from the WASM `compile()` range array (`index,2:1:13-2:5:17` -> `3:2-6`), exit 1.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Engine interface** (`src/engines/types.ts`, see High-Level Design). Engines are plain objects registered in `src/engines/registry.ts`; commands never import engine internals. The current pipeline (`src/layout`, `src/scene`, `src/render`) is wrapped unchanged as `src/engines/excalidraw/`.
- KTD2. **Translators are the bake-off scripts, ported.** `exd2d2.mjs` and `exd2mmd.mjs` (`out/bakeoff/*/scripts/`) become `src/engines/d2/translate.ts` and `src/engines/mermaid/translate.ts` with identical output for identical input (the bake-off `d2src/*.d2` and `out/mmd/*.mmd` are the first goldens). Each returns `{ source, losses: Loss[] }`; losses are the bake-off notes (per-shape `sketchy` flag, edges to groups, dotted vs dashed on Mermaid, multi-line titles, empty groups) and surface as `warnings` rows with code `engine-loss`.
- KTD3. **Mermaid runs in our own browser page.** `scripts/build-mermaid.mjs`: entry `import mermaid from 'mermaid'; import elk from '@mermaid-js/layout-elk'; mermaid.registerLayoutLoaders(elk); window.mermaid = mermaid;` bundled with esbuild `--format=iife --minify` into `dist/render/mermaid-elk.iife.js` (~6 MB, measured load 0.28 s). `src/engines/mermaid/page.ts` opens a second page in the browser `src/render/browser.ts` already launches (one launch per CLI run; separate pages avoid global/CSS clashes with the Excalidraw bundle), injects the IIFE, and calls `mermaid.initialize({ startOnLoad:false, securityLevel:"strict", htmlLabels:false, flowchart:{htmlLabels:false}, deterministicIds:true, deterministicIDSeed:"diagram-axi", handDrawnSeed:1, suppressErrorRendering:true, look:"classic", layout:"elk", themeVariables:{ fontFamily:<embedded font from src/render/fonts.ts> } })`; `--sketch` sets `look:"handDrawn"`, `--layout dagre` overrides. Each render uses a fixed unique id; same-page re-renders are never compared byte-wise. Validation = `mermaid.parse(src)` then a real `render()` in try/catch (parse misses render-time semantic errors); error mapping: Jison `e.hash.loc.first_line/first_column` (1-based line, 0-based col; clamp to document length; add stripped-frontmatter line count), Langium `/line (\d+), column (\d+)/`, `UnknownDiagramError` -> no position + suggestion listing the eight kinds, raw `TypeError` -> `unlocated` with the diagram type. PNG = `page.screenshot` of the `<svg>` element with `deviceScaleFactor` = `--scale`.
- KTD4. **Routing rules** (`src/engines/route.ts`, pure function over `Graph` + kind + target): (1) explicit `--engine` wins; (2) `--target markdown|github` -> mermaid, `--target editable` -> excalidraw; (3) kind != graph: sequence/class/erd -> d2, state/timeline/gitgraph/mindmap -> mermaid (sequence -> mermaid when target is markdown); (4) graph "fits excalidraw" when nodes <= 25, edges <= 2 x nodes (checked only when nodes >= 6), parallel pairs (>2 edges between a pair) == 0, max degree <= 8, group depth <= 2, cross-group edges <= 9 (no lint peer; revisit after the D2 vision round); otherwise suggest d2 with the first failing measure(s) as reason. Thresholds mirror the lints `many-nodes`, `too-many-nodes`, `dense-graph`, `parallel-edges`, `busy-node`, `deep-nesting` so the suggestion never contradicts `check`; constants imported from `src/lint/rules.ts` (`ROUTE_LIMITS`), test table; tuned once after the D2 vision round.
- KTD5. **Geometry via a neutral model, same checker.** `src/engines/neutral.ts` (U1): `NeutralScene { nodes[{id,kind:"node"|"zone",box,shape,parent?}], edges[{id,src,dst,poly:[x,y][],label?:box}], labels[{box,ownerId}] }` and `toScene(neutral): SceneElement[]` emitting the id conventions of `src/scene/ids.ts` (`node-<id>`, `zone-g-<gid>`, `zone-title-<gid>`, arrows `edge-<i>` with bindings, bound text) so `src/quality/analyze.ts` runs unmodified. Origin translated to >= 0; shape by type (rectangle/ellipse/diamond; bbox + inset for hexagon/cylinder/others). D2 adapter reads `compile().diagram.shapes[]` (`id`, `type`, `pos`, `width/height`, `level`, label sizes) and `connections[]` (`src/dst`, `route[]`, `isCurve` -> sample cubic segments 12 steps, `labelPosition/labelPercentage` for the label box); containers = shapes whose id prefixes others; lifelines `(x -- )[n]` filtered. Mermaid adapter runs in-page: `g.node` shape element bbox (not the `g`), `g.cluster`, `path[data-edge]` with `data-points` (base64 JSON polyline) mapped through `getCTM()` (fallback `getPointAtLength` sampling), `g.edgeLabel`; edge ends bound by `data-id` (`L_<src>_<dst>_<n>` flowchart, `id_<src>_<dst>_<n>` class/er, order for state); client rects mapped to user space via the viewBox. Rule mask per engine: skip `label-stored-offset`, `text-exceeds-inscribed` (Excalidraw-specific) and `text-overflow` unless the adapter has label boxes; endpoint tolerance 4 px (markers, rounded corners). Non-graph kinds (sequence, class, erd, state, timeline, gitgraph, mindmap): overlap/overflow/bounds rules only, crossings/route-ratio skipped. `rules_skipped[]` appears in reports. Findings for engine diagrams are advisory: hint text (in `src/engines/<e>/hints.ts`, never in round-4-owned `src/quality/hints.ts`) suggests `--layout elk|tala|dagre`, `direction`, label shortening, not coordinates.
- KTD6. **D2 runtime = WASM, binary optional.** `src/engines/d2/wasm.ts` lazily imports `@d2lang/d2` once per process (cold start ~1.3 s, warm compile+layout 25-110 ms elk, render 55-140 ms) and exposes `compile(src, { layout, sketch, themeID, pad: 32, scale })` + `render()`; `data-d2-version` is stripped for goldens. `src/engines/fetch.ts` (generic download, sha256, `tar -xzf` with a `node:zlib` fallback, pid-suffixed temp dir, atomic rename) + `src/engines/d2/release.json` (v0.9.0; assets `d2-v0.9.0-{windows,linux,macos}-{amd64,arm64}.tar.gz` from `https://github.com/d2lang/d2/releases/download/v0.9.0/`; per-platform sha256 copied from the release `SHA256SUMS`; windows-amd64 = `5f63b643de8f5a6dfb922d172e1b5496e4caf47497c33c4427cf1127f28c340f`). Cache base = `dirname(fontCacheDirectory())` (inherits the `diagram-axi` path from 6203df5); env `DIAGRAM_AXI_CACHE_DIR` overrides. PNG resolution order: browser screenshot of the WASM SVG (default; side capped at 2048 px like the bake-off) > binary `d2 --layout <l> [--sketch] --pad 32 in.d2 out.png` when `--d2-path`/cache/PATH provides v0.9.0 and no browser is found > error (AE4).
- KTD7. **Native sources are never rewritten.** `draw x.d2` renders beside the input (`<base>.svg/.png`); `inspect x.mmd` renders to SVG in memory and counts from the geometry adapter (nodes, edges, clusters, bounds; per-kind aggregates such as participants/messages, tables/columns) so there is one source of truth and no second parser; kinds without geometry report `nodes/edges: n/a`.
- KTD8. **QA per engine reuses `scripts/qa/run.mjs`.** `drawCase` gains `engine` (passes `--engine <e> --svg --force`, reads `<base>.svg` or the neutral JSON sidecar `<base>.geometry.json` written by `draw --geometry-json` for QA only), `analyzeScene(elements, { skip: engine.rulesSkipped })`; curated-corpus output for the excalidraw engine stays byte-identical to the post-round-4 baseline (regression guard).
- KTD9. **Licences.** D2 (binary, WASM, TALA) is MPL-2.0: used unmodified as a dependency/tool; `@d2lang/d2` keeps its LICENSE/THIRD_PARTY_NOTICES in `node_modules`; NOTICE lists D2 v0.9.0 (source `github.com/d2lang/d2`, unmodified), Source Sans/Code Pro (OFL, embedded in D2 SVGs), `mermaid` + `@mermaid-js/layout-elk` (MIT) and elkjs (EPL-2.0, bundled in the IIFE). The binary is never vendored (downloaded from the official release, verified). Our code stays MIT.

### High-Level Technical Design

```ts
// src/engines/types.ts
export type EngineId = "excalidraw" | "d2" | "mermaid";
export type Kind = "graph" | "sequence" | "class" | "erd" | "state" | "timeline" | "gitgraph" | "mindmap";
export interface Capabilities { kinds: Kind[]; sourceExt: ".exd" | ".d2" | ".mmd"; outputs: OutputKind[]; sketch: boolean; layouts: string[]; /* d2: dagre|elk|tala, mermaid: dagre|elk */ inlineMarkdown: boolean; geometry: boolean; }
export interface Loss { code: string; detail: string; line?: number; col?: number }
export interface Diagnostic { line?: number; col?: number; endCol?: number; code: string; message: string; suggestion?: string }
export interface EngineStatus { status: "ready" | "missing" | "browser-missing"; version?: string; png?: "browser" | "binary" | "none"; path?: string; install?: string }
export interface Engine {
  id: EngineId; capabilities: Capabilities;
  status(opts): Promise<EngineStatus>;                         // never downloads
  translate?(graph: Graph, o: TranslateOptions): { source: string; losses: Loss[] };   // graph engines
  validate(source: string, o): Promise<Diagnostic[]>;        // full compile/parse(+render) with positions when available
  render(source: string, o: EngineRenderOptions): Promise<RenderResult & { svg: string; neutral?: NeutralScene }>;
  geometry?(r: RenderResult): { elements: SceneElement[]; rulesSkipped: string[] };   // toScene(neutral) + mask
  detectKind(source: string): Kind | undefined;
}
```

Flow: `draw` -> `readSource` -> `detect(ext, header)` -> (exd: parse -> lint -> `route()` -> engine.translate) | (native: engine.detectKind) -> engine.validate -> write source (exd->d2/mmd only) -> engine.render (D2: WASM compile+render, neutral from diagram JSON; Mermaid: page render, neutral from the DOM) -> write svg/png -> `engine.geometry` -> `qualityHints` -> TOON. `excalidraw.render` is today's `renderScene`; `excalidraw.geometry` returns the scene elements directly.

Output kinds grow to `"excalidraw" | "d2" | "mmd" | "png" | "svg"` (`src/render/outputs.ts`, orchestrator-owned one-line change at merge, after 6203df5).

### Command surface

| Command | Change |
|---|---|
| `draw <file>` | `--engine`, `--kind`, `--target`, `--sketch` (d2 sketch / mermaid handDrawn), `--layout dagre|elk|tala` (d2) / `dagre|elk` (mermaid), `--theme`, `--d2-path`; accepts `.exd/.d2/.mmd`; `engine:` line when not explicit |
| `render <file>` | `.excalidraw` as today; `.d2/.mmd` render natively through their engine; `--sketch/--layout/--scale/--theme`; `.exd` is rejected with `suggestion: use draw` |
| `check <file>` | `engine:` + `kind:` lines; native compile/parse; `--engine` validates the translation and lists `losses`; `remote-icon` warning |
| `inspect <file>` | `.d2/.mmd/.svg` aggregates via geometry; `engine`, `kind`, `layout` fields |
| `syntax [engine] [topic]` | `syntax` index: exd topics + `d2: sequence class erd style example` + `mermaid: state timeline gitgraph mindmap example` + `routing`; bare `syntax nodes` keeps working (`exd` implied) |
| `engines`, `engines install d2` | status table (versions, png path) / optional binary download |
| home | scenes list includes `.excalidraw/.d2/.mmd` (newest 10), one `engines: excalidraw ready, d2 ready (png browser), mermaid ready` line, DSL teaser unchanged |

SKILL.md (generated from `src/skill/content.ts`): golden path unchanged for `.exd`, plus a six-line "pick the engine" table (kind -> engine, dense -> d2, Markdown -> mermaid), the `engine:` line semantics, `--layout tala` for architecture diagrams, and `syntax d2 sequence` / `syntax mermaid state` pointers; the two native examples live in slices, not in SKILL.md.

### Dependencies and licensing

Runtime: `@d2lang/d2@0.1.34` (MPL-2.0; ~96 MB unpacked, node-esm WASM 41 MB; exact pin). Dev/bundled: `mermaid@12.2.0` (MIT), `@mermaid-js/layout-elk@1.0.1` (MIT, contains elkjs EPL-2.0), esbuild (present). Optional download: d2 v0.9.0 binary (MPL-2.0, 18 MB tarball, 43 MB exe). NOTICE per KTD9. `engines` prints every version.

Predecessors (not units of this plan, all orchestrator-run): (a) layout round 4 in a worktree on `d24dc7a` (`src/layout/**`, `src/quality/hints.ts`, tests) -> commit in worktree -> cherry-pick -> `npm test` -> held-out seeds 3/4 -> vision re-review -> dashboard `round-4`; (b) `git cherry-pick --no-commit 6203df5` (rename; touches `src/commands/*`, `src/render/*`, `package.json`, README, CI, skill, tests) -> `npm test` -> commit; (c) deferred rename items (`SOURCE` URL, `UPDATE_GOLDEN=1`, 3 README examples); (d) re-take the excalidraw QA baseline (`out/qa/report.json` at that commit) for KTD8. The repo folder rename breaks worktree paths: do it only when `git worktree list` shows main alone (between waves or after wave 4).

### Assumptions

- Wave-0 units create new files only (`src/engines/**`, `src/guide/*-slices.ts`, `dashboard/**`, new tests) and import `TOOL` from `src/commands/shared.ts` and `fontCacheDirectory()` rather than hard-coding names, so they can start before (a)-(c) land; U6 waits for them.
- `@d2lang/d2` loads under Node 24 on all three CI OSes (verified on Windows only); the installed browser can run the Mermaid IIFE in a second page (verified on Windows Chrome).
- Mermaid geometry is machine-stable only with an embedded font family; the renderer's existing embedded fonts are reused.

---

## Implementation Units

Unit index:

| U | Title | Key files | Depends on |
|---|---|---|---|
| U1 | Engine contract, registry, neutral model, excalidraw adapter, fetch/cache | `src/engines/{types,registry,neutral,fetch,cache,detect}.ts`, `src/engines/excalidraw/*`, `test/engines-core.test.ts` | none (new files) |
| U2 | D2 engine (WASM + optional binary) | `src/engines/d2/*`, `test/engines-d2*.test.ts`, `test/golden/d2/*`, `test/fixtures/d2/*` | U1 |
| U3 | Mermaid engine (own page) | `src/engines/mermaid/*`, `scripts/build-mermaid.mjs`, `test/engines-mermaid*.test.ts`, `test/golden/mermaid/*`, `test/fixtures/mermaid/*` | U1 |
| U4 | Router + recommendation | `src/engines/route.ts`, `test/route.test.ts` | U1 (types only) |
| U5 | Syntax slices d2/mermaid/routing | `src/guide/{d2-slices,mermaid-slices,routing-slice}.ts`, `test/guide-engines.test.ts` | none |
| U6 | Command wiring | `src/commands/*.ts`, `src/commands/engines.ts`, `test/cli-engines.test.ts`, `test/commands.test.ts` | U1-U5, round 4 + 6203df5 merged |
| U7 | SKILL/README/docs | `src/skill/content.ts`, `skills/diagram-axi/SKILL.md`, `README.md`, `docs/examples/*` | U6, U5 |
| U8 | QA harness per engine + native corpus | `scripts/qa/run.mjs`, `scripts/qa.mjs`, `scripts/fuzz.mjs`, `scripts/qa/engines.mjs`, `test/qa/native/*` | U6 |
| U9 | Dashboard engine rounds | `dashboard/kit.config.json`, `dashboard/scripts/**`, `dashboard/src/**` | none (code), U8 (data) |
| U10 | QA rounds + vision review per engine (orchestrator-run) | `out/`, `docs/plans/<this>.md` Results | U8, U9 |
| U11 | Release gate | `.github/workflows/ci.yml`, `NOTICE`, `package.json`, `axi-axi validate` | all |

### U1. Engine contract, registry, neutral model, excalidraw adapter, fetch/cache

- **Goal:** the interface everything else builds on, the shared geometry bridge, the current pipeline as the first engine and the generic download/cache utilities.
- **Requirements:** R2 (excalidraw path), R6 (fetch/cache), KTD1, KTD5 (neutral + `toScene`), KTD6 (fetch).
- **Files:** `src/engines/types.ts`, `src/engines/registry.ts` (`engines()`, `engineFor(id)`, `engineForExt(ext)`), `src/engines/neutral.ts` (`NeutralScene`, `toScene()`, `sampleCubic()`, origin translation, shape mapping), `src/engines/detect.ts` (extension + header + first-keyword kind detection, R3), `src/engines/fetch.ts` (download with `redirect: follow`, sha256, tar extract with zlib fallback, pid temp dir, atomic rename), `src/engines/cache.ts` (`engineCacheDir(name, version)` from `dirname(fontCacheDirectory())`, env override), `src/engines/excalidraw/index.ts` (wraps `layout`+`buildScene`+`renderScene`; `geometry` returns scene elements; `status` = browser discovery), `test/engines-core.test.ts`. New files only.
- **Approach:** types + neutral first (commit within 30 min so U2-U4 can start from the worktree commit); `toScene` is ported from the research prototype `out/research/engines-lab/scripts/d2-to-scene.mjs` and made engine-agnostic; the excalidraw adapter calls existing modules, no logic copied; fetch is tested against a local `http`-served tarball fixture, never the network.
- **Acceptance:** `engineFor("excalidraw").render` output equals `renderScene` for `test/fixtures/render-smoke.excalidraw`; `toScene` on a hand-written neutral fixture (3 nodes, 1 zone, 3 edges, 1 curved) yields ids `analyzeScene` accepts and no finding on x<0; `detect` passes a table of 16 sources (ext x header x keyword); fetch rejects a wrong sha256 and leaves no partial dir; `npm test` green.

### U2. D2 engine (WASM + optional binary)

- **Goal:** `.exd` -> D2 source, compile-based validation, SVG/geometry from `@d2lang/d2`, PNG via browser or optional binary.
- **Requirements:** R2-R4, R6, KTD2, KTD5, KTD6, KTD9.
- **Files:** `src/engines/d2/{index,translate,wasm,binary,validate,render,geometry,hints}.ts`, `src/engines/d2/release.json`, `test/engines-d2.test.ts`, `test/engines-d2-geometry.test.ts`, `test/golden/d2/*.d2` (10 corpus cases x DOWN/RIGHT from the bake-off `d2src/`) + `*.svg` (version attribute stripped), `test/fixtures/d2/{ok,bad1..4,icons,sequence,sql}.d2`; the `@d2lang/d2` dependency line is handed to the orchestrator (not edited in the worktree; the worktree installs it locally).
- **Approach:** acceptance 1 first; port `exd2d2.mjs` verbatim (reserved-word quoting, `$` escaping, qualified container paths, title as `near: top-center` text); `wasm.ts` imports `@d2lang/d2` lazily once per process; `validate` = `compile()` with the rejected `Error.message` JSON array `[{range:"file,l0:c0:b-l0:c0:b", errmsg}]` -> `Diagnostic` (0-based +1; `endCol` from the range end; `code` and `suggestion` from a small regex table: `maps must be terminated` -> "add a closing }", `unknown shape` -> list of shapes, `valid named color` -> hex form, `near key` -> list of positions); `remote-icon` warning for `icon: http`; `render` = `compile()` + `render()` with `--layout elk` default (`dagre|tala` allowed; `tala` warns `slow` above 30 nodes), `--sketch`, `pad 32`; `geometry` builds the neutral model from `diagram.shapes/connections` (KTD5; sequence lifelines filtered; `sql_table`/`class` as whole boxes); PNG = `src/render/page.ts`-style screenshot of the SVG at `--scale`, side capped at 2048 px; `binary.ts` resolves `--d2-path` > env `DIAGRAM_AXI_D2_PATH` > cache > PATH (`d2 version` check) and is used only for PNG when no browser is found (`d2 --layout <l> [--sketch] --pad 32 --scale <s> in.d2 out.png`); never call `d2 play`/`validate`.
- **Acceptance:** (1) `compile()` of a 3-node fixture returns `shapes[]` with `pos/width/height` and `connections[]` with `route[]` and loads in < 3 s cold, else stop and report; translation goldens byte-equal to the bake-off sources; SVG goldens byte-equal across two runs and equal to the bake-off CLI SVG for `ok.d2` after stripping `data-d2-version`; `bad1.d2` yields >= 2 diagnostics with `line:col:endCol` and one `suggestion`; `icons.d2` yields a `remote-icon` warning; geometry of `day-rag-agent` yields 5 nodes, 1 zone, 5 arrows with bound labels for all three layouts and `analyzeScene` runs without throwing; `sequence.d2` geometry has no lifeline edges; PNG tests auto-skip without a browser; binary tests auto-skip without a cached binary and run in CI with it.

### U3. Mermaid engine (own page)

- **Goal:** `.exd` -> Mermaid flowchart, validation and render in our browser page, geometry from the live DOM.
- **Requirements:** R2-R4, R7, KTD2, KTD3, KTD5, KTD9.
- **Files:** `src/engines/mermaid/{index,translate,page,validate,render,geometry,hints}.ts`, `scripts/build-mermaid.mjs`, `test/engines-mermaid.test.ts`, `test/engines-mermaid-geometry.test.ts`, `test/golden/mermaid/*.mmd` (+ 2 committed SVGs), `test/fixtures/mermaid/{a,bad-jison,bad-langium,unknown,state,timeline,gitgraph,mindmap,sequence,class,er}.mmd`; `package.json` devDependency lines (`mermaid@12.2.0`, `@mermaid-js/layout-elk@1.0.1`) and the `build:mermaid` script handed to the orchestrator.
- **Approach:** spike first (acceptance 1); port `exd2mmd.mjs` (frontmatter config, `classDef` palette, `n_`/`g_` id mangling, `<br>` labels become `\n` with `htmlLabels:false`); `page.ts` mirrors `src/render/page.ts` (virtual origin, inline IIFE, `initialize` per KTD3, one page per process, reused across renders); `validate` per KTD3 (parse, then try-render; three error shapes; frontmatter line offset covered by a test); `geometry` is an in-page script returning the neutral model (KTD5 selectors; sequence via `rect.actor` deduped by name + `line.messageLine*`; gitGraph/mindmap/timeline aggregate-only); gitGraph determinism: `translate` never emits gitGraph, native gitGraph sources are rendered but excluded from byte-equality tests (documented).
- **Acceptance:** (1) the IIFE renders `test/fixtures/mermaid/a.mmd` to SVG in a second page of the existing browser in < 2 s cold and < 100 ms warm, else stop and report; translation goldens byte-equal to the bake-off `.mmd`; two renders of each golden `.mmd` in fresh pages are byte-identical (all kinds except gitGraph); `bad-jison.mmd` and `bad-langium.mmd` each give one diagnostic with `line:col`, `unknown.mmd` gives a suggestion listing kinds; all eight kind samples render; geometry of `day-rag-agent` yields the same counts as U2's; browser-less tests auto-skip.

### U4. Router + recommendation

- **Goal:** the pure routing function and its wording.
- **Requirements:** R5, KTD4.
- **Files:** `src/engines/route.ts`, `test/route.test.ts`.
- **Approach:** `route(graph|kind, { engine?, target?, defaultEngine })` -> `{ engine, explicit, reason, suggestion? }` and `recommendationLine(r)`; measures computed from `Graph` only (no layout); reasons are terse (`fits: 12 nodes, 14 edges`, `dense: 34 edges, 3 parallel pairs`, `kind sequence`, `target markdown`).
- **Acceptance:** table test of 20 graphs incl. every threshold edge; every corpus `.exd` yields a line <= 20 tokens; `check` lint codes and routing agree on the 68 curated files (no `suggest d2` without at least one of `dense-graph|parallel-edges|busy-node|too-many-nodes|deep-nesting`).

### U5. Syntax slices for d2, mermaid, routing

- **Goal:** token-sized reference slices the agent reads before writing native sources.
- **Requirements:** R11.
- **Files:** `src/guide/d2-slices.ts` (`sequence`, `class`, `erd`, `style`, `example`; `style` covers `--layout dagre|elk|tala`, `sketch`, `near`), `src/guide/mermaid-slices.ts` (`state`, `timeline`, `gitgraph` with explicit commit `id:`s, `mindmap`, `example`), `src/guide/routing-slice.ts`, `test/guide-engines.test.ts`.
- **Approach:** same `Slice` shape as `src/guide/slices.ts`; every `example` is complete native source; tests assert <= 350 tokens per rendered slice and, once U2/U3 are merged, that each example validates with 0 errors (until then a parse-shape check).
- **Acceptance:** 11 slices, all under budget, `syntax d2 erd` shows a `sql_table` example that D2 compiles.

### U6. Command wiring

- **Goal:** the commands expose engines, kinds, targets, layouts and native sources.
- **Requirements:** R2-R7, AE1-AE5.
- **Files:** `src/commands/{draw,render,check,inspect,syntax,home,shared}.ts`, `src/commands/engines.ts`, `src/index.ts` registration and `src/render/outputs.ts` kinds (orchestrator applies), `test/cli-engines.test.ts`, `test/commands.test.ts` updates.
- **Approach:** branches from main only after round 4 and 6203df5 are in; `shared.ts` gets `resolveInput(file, flags)` -> `{ engine, kind, sourceType, source }` and `engineLine()`; draw/render/check/inspect branch on `sourceType` (exd vs native) and otherwise call the engine; one browser launch per run shared by excalidraw/mermaid/d2-png pages; `syntax` resolves `[engine] [topic]` with `exd` implied; home adds the `engines:` line (status checks never download or load WASM; version strings are constants) and scans `.d2/.mmd`; `draw --geometry-json` (hidden, QA-only) writes the neutral model.
- **Acceptance:** AE1-AE5 as golden TOON in `test/cli-engines.test.ts` (browser renders skipped when missing; WASM paths always run); existing `test/commands.test.ts` goldens unchanged for the excalidraw path except the added `engine`/`layout` fields in `scene:`; `home` <= 350 tokens; `--help` of every command mentions `--engine` once; `axi-axi validate` passes.

### U7. SKILL, README, docs

- **Goal:** agents learn the engine choice from SKILL.md in <= 1,400 tokens; humans from README.
- **Requirements:** R11, KTD9 (licence paragraph in README).
- **Files:** `src/skill/content.ts`, `skills/diagram-axi/SKILL.md` (generated), `README.md` (Engines section, optional binary install, licences, examples), `docs/examples/*.{d2,mmd,svg,png}` (one per native kind + the order pipeline in all three engines).
- **Acceptance:** `npm run skill:check` green; SKILL.md token count asserted in `test/guide.test.ts`; README examples regenerate with the documented loop.

### U8. QA harness per engine + native corpus

- **Goal:** the production QA gate runs for d2 and mermaid with the same checker and bar.
- **Requirements:** R8, R9, KTD8.
- **Files:** `scripts/qa/run.mjs` (`engine`, `layout` options), `scripts/qa.mjs`, `scripts/fuzz.mjs` (`--engine`, `--layout`), `scripts/qa/engines.mjs` (neutral JSON read, `toScene`, rule mask), `test/qa/native/*.{d2,mmd}` (2 per kind, 14 files), `test/qa-engines.test.ts`.
- **Approach:** `drawCase` passes `--engine <e> --svg --geometry-json --force`, loads `dist/engines/neutral.js`, applies `rulesSkipped`; report gains `engine`, `layout`, `rules_skipped`; native corpus is a render-success + overlap/bounds suite (`suites[]` row `native-<e>`); excalidraw path output is byte-identical to the post-round-4 baseline (asserted by diffing `out/qa/report.json`).
- **Acceptance:** `node scripts/qa.mjs --engine d2` (elk) and `--engine mermaid` complete on the full corpus in < 10 min with `--jobs 4` (D2 WASM is in-process: one worker per job process, cold start paid once per worker); `node scripts/fuzz.mjs --engine d2 --seed 3 --count 60` writes `out/fuzz-d2-s3/report.json`; held-out protocol documented in the script header.

### U9. Dashboard engine rounds

- **Goal:** one round per engine and a comparison row, kit rules respected.
- **Requirements:** R10.
- **Files:** `dashboard/kit.config.json` (rounds `round-5-excalidraw|d2|mermaid`, optional `engine` field), `dashboard/scripts/lib/*`, `dashboard/src/**` (comparison row shows engine; svg thumbnails allowed beside png), `dashboard/README.md`.
- **Acceptance:** `npm run check` in `dashboard/` green with the three rounds configured against `out/review-r5-<engine>/`; files < 500 lines; astro only via npm scripts; `round-4` (layout) is untouched.

### U10. QA rounds and vision review (Opus-run, Sonnet fix agents)

- **Goal:** the measured verdict per engine.
- **Requirements:** R9.
- **Protocol:** per engine: `qa --engine` + `fuzz --engine --seed 1,2` -> fix agents (translator/options only; D2 and Mermaid layout are not ours: fixes are translation choices, ELK spacing options, `--layout dagre|tala` comparison, label shortening) -> measure seeds 3-4 -> `--png` all curated + 40-sample -> vision agents V1-V10 in packets of 12 -> `all-verdicts.json` -> dashboard round -> user spot-check. A one-off `--layout tala` curated run is recorded for information (not gated). Numbers appended to this file's Results with the commit hash and seed. Routing thresholds (KTD4) tuned once from these results.
- **Acceptance:** R9 bars met per engine, or the engine is marked `experimental` in `engines` output and SKILL.md with the measured numbers (not silently shipped).

### U11. Release gate (orchestrator)

- `package.json` (`@d2lang/d2` dependency, mermaid devDeps, scripts `build:mermaid`, `qa:d2`, `qa:mermaid`), `NOTICE` (KTD9), `.github/workflows/ci.yml` (cache + optional `engines install d2` step using the committed sha, `npm run build`, `npm test`, `skill:check`, `axi-axi validate "node bin/diagram-axi.js"`, matrix windows/macos/linux for the WASM load), token tests, final `npm test` on main.
- **Done (release-gate agent):** NOTICE gained KTD9 entries 3-8 (D2 v0.9.0, `@d2lang/d2` 0.1.34, Source Sans/Code Pro, mermaid 12.2.0, `@mermaid-js/layout-elk` 1.0.1, elkjs 0.9.3 EPL-2.0), checked against the licence fields and files in `node_modules`. Scripts `qa:d2` and `qa:mermaid` added (no dependency or lockfile change). CI now runs build, test, `skill:check` on ubuntu/windows/macos, `axi-axi validate` on ubuntu, and a non-blocking, cached `engines install d2` step (sha256 from `src/engines/d2/release.json`).
- **Licence check:** the d2 v0.9.0 windows-amd64 tarball (sha256 matches `release.json`) holds `LICENSE.txt` (MPL-2.0, Terrastruct Inc.) and `THIRD_PARTY_NOTICES.txt`; neither mentions TALA. `@d2lang/d2` 0.1.34 ships MPL-2.0 `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` (Dagro, Rough-go, Go image, go-text, Noto Color Emoji OFL). `--layout tala` runs in the WASM package without the binary. README now says this and states that the licence status of every component inside the binary or WASM, TALA included, is unverified.
- **`axi-axi validate` (local, Windows):** 11 pass, 0 fail, 1 warn (V12). V12 is an axi-axi artefact: it runs `spawnSync("npm", ...)` without a shell, which fails with ENOENT on Windows; `npm run skill:check` itself passes. Expected to pass on ubuntu CI.
- **`npm audit`:** 2 low (`katex` 0.11.0-0.18.1 prototype pollution, GHSA-238p-pmpm-9mq7, reached through `@mermaid-js/layout-elk` -> `mermaid`; both are devDependencies, bundled into the render page only and fed our own diagram text). The only offered fix (`audit fix --force`) downgrades `@mermaid-js/layout-elk` to 0.2.3, so it is not applied; revisit when mermaid bumps katex.

---

## Parallelization map

- Wave 0 (now, in parallel with round 4): U1 (types + neutral committed first, then adapter/fetch); U4, U5, U9 start immediately (U4 compiles against U1's committed `types.ts`; until then against a local copy deleted before merge). None of these touches a file round 4 or 6203df5 changes.
- Predecessor track (orchestrator, concurrent with wave 0): round 4 merge -> held-out seeds 3/4 -> vision re-review -> dashboard `round-4` -> cherry-pick 6203df5 -> deferred rename items -> new excalidraw QA baseline.
- Wave 1 (after U1's types/neutral commit, ~same day): U2, U3 in parallel worktrees (each installs its npm deps locally; orchestrator adds them to `package.json` at merge); U4, U5, U9 continue.
- Wave 2 (after predecessor track + U1-U5 merged): U6 alone (integration owner); U8 harness code starts in parallel against U6's branch for the flag contract (`draw --engine <e> --svg --geometry-json --force`).
- Wave 3 (after U6): U7 (docs) and U8 (final wiring) in parallel; then U10 per engine in parallel (three vision review streams), U9 rounds filled.
- Wave 4: U11; repo folder rename only when no worktrees remain.

Peak parallelism: 6 agents (round 4, U1, U4, U5, U9, then U2/U3 replace U1/U4). Merge order: round 4 -> 6203df5 -> U1 -> U4 -> U5 -> U2 -> U3 -> U6 -> U9 -> U7 -> U8 -> U11; every merge via the worktree procedure with `npm test`.

---

## Verification Contract

- `npm test` (pretest builds `dist/`, the renderer and the mermaid bundle) green after every merge; browser/binary tests auto-skip locally when missing and run in CI; WASM tests always run.
- `npm run skill:check`, `npx -y axi-axi validate "node bin/diagram-axi.js" --dir .` pass.
- Token budgets: `test/guide.test.ts` (slices, home, SKILL.md) and `test/token.test.ts` unchanged ratios.
- Regression: `node scripts/qa.mjs` (excalidraw) report identical to the post-round-4 baseline except the new `engine`/`layout` fields.
- Per engine: `node scripts/qa.mjs --engine <e>` curated >= 99 %, `node scripts/fuzz.mjs --engine <e> --seed 3|4` >= 90 % overall and per profile, vision verdicts in the dashboard, user sign-off; native suite 100 % render success.
- Determinism: two runs of `draw --engine d2|mermaid` on the same input produce identical `.d2/.mmd` and identical SVG (D2 WASM verified deterministic for a fixed version; Mermaid with the fixed bundle, `deterministicIds`, `handDrawnSeed` and embedded font; gitGraph excluded and documented).
- Licence: `NOTICE` lists D2 (MPL-2.0), Source Sans/Code Pro (OFL), mermaid/layout-elk (MIT), elkjs (EPL-2.0); `node_modules/@d2lang/d2` ships its LICENSE and THIRD_PARTY_NOTICES.

---

## Definition of Done

- Global: R1-R11 true on main; the three engines appear in `engines`, SKILL.md and README with their measured QA numbers; no `excalidraw-cli-axi`/`exd-axi`/`dgm` strings remain; no bake-off or spike code left in `src/` or `scripts/` (`out/bakeoff`, `out/research` are git-ignored references); `docs/plans/<this file>` Results section filled per round.
- Per unit: files owned only; acceptance met; tests added; merged via worktree commit + cherry-pick + `npm test`; worktree removed only after the main commit is verified and `node_modules` is not a junction.

---

## Risks

- `@d2lang/d2` footprint (~96 MB in `node_modules`, 1.3 s cold start per process): acceptable for an agent tool (see Q4); `home`/`engines` never load it; QA workers pay the cold start once each.
- D2 diagram JSON or error-range format changes between versions: exact pin + fixture-driven adapter tests; SVG-class parsing (`<g class="base64(id)">`) is the documented fallback.
- TALA: 3-30x slower than elk (95-1600 ms warm) and only MPL-licensed since v0.9.0 (tarball LICENSE.txt is MPL-2.0; whole-binary status noted as unverified in the research): offered via `--layout tala`, not the QA default; verify LICENSE.txt in U11.
- Mermaid geometry is font-dependent: embedded font family forced in `initialize`; the determinism test runs in CI on three OSes. gitGraph auto-ids vary: slices teach explicit `id:`.
- Mermaid IIFE size (~6 MB) and ELK load: one page per process, measured in U3 (0.28 s load, 10-60 ms warm renders).
- Windows: GitHub download + `tar` + antivirus scanning of `d2.exe` (first run slow): binary is optional; `engines install` prints the path and sha; `--d2-path` for corporate machines.
- Shared-file collisions with round 4 and the rename: wave 0 is new-files-only; `src/quality/hints.ts` is never edited by engine units (engine hints live in `src/engines/<e>/hints.ts`); U6 waits for both merges.
- Two translators drift from the parser: translators consume `Graph` (AST) only; `test/dsl.test.ts` changes trigger golden updates.
- Vision cost: three engines x (272 + 40) PNGs; packets of 12, Sonnet vision agents, same checklist; the orchestrator runs them in parallel.
- Thresholds in KTD4 are planner estimates until the D2/Mermaid vision rounds land.

## Open Questions (user)

- None open. Q4 answered 2026-10-23: `@d2lang/d2` is a hard runtime dependency. Q5 answered 2026-10-23: D2 PNG default = Chrome screenshot of the WASM SVG; native binary stays opt-in.

---

## Appendix A. Phase 2 `extract` (interfaces only; v1 scope fixed by the user)

- v1 scope: `extract imports <dir>` for TS/JS static import graphs via `oxc-parser` (`parseSync` -> `module.staticImports/staticExports/dynamicImports`, byte offsets -> lines, `isType` for type-only edges) + `oxc-resolver` (tsconfig `paths`, `extensionAlias {".js":[".ts",".js"]}`, `exports` maps); measured on this repo: 57 files, 181 internal + 20 external edges, 0 unresolved, 24 ms. `dependency-cruiser` is an optional adapter (`--via depcruise`, working config in the research), never the default (its directory argument and `--include-only` silently produced 0 modules/edges on Windows). Python, call graphs, schema -> ERD, OTLP -> sequence are later phases (research sections 3.2-3.9).
- Command sketch: `diagram-axi extract imports <dir> [--via oxc|depcruise] [--focus <path>] [--depth N] [--dir in|out|both] [--max-nodes 25] [--group dir|none] [--include/--exclude <glob>] [--externals hide|count|show] [--types] [--tests] [--hubs hide|show] [--expand <id>] [--engine d2|excalidraw|mermaid|auto] [--out imports.exd] [--format exd|json|d2|mmd]`, plus `extract open <x.exd> <id>` (sidecar lookup, prints `path:line-endLine` + code) and `extract check <x.exd>` (drift vs rev / content hashes) and `extract doctor`. Exit non-zero only on extraction failure; large graphs are cut, never rejected; `unresolved: N` is always printed.
- Interface: `src/extract/types.ts` `Extractor { name; version; discover(root, opts): Promise<RawGraph> }`; normalized graph JSON (`schema: 1`, `meta{repo{url,rev,dirty,linkMode},extractor{name,version,confidence},root,langs,stats}`, `nodes[{id,kind,label,parent,lang,path,span,attrs}]`, `edges[{from,to,kind:"import",weight,typeOnly,dynamic,lazy,confidence,evidence[{path,line}]}]`); ids are repo-relative paths, externals `ext:<pkg>`; `src/extract/aggregate.ts` (filters, containment cut to <= 25 nodes by `subtreeSize * (1 + weightedDegree)`, edge roll-up with `x<n>` labels, hub suppression above the 90th percentile with `used by N`, `--focus` BFS) -> `src/extract/to-exd.ts` -> existing `.exd` pipeline and router (large graphs route to d2); sidecar `x.exd.map.json` (`id -> {path, span, deps}` + `meta.repository` pinned archify-style). Golden for v1: this repo -> 12 dir nodes / 23 dir edges. Read `docs/research/2026-10-23-extract.md` before planning Phase 2.

## Results

(filled by U10 per engine: commit, seed, layout, curated %, fuzz % per profile, vision pass %, dashboard round id)

### excalidraw (dagre + router), round 5 — PASSED (user sign-off on the bar, 2026-10-24)

- Commit `c604dd7` (layout round 5). Dashboard round `round-5-excalidraw` (`out/review-r5-excalidraw`).
- Checker: curated 352/352 HARD-clean; held-out fuzz gated s3 99.6%, s4 99.8% (0 cli failures); dev seeds s1/s2 99.8/99.7%.
- Vision (392 renders, 6 Sonnet reviewers, V1–V10): 89.5% overall; **91.4% gated** (351/384), excluding the 8 renders of the report-only profiles `dense`/`stress-60` — same rule as fuzz gating (user decision). Realistic 98.0%, edge 96.5%, fuzz repros 87.5%, held-out sample 42.5% (17/32 gated).
- Round history (overall vision): r3 81.6% · r4 84.4% · r5 89.5%. Blind paired A/B r3 vs r4 on the held-out 40: r4 better 30, r3 4, same 6.
- Known weakness: large random graphs (bundled parallel edges, hub fan-ins, labels in dense areas); the router (KTD4) sends dense graphs to d2.

Sign-off 2026-10-24 (session 6): user signed off d2 and mermaid as is. Release bar = >= 90% on the overall gated score; held-out profiles below 90% are known limitations, not blockers. No mermaid round 3. Final gate at `8f11dfc`: npm test 1536 pass / 6 skipped; validate 11 pass, V12 warn (accepted).

### d2 (elk + lane spreading), round 5 — PASSED (user sign-off 2026-10-24)

- Commit `851b256` (d2 rounds 1+2; checker `1cdb800` does not change d2). Dashboard data `out/review-r5-d2`.
- Checker: curated 98.9% (354/358); held-out fuzz gated s3 93.3%, s4 94.4%; dev s1/s2 93.9/93.5%. Weakest gated profile multi-edge ~70%.
- Vision (398 renders, 6 Sonnet reviewers, V1–V10): 97.0% overall, **97.9% gated** (382/390). Realistic 98.0, edge 96.5, repros 100, native 100, held-out gated 100 (32/32).

### mermaid (elk), round 5 — PASSED (user sign-off 2026-10-24, shipped as is)

- Commit `7a4e5ba` (mermaid rounds 1+2, headWidth 8 -> crowded limit 14). Dashboard data `out/review-r5-mermaid`.
- Checker: curated 96.7% (348/360); held-out fuzz gated s3 91.3%, s4 90.0%; dev s1 92.4%. Below the 90% profile bar on held-out: realistic-medium 81-83, multi-edge 81-85, groups-nested 75-83.
- Vision (400 renders, 6 Sonnet reviewers, V1–V10): 94.8% overall, **95.7% gated** (375/392); 95.2% if the two `edge-self-loop-in-group` label-straddles-zone renders (reviewer called cosmetic) count as rejects. Realistic 92.0, edge 96.5, repros 96.3, native 100, held-out gated 100 (32/32), report-only 4/8. Rejects: mid-word node-label wrap (`day-k8s-deployment` "PersistentVolum/e", `day-ml-training-pipeline` "hyperparameter/s", all 4 dirs; checker misses it -> node width a few px short), `edge-whitespace-labels` leading-newline label on the node border (4 dirs), zone title crossed (`edge-five-sibling-groups-DOWN`, `edge-group-title-wider-than-content-UP`), self-loop label straddling zone border (`fuzz-arrows-collinear-overlap-81bedb05` DOWN/UP), line through a multi-line edge label (`fuzz-label-outside-zone-1df39a5c-RIGHT`). Known issues, shipped unfixed: mid-word node-label wrap, leading-newline label, possibly `edge-title-multiline-*` titles flattened to one line (unverified).

### d2, mermaid — pending (U8 checker baseline at `a1ab68d`, before vision)

- d2 elk curated 74.6% (top HARD zone-title-crossed, label-on-foreign-arrow); fuzz s3 count 60 gated 48.9%.
- mermaid elk curated 45.8% (arrows-collinear-overlap, arrowheads-crowded, parallel-edges-close; verify adapter measurement first); fuzz s3 count 60 gated 20.3%.
