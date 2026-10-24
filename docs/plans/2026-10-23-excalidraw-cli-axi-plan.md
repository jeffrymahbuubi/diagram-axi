---
title: excalidraw-cli-axi - Plan
type: feat
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# excalidraw-cli-axi - Plan

> **Renamed 2026-10-23:** the project was renamed from `excalidraw-cli-axi` to `diagram-axi` (bins `diagram-axi` and `dg-axi`; env `DIAGRAM_AXI_BROWSER_PATH`). The text below is the original plan and keeps the old name for history.

## Goal Capsule

- **Objective:** An AI agent working in a terminal can turn a ~20-line text description of boxes and arrows into an editable `.excalidraw` file plus PNG and SVG renders, fully offline, with no Excalidraw account, in one command whose output costs the agent a few hundred tokens.
- **Means:** An AXI-compliant TypeScript CLI (scaffolded by `axi-axi`) with its own DSL parser, dagre auto-layout, a Node-side scene builder that emits full Excalidraw elements, and a headless-browser renderer modeled on `@excalidraw/cli` (KTD1-KTD5).
- **Authority:** User decisions in the brief (input DSL + auto layout, three local outputs, TS + axi-axi scaffold + own renderer, Sonnet implementer units) > this plan > AXI spec (`axi-axi principles`) > implementer judgment.
- **Stop conditions:** Stop and report if `@excalidraw/utils@0.1.7`'s `exportScene` cannot be driven from the virtual-origin page (U5 spike fails), if dagre compound layout produces overlapping groups on the fixture set (U3), or if `axi-axi validate` reports a `fail` that needs a scaffold change rather than a command change.
- **Execution profile:** Opus orchestrator reviews this plan; user approves; Sonnet implementer agents execute U1-U8 in the order given, one agent per unit, non-overlapping file ownership; orchestrator owns `package.json`, `src/index.ts` merges, and the final U8 gate.

---

## Product Contract

### Summary

`excalidraw-cli-axi` is a token-efficient CLI for AI agents. The agent writes a compact nodes-and-edges DSL (file or stdin); the tool parses it, measures labels, lays the graph out with dagre, builds real Excalidraw elements (rounded rectangles, ellipses, diamonds, cylinders, zones, bound labels, bound arrows), writes an editable `.excalidraw` file, and renders PNG/SVG in an already-installed Chrome or Edge via `playwright-core`. All commands speak TOON on stdout, exit 0/1/2, never prompt, and end with `help[]` next steps.

### Problem Frame

Today an agent that wants a hand-drawn diagram either loads the Excalidraw MCP's ~2.5k-token cheat sheet and hand-places every element in absolute coordinates (fragile layout, ~1.5k tokens per small diagram), or shells out to `@excalidraw/cli`, which renders but requires a prebuilt scene and an API key for everything else. Neither gives an agent a cheap, local, layout-free path from intent to file.

### Key Decisions

- **Input is a DSL, layout is automatic.** Governs R1-R4. (user)
- **Outputs are `.excalidraw`, PNG, SVG, all local; no share-link in v1.** Governs R5-R7. (user)
- **Own renderer modeled on `@excalidraw/cli`, not a wrapper.** Governs R6, KTD3. (user)
- **Scaffold with `npx -y axi-axi new`, gate with `axi-axi validate`.** Governs R8-R12. (user)
- **Hand-build full elements in Node rather than run `convertToExcalidrawElements` in the browser.** Governs R5, KTD4. (planner; rationale in KTD4)

### Requirements

- R1. `draw <file|->` accepts the DSL (section "DSL") from a file or stdin and writes `<out>.excalidraw`; `--png` / `--svg` add renders; `--out <path-without-ext>` names them; `--direction DOWN|RIGHT|UP|LEFT` (default `DOWN`) sets the layout rank direction unless the DSL sets one.
- R2. Layout is computed automatically; node sizes derive from measured label text (min 120x60, padding 16/12), edges route along dagre waypoints, groups become zone rectangles that enclose their children with 24 px padding.
- R3. Parse errors name `line:col`, the offending token, what was expected, and one suggestion; the command exits 1 and writes nothing.
- R4. Undeclared ids used in edges become nodes labelled with the id; `check` reports them as warnings.
- R5. The `.excalidraw` file opens cleanly in excalidraw.com (v2 schema, fractional `index`, bound text via `containerId`/`boundElements`, arrows with `startBinding`/`endBinding`) and is byte-deterministic for the same input (seeded `seed`/`versionNonce`, fixed `updated`).
- R6. `render <scene.excalidraw> --png|--svg [--scale] [--padding] [--theme] [--transparent] [--timeout]` renders with an installed Chrome/Edge/Chromium/Firefox found by `--browser-path`, `EXCALIDRAW_AXI_BROWSER_PATH`, or discovery; no browser is ever downloaded; no browser found exits 1 with a suggestion naming the flag and env var.
- R7. Fonts ship in the package (Excalifont, Virgil, Cascadia, Nunito, Lilita, Comic Shanns, Liberation); CJK (Xiaolai) is fetched from a mirror only when a scene uses CJK glyphs and `--fonts-url` is not `none`; rendering never otherwise touches the network.
- R8. No-args home view shows live content: scenes found under cwd (`**/*.excalidraw`, max 10, with element counts), a 3-line DSL teaser, and `help[]`; never a usage dump.
- R9. Every command answers `--help` with flags, defaults, and 2-3 examples; unknown flag exits 2 listing valid flags.
- R10. `inspect <scene|dsl>` prints aggregates (nodes, edges, groups, shapes histogram, bounds, fonts used, unresolved refs) without rendering; `check <dsl>` lints (duplicate ids, dangling edges, empty labels, unknown colors, >60 nodes) and exits 1 on errors, 0 on warnings only.
- R11. `syntax [topic]` serves token-tuned DSL reference slices (`nodes`, `edges`, `groups`, `style`, `example`, each <= 350 tokens); no-topic prints the index.
- R12. `skills/excalidraw-cli-axi/SKILL.md` is generated from `src/skill/content.ts` and `npm run skill:check` keeps it fresh; `npx -y axi-axi validate "node bin/excalidraw-cli-axi.js" --dir .` reports zero `fail`.

