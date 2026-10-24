---
name: diagram-axi
description: "Create an Excalidraw diagram, architecture diagram, flowchart or hand-drawn style diagram from a compact text DSL: writes an editable .excalidraw file and renders PNG/SVG offline. Also draws sequence, class, ER, state, timeline, commit-history and mind-map diagrams (D2, Mermaid). Use when asked to draw, diagram or sketch boxes and arrows, system or cloud architecture, pipelines, flows, org charts, Mermaid for a README, or how a TS/JS codebase's modules import each other."
---

# diagram-axi

Turn a compact text description of boxes and arrows into an editable diagram file (Excalidraw, D2 or Mermaid) plus PNG/SVG renders, offline. Run everything with npx; no install, no account.

## Golden path

1. Read the DSL: `npx -y diagram-axi syntax example` (details: `npx -y diagram-axi syntax nodes|edges|groups|style`).
2. Read the authoring limits: `npx -y diagram-axi syntax tips` (<= 2 arrows per node pair, <= 8 per node, 3-word edge labels, <= ~25 nodes).
3. Write the diagram to `diagram.exd` (a few lines per box and arrow).
4. Lint it: `npx -y diagram-axi check diagram.exd`; fix every warning (each carries a paste-able `suggestion`) before drawing.
5. Draw it: `npx -y diagram-axi draw diagram.exd --png` writes `diagram.excalidraw` and `diagram.png`. A parse error prints `line:col`, the token and a fix; edit and rerun (`--force` overwrites). Fix any `quality:` rows (each has a `fix`) and rerun before rendering the final PNG. If `check` printed `engine: suggest d2`, draw with `--engine d2` (or `--engine auto`) unless the user asked for an editable Excalidraw file (then add `--target editable`, which keeps excalidraw).
6. Verify: `npx -y diagram-axi inspect diagram.excalidraw` (counts, bounds, unresolved refs), then look at the PNG.

`--png` / `--svg` need Chrome, Edge, Chromium or Firefox already installed (none is downloaded); without them `draw` still writes the editable `.excalidraw`, which opens at excalidraw.com. `render x.excalidraw --png` re-renders.

## Choose the engine

Default is excalidraw (editable, hand-drawn look). The tool recommends but never switches silently; `--engine excalidraw|d2|mermaid` is explicit, `--engine auto` follows the recommendation.

| Need | Engine |
|---|---|
| boxes and arrows that fit (<= 25 nodes, sparse, short labels) | excalidraw: `.exd` |
| sequence, class, ER/SQL tables | d2: write `.d2` |
| state, timeline, commit history, mind map | mermaid: write `.mmd` |
| dense or large graph | d2: `draw x.exd --engine d2` |
| diagram for a README or GitHub | mermaid: `draw x.exd --target markdown` |

README/GitHub output wins over every other row, kind rows included: an ER or sequence diagram for a README is mermaid `.mmd`.

`check` and `draw` print `engine: suggest d2 (reason); add --engine d2` when a graph outgrows excalidraw; no `engine:` line means the default is fine. A `.d2` or `.mmd` file picks its own engine and is never rewritten: `npx -y diagram-axi draw login.mmd --png` writes `login.svg` and `login.png` beside it (d2 and mermaid always write SVG). Check native files with `check`.

Read the syntax slice before writing native source: `npx -y diagram-axi syntax d2 sequence|class|erd|style|example`, `npx -y diagram-axi syntax mermaid state|timeline|gitgraph|mindmap|example`, `npx -y diagram-axi syntax routing`. `npx -y diagram-axi engines` shows status; PNG needs a browser, or the optional d2 binary (`engines install d2`).

To learn a TS/JS codebase (experimental): `npx -y diagram-axi extract src` writes `imports.exd` (+ a file map; green = entry or --focus file, yellow = hub `used by N`); draw it following its `engine:` line (dense or wide graphs say d2); `--focus <file>` zooms in (`syntax extract`).

## Known weaknesses (measured on held-out QA)

- excalidraw: hubs with > 8 arrows, > 2 arrows between one pair, labels over 40 chars per line and > 6 cross-group edges come out tangled (stacked arrowheads, labels drifting onto other arrows). `check` flags each; shorten or regroup, but if the user wants the content kept as is (all nodes, full labels) follow `engine: suggest d2` instead. Keep it for <= 25 nodes, short labels, or when the user must edit by hand.
- d2: still crowds arrowheads on hairballs (edges > 2 x nodes, 50+ nodes) and sets multi-line edge labels tight. Best for nested or cross-linked groups, hubs, parallel edges, sequence/class/ER.
- mermaid: weakest with groups (nested subgraphs, many cross-group edges), self-loops, and long single-word labels (wrap mid-word); unreadable past 50 nodes. Use it when the output must render in Markdown/GitHub or for state/timeline/gitgraph/mindmap; for a README with hubs or parallel edges it is as good as d2.
- every engine: past ~50 nodes, or when d2 still crowds, suggest splitting the diagram; a merely dense or large graph goes to d2.

## Example

```
syntax: example, a complete diagram to copy
rules[1]:
  save as order.exd, then: npx -y diagram-axi draw order.exd --png  (writes order.excalidraw and order.png)
example:
  title "Order pipeline"
  dir RIGHT
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
help[3]:
  npx -y diagram-axi draw <file.exd> --png
  npx -y diagram-axi check <file.exd>
  npx -y diagram-axi syntax edges
```

Every command has `--help`; exit codes 0 ok, 1 error, 2 usage; output is TOON.