### Scope Boundaries

- In: the four shapes + cylinder composite, zones, edge labels/styles, palette colors, DOWN/RIGHT/UP/LEFT, PNG/SVG/.excalidraw, inspect/check/syntax, SKILL.md.
- Out of v1 (future work, section "Future Work"): share links/upload, editing an existing scene by id, SessionStart hook installer, images, free text annotations, manual coordinates, elk layout, Node-only SVG without a browser, sequence diagrams.

### Acceptance Examples

- AE1. Covers R1, R2, R5. Given `test/fixtures/arch.exd` (7 nodes, 7 edges, 1 group — corrected after U2 parse), `draw test/fixtures/arch.exd --out out/arch` writes `out/arch.excalidraw` identical to `test/golden/arch.excalidraw` and prints the success TOON shown in "Command surface".
- AE2. Covers R3. Given a file whose line 4 is `api[API -> db`, `draw` exits 1 with `error: line 4, col 9: expected ']' to close label, found '->'` and `suggestion: close the label: api[API] -> db`.
- AE3. Covers R6. With `EXCALIDRAW_AXI_BROWSER_PATH=/nonexistent`, `render x.excalidraw --png` exits 1 and the error names `--browser-path`.
- AE4. Covers R10. `check` on a DSL with `a -> b` and `b` never declared exits 0 and lists `warnings[1]{line,col,code,message}` with code `implicit-node`.
- AE5. Covers R8. In an empty directory, no-args prints `scenes: 0 .excalidraw files found under .` followed by the DSL teaser and `help[]`, exit 0.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Layout engine: `@dagrejs/dagre@3.1.1`** (dep `@dagrejs/graphlib@4.0.5`, ~1.4 MB unpacked, synchronous, pure JS). Rejected `elkjs@0.12.0`: ~8 MB unpacked GWT bundle, async/worker API, slower cold start; its superior orthogonal routing and nested-compound quality are not needed for <=60-node agent diagrams. Dagre's `compound: true` graphs give cluster boxes for groups. Risk accepted: dagre draws edges between clusters poorly when nesting exceeds one level; `check` warns on nesting depth > 2. Keep `src/layout/engine.ts` as an interface so an `--engine elk` can be added later.
- KTD2. **Node sizing from static Excalifont metrics.** `scripts/build-font-metrics.mjs` (devDependency `opentype.js@2.0.0`) reads `Excalifont.ttf` and `CascadiaCode` from the `@excalidraw/utils` tarball's `dist/prod/assets/` at build time and writes `src/layout/metrics/*.json` (per-codepoint advance widths for U+0020-U+024F, `unitsPerEm`, average fallback). Width = sum(advances) x fontSize / unitsPerEm; line height = 1.25 x fontSize (Excalidraw's Excalifont metric). This keeps `draw`, `inspect`, and `check` browser-free and deterministic. Excalidraw re-measures on load; drift of a few px is tolerated because labels are centered and containers have padding.
- KTD3. **Renderer = `@excalidraw/cli` design on `@excalidraw/utils@0.1.7`.** Verified: the 0.1.7 prod bundle exports `exportScene({data, type: "png"|"svg"|"canvas"|"jpeg", config})` (not 0.1.5's `exportToCanvas`), inlines 231 woff2 data URLs and 2 wasm blobs. `scripts/build-renderer.mjs` is a port of the official script: strip fonts into `dist/fonts/<sha256>.woff2` and rewrite URLs to `http://excalidraw-renderer.local/fonts/...`, mark Xiaolai as remote, subtract Xiaolai unicode ranges already covered by Excalifont, **keep** the 2 wasm modules (needed to subset-embed fonts in SVG so SVG output is self-contained), and `expect()` counts so a bundle layout change fails the build loudly. `src/render/render.ts` launches the found browser with `playwright-core@1.64.1`, routes everything to in-memory responses, calls `exportScene` twice (png, svg) in one page when both are requested, and enforces a single deadline (`--timeout`, default 30000 ms, fonts get half). MIT attribution for `excalidraw/cli` goes in `NOTICE` and the README.
- KTD4. **Full elements are built in Node, not via `convertToExcalidrawElements`.** The utils bundle does not export it (only `@excalidraw/excalidraw` does, which needs React + DOM, ~30 deps). We already know node boxes, label text, and arrow endpoints from layout, so `src/scene/elements.ts` emits complete elements: base fields (`angle 0, strokeColor #1e1e1e, backgroundColor, fillStyle solid, strokeWidth 2, strokeStyle, roughness 1, opacity, groupIds, frameId null, roundness {type:3} for rects / null otherwise, seed, version 1, versionNonce, index, isDeleted false, boundElements, updated 1, link null, locked false`), text (`fontFamily 5` Excalifont, `fontSize 20`, `textAlign center`, `verticalAlign middle`, `containerId`, `originalText`, `autoResize true`, `lineHeight 1.25`), arrows (`points` from dagre waypoints relative to `x,y`, `startBinding/endBinding {elementId, focus 0, gap 4, fixedPoint}`, `startArrowhead null`, `endArrowhead "arrow"`, `elbowed false`, `lastCommittedPoint null`). Fractional indices come from a ~40-line port of `generateKeyBetween` ("a0".."az","b00"...). Determinism: `seed` and `versionNonce` = FNV-1a of `id`.
- KTD5. **Palette and defaults from the MCP cheat sheet.** Node fills: blue `#a5d8ff`, green `#b2f2bb`, orange `#ffd8a8`, purple `#d0bfff`, red `#ffc9c9`, yellow `#fff3bf`, teal `#c3fae8`, pink `#eebefa`; uncolored nodes default to light blue `#a5d8ff` (user decision, see Open Questions); cylinders default to teal. Zone fills: blue `#dbe4ff`, purple `#e5dbff`, green `#d3f9d8` at `opacity 30`, stroke `#868e96`, `strokeWidth 1`. Stroke `#1e1e1e`, canvas `#ffffff`, `fontSize 20` nodes, `16` edge labels, `16` zone titles.
- KTD6. **Groups are zone rectangles + title text sharing a `groupIds` entry with their children**, not Excalidraw `frame` elements. Frames cannot carry a fill (palette zones need one) and clip content; a grouped rectangle keeps the editor behaviour (move together) and the pastel-zone look. Frames are a future opt-in (`group ... frame`).
- KTD7. **Zero runtime deps beyond `@dagrejs/dagre` and `playwright-core`.** Parser, TOON, args, errors come from the scaffold's hand-rolled modules; no zod/commander. `@excalidraw/utils`, `esbuild`, `opentype.js`, `vitest`, `typescript` are devDependencies; the renderer bundle and fonts are build artefacts shipped in `dist/`.

### High-Level Technical Design

```
stdin/file ─> dsl/lexer ─> dsl/parser ─> ast (Graph) ─> layout/measure ─> layout/dagre ─> scene/build ─> serialize ─> .excalidraw
                                                 │                                                   │
                                           check/inspect                               render/render (browser) ─> .png/.svg
```

Pipeline modules are pure functions over plain objects; commands are thin adapters that validate flags, call the pipeline, and emit TOON. `render` consumes a scene object, so `draw --png` and `render x.excalidraw --png` share one path.

### DSL ("exd")

File extension `.exd`; `#` comments; blank lines ignored; one statement per line; `;` optional. Grammar (EBNF, informal):

```
file      = { line } ;
line      = directive | node | edge | group ;
directive = ("direction" | "dir") ":"? DIR | "title" ":"? STRING ;
DIR       = "DOWN" | "RIGHT" | "UP" | "LEFT" ;
node      = ID shape [ style ] ;
shape     = "[" TEXT "]"            (* rounded rectangle *)
          | "(" TEXT ")"            (* ellipse *)
          | "{" TEXT "}"            (* diamond *)
          | "[(" TEXT ")]" ;        (* cylinder / database *)
edge      = ref { arrow ref } [ ":" TEXT ] ;
ref       = ID [ shape ] | ID { "," ID } ;            (* fan-out: a -> b, c *)
arrow     = "->" | "-->" | "--" | "<->" | "-.->" ;   (* solid, dashed, line, both heads, dotted *)
group     = "group" ID [ STRING ] [ style ] "{" { line } "}" ;
style     = ":" COLOR { "," FLAG } ;                   (* :blue  :teal,dashed *)
COLOR     = blue|green|orange|purple|red|yellow|teal|pink ;
FLAG      = dashed | dotted | bold | sketchy ;
ID        = [A-Za-z_][A-Za-z0-9_-]* ;  TEXT = chars until the closing bracket, "\n" = line break ;
```

Example (`test/fixtures/arch.exd`):

```
dir RIGHT
title "Order pipeline"
group edge "Edge" :blue {
  web[Web app]
  mobile[Mobile app]
}
api[API Gateway] :purple
web, mobile -> api : HTTPS
api -> auth{Auth?} : JWT
auth --> api : 401
api -> orders[Order svc] -> db[(Orders DB)]
api -.-> cache[(Redis)] : read-through
```

Semantics: first shape mention declares the node; later bare `id` references reuse it; redeclaring with a different label is error `duplicate-node`; `direction` in the DSL overrides `--direction`; edge labels are bound text on the arrow; `bold` = `strokeWidth 4`, `sketchy` = `roughness 2`.

### Command surface and TOON contract

| Command | Purpose | Key flags |
|---|---|---|
| (no args) | home: scenes under cwd + DSL teaser | `--version` |
| `draw <file\|->` | DSL -> `.excalidraw` [+png/svg] | `--out`, `--png`, `--svg`, `--direction`, `--scale`, `--theme`, `--transparent`, `--padding`, `--timeout`, `--browser-path`, `--fonts-url`, `--force` |
| `render <scene>` | `.excalidraw` -> png/svg | `--png`, `--svg`, `--out`, `--scale`, `--theme`, `--transparent`, `--padding`, `--timeout`, `--browser-path`, `--fonts-url` |
| `inspect <scene\|dsl>` | aggregates, no render | `--fields`, `--full` |
| `check <dsl>` | lint with line:col | `--strict` (warnings exit 1) |
| `syntax [topic]` | DSL reference slices | — |

Success (`draw ... --png --svg`):

```
draw: ok
outputs[3]{kind,path,bytes}:
  excalidraw,out/arch.excalidraw,6120
  png,out/arch.png,41230
  svg,out/arch.svg,18877
scene: 8 nodes, 8 edges, 1 group, 1180x520 px, direction RIGHT, browser msedge
warnings[1]{line,col,code,message}:
  11,12,implicit-node,"'cache' used before declaration; labelled with its id"
help[3]:
  excalidraw-cli-axi render out/arch.excalidraw --png --scale 2
  excalidraw-cli-axi inspect out/arch.excalidraw
  excalidraw-cli-axi syntax style
```

Empty state (`inspect empty.exd`): `scene: 0 nodes, 0 edges in empty.exd` + `help[2]` (`syntax example`, `draw --help`). Parse error (exit 1):

```
error: line 4, col 9: expected ']' to close label, found '->'
suggestion: close the label: api[API] -> db
help[2]:
  excalidraw-cli-axi syntax nodes
  excalidraw-cli-axi check diagram.exd
```

Usage error (exit 2) is the scaffold's `error: unknown flag --x for 'draw'` + `suggestion: valid flags for 'draw': ...`. No browser (exit 1): `error: no Chrome, Chromium, Edge or Firefox found` + `suggestion: pass --browser-path <exe> or set EXCALIDRAW_AXI_BROWSER_PATH; the .excalidraw file was written` with `outputs[1]` listing it. Stderr stays silent on success; stack traces only on unexpected failures.

### Module layout (all files < 500 lines)

```
bin/excalidraw-cli-axi.js                 scaffold launcher
src/index.ts                              registry: commands + aliases (orchestrator-owned merges)
src/cli/{args,help,router,spec}.ts        scaffold, verbatim
src/output/{toon,errors,suggest,truncate}.ts  scaffold, verbatim
src/commands/{home,draw,render,inspect,check,syntax}.ts
src/dsl/{tokens,lexer,parser,ast,diagnostics}.ts
src/layout/{engine,dagre-layout,measure,metrics/excalifont.json,metrics/cascadia.json}.ts
src/scene/{palette,ids,elements,build,serialize,summary}.ts
src/render/{browser,fonts,page,render,outputs}.ts
src/skill/content.ts   src/guide/slices.ts
scripts/{gen-skill,build-renderer,embedded-fonts,build-font-metrics,token-compare}.mjs  scripts/fonts.json
test/{cli,dsl,layout,scene,render,token}.test.ts  test/fixtures/*.exd  test/golden/*.excalidraw
skills/excalidraw-cli-axi/SKILL.md  NOTICE  README.md
```

### Dependencies (pinned)

Runtime: `@dagrejs/dagre 3.1.1`, `playwright-core 1.64.1`. Dev: `@excalidraw/utils 0.1.7`, `esbuild 0.28.2`, `opentype.js 2.0.0`, `typescript ^5.6`, `vitest 5.0.5`, `@types/node ^22`, `axi-axi 0.1.0` (for `validate` in CI). Node `>=20` (dev machine: 24.19.0). Build: `tsc && node scripts/build-renderer.mjs && node scripts/build-font-metrics.mjs`. Package `files`: `bin`, `dist` (incl. `dist/renderer.js`, `dist/fonts/`), `skills`, `README.md`, `NOTICE`.

### Sequencing

U1 first (scaffold). U2, U3, U5 in parallel (independent inputs: AST types fixed in U1). U4 after U2+U3. U6 after U4+U5. U7 parallel with U6 after U1. U8 last.

---

## Implementation Units

### U1. Scaffold and CLI skeleton

- **Owner:** `cli-scaffold` · **Depends on:** none
- **Goal:** A buildable AXI scaffold with the real command registry stubbed and the shared AST/type contract other units code against.
- **Files:** everything `npx -y axi-axi new excalidraw-cli-axi --dir .` produces; `package.json` (deps above, scripts `build`, `test`, `test:render`, `skill:gen`, `skill:check`, `validate`), `tsconfig.json`, `src/index.ts`, `src/dsl/ast.ts` (Graph, Node, Edge, Group, Diagnostic types), `src/layout/engine.ts` (LayoutInput/LayoutResult interfaces), `src/render/outputs.ts` (RenderRequest/RenderResult types), `NOTICE`, `.gitignore` (`dist/`, `out/`, `.playwright-cli/`).
- **Approach:** Run the scaffold, delete `items.ts`, register stub modules for `draw render inspect check syntax` that throw `AxiError("not implemented")`, keep the scaffold's `cli/` and `output/` byte-identical. Write the shared type files from this plan's KTD4/DSL sections so U2-U5 compile against them.
- **Tests:** scaffold `test/cli.test.ts` passes; `npm run build` green; `node bin/... draw --help` exits 0.
- **Verification:** `npx -y axi-axi validate "node bin/excalidraw-cli-axi.js" --dir .` shows no `fail` (warns allowed at this stage).

### U2. DSL lexer and parser

- **Owner:** `parser` · **Depends on:** U1 (types)
- **Goal:** `parse(text, {file}) -> {graph, diagnostics}` implementing the grammar with line:col diagnostics.
- **Files:** `src/dsl/{tokens,lexer,parser,diagnostics}.ts`, `test/dsl.test.ts`, `test/fixtures/*.exd` (arch, pipeline, flow, nested-groups, errors/*.exd).
- **Approach:** Hand-written lexer (tokens: ID, STRING, TEXT-in-brackets, arrows, `:` style, `{ }`, `,`, NEWLINE) with positions; recursive-descent parser; implicit node declaration on first edge use (warning `implicit-node`); error recovery not required (first error stops, R3). Diagnostics carry `{line, col, code, message, suggestion}`; codes: `expected-token`, `duplicate-node`, `unknown-color`, `unknown-direction`, `implicit-node`, `empty-label`, `unclosed-group`.
- **Tests:** table-driven: each fixture parses to a snapshot AST; each `errors/*.exd` yields the expected code/line/col/suggestion; fan-out `a -> b, c` yields 2 edges; chains yield n-1 edges; `\n` in labels splits lines.
- **Verification:** `vitest run test/dsl.test.ts` green; parser files < 500 lines each.

### U3. Text metrics and dagre layout

- **Owner:** `layout` · **Depends on:** U1 (types)
- **Goal:** `layout(graph, {direction}) -> positioned nodes, edge waypoints, group boxes` with sizes from measured labels.
- **Files:** `scripts/build-font-metrics.mjs`, `src/layout/metrics/*.json`, `src/layout/{measure,dagre-layout}.ts`, `test/layout.test.ts`.
- **Approach:** KTD1 + KTD2. `measure(text, fontSize, family)` -> `{width, height, lines}`. Node box = max(120, textW + 32) x max(60, textH + 24); diamonds x1.6/x1.4, ellipses x1.3/x1.3, cylinder +0.25h cap. Dagre config: `rankdir` from direction, `nodesep 40`, `ranksep 60`, `edgesep 20`, `marginx/y 20`, `compound: true`, `setParent` for groups, edge `labelpos c` with measured label size so dagre reserves room. Output coordinates are top-left based (dagre gives centers).
- **Tests:** metrics JSON exists and `measure("API Gateway", 20)` is within 10 % of a hard-coded reference width; no two node boxes overlap on any fixture; every child lies inside its group box; `RIGHT` puts `web.x < api.x < db.x`; deterministic across two runs.
- **Verification:** `vitest run test/layout.test.ts`.

### U4. Scene builder and .excalidraw serializer

- **Owner:** `scene` · **Depends on:** U2, U3
- **Goal:** `buildScene(graph, layout, {title}) -> ExcalidrawScene` and `serialize(scene) -> string` producing deterministic, editor-valid files; `summarize(scene)` for inspect.
- **Files:** `src/scene/{palette,ids,elements,build,serialize,summary}.ts`, `test/scene.test.ts`, `test/golden/*.excalidraw`.
- **Approach:** KTD4-KTD6. Element order (z-order): zones, zone titles, nodes, node labels, arrows, arrow labels. Arrow endpoints clipped to shape boundary (rect edge midpoint of the side the first waypoint leaves; ellipse/diamond intersection), `fixedPoint` set accordingly; `boundElements` on containers list both their text and arrows. Cylinder = rectangle body + ellipse cap sharing a `groupIds` entry; bindings target the body. Title (if any) is a free `text` element above the content, fontSize 28. File: `{type:"excalidraw", version:2, source:"https://github.com/<owner>/excalidraw-cli-axi", elements, appState:{gridSize:20, viewBackgroundColor:"#ffffff"}, files:{}}`, 2-space JSON.
- **Tests:** golden-file equality for all fixtures (update via `UPDATE_GOLDEN=1`); schema checks: every `containerId` resolves and is mirrored in `boundElements`, every binding `elementId` exists, indices strictly increasing, all required fields present on every element; `summary()` counts match the AST.
- **Verification:** `vitest run test/scene.test.ts`; manual: open `test/golden/arch.excalidraw` in excalidraw.com once and record "opens, labels centered, arrows attached" in the PR.

### U5. Renderer bundle and browser driver

- **Owner:** `renderer` · **Depends on:** U1 (types) — spike first
- **Goal:** `renderScene(scene, {png, svg, ...opts}) -> {png?, svg?, width, height, browser, warning?}` using an installed browser, with fonts served locally.
- **Files:** `scripts/{build-renderer,embedded-fonts}.mjs`, `scripts/fonts.json`, `src/render/{browser,fonts,page,render}.ts`, `test/render.test.ts`.
- **Approach:** KTD3. Spike (first 1-2 hours): write `build-renderer.mjs` against `@excalidraw/utils@0.1.7`, regenerate `fonts.json` (sha256 -> family/path, adapting excalidraw-cli's `update-fonts.mjs` to the 0.1.7 asset layout), and prove in a throwaway script that `exportScene({data, type:"svg"})` and `type:"png"` run inside the routed page for `test/fixtures/render-smoke.excalidraw` (U5-owned, hand-written from `excalidraw-cli/test/render-fixture.ts`; U5 must not depend on U4's golden files — orchestrator review fix). Then port `browser.ts` (discovery incl. Windows `PROGRAMFILES`/`LOCALAPPDATA` paths, env `EXCALIDRAW_AXI_BROWSER_PATH`), `fonts.ts` (packaged -> cache `%LOCALAPPDATA%/excalidraw-cli-axi/fonts` -> mirrors, sha-verified, deadline-bounded), `page.ts` (serialized `page.evaluate` body: patch `document.fonts.load`, call `exportScene` for each requested type, return base64 png / svg string), `render.ts` (launch, route, deadline race, `describeLaunchError`). Output dimensions: `scale` default 1 capped by `maxWidth/maxHeight 2048` and 64 MP as in the official CLI.
- **Tests:** build asserts font count and 2 wasm modules; `test/render.test.ts` calls `findBrowser()` in `beforeAll` and `test.skip`s the suite with reason "no browser installed" when it throws; otherwise renders `render-smoke.excalidraw` to PNG (magic bytes, width > 0) and SVG (`<svg`, contains `Excalifont` `@font-face`), honours `--transparent`, and a 1 ms timeout rejects with the timeout message without leaving a browser process.
- **Verification:** `npm run test:render` green on the Windows dev box with Chrome and Edge; `npm test` green when `EXCALIDRAW_AXI_BROWSER_PATH=/nonexistent` (skips cleanly).

### U6. Commands: draw, render, inspect, check

- **Owner:** `commands` · **Depends on:** U4, U5
- **Goal:** The four pipeline commands with the exact TOON contract above.
- **Files:** `src/commands/{draw,render,inspect,check}.ts`, `test/commands.test.ts`, `src/index.ts` registry entries (coordinate with orchestrator).
- **Approach:** `draw`: read file or stdin (`-`), parse, on error print diagnostic + help and exit 1; layout; build; write `.excalidraw` (refuse to overwrite unless `--force`, exit 1); if `--png/--svg`, call `renderScene` once; on browser failure still report `outputs[]` and exit 1. `render`: validate the file (type/version/elements non-empty) then render. `inspect`: accept either extension; default fields `nodes,edges,groups,size`; `--fields` adds `shapes,fonts,colors,unresolved`; `--full` disables truncation of id lists (truncate at 800 chars with the scaffold helper). `check`: run parser + semantic lint, emit `errors[]`/`warnings[]` tables with `line,col,code,message`, exit code per R10. Every command ends with 2-3 parameterized `help[]` lines.
- **Tests:** spawn the built bin: AE1-AE5; stdin path; `--out` default = input basename; overwrite refusal; `--direction` override precedence; exit codes 0/1/2 for each command; stderr empty on success.
- **Verification:** `vitest run test/commands.test.ts`.

### U7. Home view, syntax slices, SKILL.md

- **Owner:** `docs-cli` · **Depends on:** U1 (U2's grammar as reference)
- **Goal:** Content-first home, token-tuned `syntax` command, generated SKILL.md.
- **Files:** `src/skill/content.ts`, `src/guide/slices.ts`, `src/commands/{home,syntax}.ts`, `skills/excalidraw-cli-axi/SKILL.md`, `README.md`, `test/guide.test.ts`.
- **Approach:** Home: scan cwd for `*.excalidraw` (ignore `node_modules`, `.git`, `dist`, depth <= 4, cap 10, 2 s budget), `scenes[N]{path,elements,modified}` or the definitive empty state, then `dsl-teaser[3]` and `help[3]`. `syntax` slices: `index`, `nodes`, `edges`, `groups`, `style`, `example`; a unit test enforces <= 350 tokens (chars/4) per slice. SKILL.md = home body with `npx -y excalidraw-cli-axi` command forms plus the `example` slice. README: usage, DSL summary, attribution to `excalidraw/cli` (MIT) and the Excalidraw MCP palette.
- **Tests:** slice budgets; home empty state text; `syntax bogus` exits 2 listing topics; `npm run skill:check` passes after `skill:gen`.
- **Verification:** `vitest run test/guide.test.ts`; `npm run skill:check`.

### U8. Compliance gate, token comparison, CI

- **Owner:** `qa-gate` (orchestrator may do this) · **Depends on:** U6, U7
- **Goal:** Ship-readiness evidence: AXI validation passes, token cost advantage measured, CI wired.
- **Files:** `scripts/token-compare.mjs`, `test/token.test.ts`, `.github/workflows/ci.yml`, `docs/plans/...` (append results section only).
- **Approach:** `token-compare.mjs` loads `test/fixtures/arch.exd` and a hand-written equivalent `test/fixtures/arch.mcp.json` (raw MCP elements for the same diagram, written in the cheat sheet's style), reports chars, chars/4 tokens, and whitespace-split tokens for: DSL input, DSL + `syntax example` slice, MCP JSON, MCP JSON + cheat sheet (~9.5k chars from `excalidraw-mcp/src/server.ts`). Test asserts DSL+slice <= 1/4 of MCP+cheat-sheet and DSL <= 1/5 of MCP JSON. CI: `npm ci`, `npm run build`, `npm test`, `npm run skill:check`, `npx -y axi-axi validate "node bin/excalidraw-cli-axi.js" --dir .` with `fail` -> non-zero; render tests run only on a job with `ubuntu-latest` Chrome (`browser-actions/setup-chrome`) and are skipped elsewhere.
- **Tests:** the ratio test; validate exit 0.
- **Verification:** validate report attached to the PR with all 12 checks `pass` or `warn` (none `fail`, V08 stderr silence `pass`).

---

## Verification Contract

- `npm run build` — tsc + renderer bundle + font metrics; fails if the utils bundle layout changed (`expect()` counts).
- `npm test` — vitest: `cli`, `dsl`, `layout`, `scene` (golden), `commands`, `guide`, `token`; `render` auto-skips without a browser.
- `npm run test:render` — render suite, required on the Windows dev box (Chrome + Edge present) before merge.
- `npm run skill:check` — SKILL.md freshness.
- `npx -y axi-axi validate "node bin/excalidraw-cli-axi.js" --dir .` — zero `fail`.
- Manual once per release: open `test/golden/arch.excalidraw` in excalidraw.com; labels centered, arrows bound (drag a node, arrow follows).
- Performance target: `draw arch.exd` without render < 400 ms; with `--png --svg` < 3 s warm on the dev box.

## Definition of Done

- Global: all Verification Contract items green; every file < 500 lines; no runtime deps beyond KTD7; `NOTICE` credits `excalidraw/cli` (MIT); no abandoned spike code in `src/` or `scripts/`; nothing written to the project root except the scaffold's standard files; no commit without the user's go-ahead.
- Per unit: its tests pass, its files are the only ones it changed (except `src/index.ts` registrations merged by the orchestrator), and its acceptance line in the unit body holds.

---

## Risks and Open Questions

Risks:
- `@excalidraw/utils` 0.1.x API churn (0.1.5 -> 0.1.7 renamed the export entry): pin exactly, guard with `expect()` in the build, keep the page body tiny.
- Dagre compound edges between clusters can cross zone borders awkwardly; mitigated by warning on nesting > 2 and `ranksep 60`.
- Static text metrics vs. editor re-measure: mitigated by padding and centering; `check` warns on labels > 40 chars per line.
- Windows path/exec quirks in `findBrowser` (`X_OK` on `.exe`): test on the dev box in U5.
- Xiaolai download on CJK text is network access on a tool advertised as local: documented, `--fonts-url none` disables it.

Open questions — RESOLVED by the user 2026-10-23 (these override KTD5 and any earlier default in this plan):
1. Bin name: ship both `excalidraw-cli-axi` and the short alias `exd-axi` in `package.json` `bin` (same entry file). help[] lines may use `exd-axi`.
2. Default node fill: **pastel** — uncolored nodes get light blue `#a5d8ff` (`fillStyle solid`); cylinders still default to teal `#c3fae8`; explicit color tokens override. Zones unchanged.
3. `draw` renders PNG/SVG only with `--png`/`--svg` (DSL-to-file path never needs a browser).
4. CJK: keep the official CLI's sha-verified on-demand mirror download; `--fonts-url none` disables it.

## Future Work

Share link / upload (opt-in, needs account); edit an existing scene by element id (`patch` command: relabel, recolor, add edge, re-layout preserving manual positions); `setup hooks` SessionStart installer via `axi-axi setup hooks`; `--engine elk`; Node-only SVG via `exportScene` `environment` + `linkedom` (0.1.7 types advertise it) to drop the browser for SVG; `note[...]` free text, images, `frame` groups, sequence-diagram sugar.

## Appendix

Sources read: `axi-axi/templates/project/src/**` (args, router, toon, errors, suggest, truncate, content), `axi-axi/src/commands/validate/checks.ts` (V01-V12 probes: no-args exit 0 + content, `--help` with flags/examples, unknown flag exit 2 listing flags, TOON shape, `[N]` headers, `help[]`, silent stderr, subcommand `--help`, SKILL.md + `skill:check`); `excalidraw-cli/src/{render,render-page,browser,fonts}.ts`, `scripts/{build-renderer,embedded-fonts}.mjs`, `test/render-fixture.ts` (full element field list); `excalidraw-mcp/src/server.ts` RECALL_CHEAT_SHEET (palette, defaults, label shorthand, bindings) and `src/mcp-app.tsx` (`convertToExcalidrawElements` + `exportToSvg` from `@excalidraw/excalidraw`); `@excalidraw/utils@0.1.7` tarball (`dist/types/excalidraw/scene/export.d.ts`, `dist/types/element/src/transform.d.ts`, prod bundle export list, 231 inlined woff2, 2 wasm, `dist/prod/assets/*.ttf`). Versions checked on npm 2026-10-23.

## Results (U8)

Gate run on the U8 worktree (base 2a92d9f, Windows 11, Node 24.19, Chrome/Edge present).

| Check | Result |
|---|---|
| `npm run build` | pass |
| `npm test` | 8 files, 224 tests pass (render suite ran with a real browser; includes the new `token` suite) |
| `npm run skill:check` | pass (SKILL.md up to date) |
| `npx -y axi-axi validate "node bin/excalidraw-cli-axi.js" --dir .` | exit 0: 11 pass, 0 fail, 1 warn, 4 advisory |
| V12 warn | "npm run skill:check failed" is a Windows-only artifact: the validator spawns `npm` without a shell and cannot launch `npm.cmd`. `npm run skill:check` itself passes; V12 is expected to pass on the Linux CI runner. |

Token comparison (`node scripts/token-compare.mjs`). est_tokens = ceil(chars / 4); no tokenizer is installed. The MCP JSON is counted minified; `test/fixtures/arch.mcp.json` holds 18 elements (camera, title, zone plus label, 7 nodes, 7 arrows) for the same diagram as `arch.exd`.

```
rows[4]{approach,chars,est_tokens}:
  dsl,276,69
  dsl+slice,871,218
  mcp-json,3699,925
  mcp-json+sheet,30642,7661
ratios[2]{name,value,target}:
  dsl/mcp-json,0.075,<=0.200 (1/5)
  dsl+slice/mcp-json+sheet,0.028,<=0.250 (1/4)
```

- Both targets are met with margin: the DSL is 13.4x smaller than the MCP JSON, and DSL plus the `syntax example` slice is 35x smaller than MCP JSON plus the cheat sheet. `test/token.test.ts` asserts the plan's 1/4 and 1/5 targets.
- Correction to the plan's assumption: `RECALL_CHEAT_SHEET` is 26,943 chars (~6.7k tokens), not ~9.5k. The script extracts it from `excalidraw-mcp/src/server.ts` at runtime when a copy is reachable (env `EXCALIDRAW_MCP_SERVER_TS`, first CLI argument, or a sibling checkout); otherwise it uses the vendored `CHEAT_SHEET_CHARS = 26943` (verified identical to the extracted length). With the plan's 9.5k figure the overall ratio would be 0.066, still well under 1/4.
- The whitespace-split count listed in the unit body is omitted: it is meaningless for minified JSON.

Performance (`draw test/fixtures/arch.exd`, wall clock including Node start): no render 85-106 ms over 5 runs (target < 400 ms); with `--png --svg` 889-934 ms over 4 consecutive runs (target < 3 s warm).

CI (`.github/workflows/ci.yml`): push and PR, ubuntu-latest, Node 22, `npm ci`, `npm run build`, `npm test` with Chrome from `browser-actions/setup-chrome@v1` exposed as `EXCALIDRAW_AXI_BROWSER_PATH` so the render suite runs, `npm run skill:check`, then `axi-axi validate` (non-zero exit on any `fail`). Not yet exercised on GitHub. Suggested `package.json` script (orchestrator-owned): `"tokens": "node scripts/token-compare.mjs"`.
