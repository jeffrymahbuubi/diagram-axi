// The `syntax extract` slice: how to turn a TS/JS codebase into a diagram. Keep in step with
// src/commands/extract.ts (flags) and src/extract/aggregate.ts (the cut); budget 350 tokens.

import type { Slice } from "./slices.js";
import { renderNativeSlice } from "./d2-slices.js";

export const EXTRACT_SLICE: Slice = {
  topic: "extract",
  summary: "learn a TS/JS codebase: import graph to .exd",
  rules: [
    "$ extract <dir> scans TS/JS files and writes imports.exd (+ imports.exd.map.json: box id -> files, lines); draws nothing",
    "folders are groups; big folders collapse to `layout/ (17 files)`; the view is cut to --max-nodes 25; busy files are yellow with one note `used by 20, 2 uses hidden`, cycles red, the entry (bin/main/exports, root index) and the --focus file green with an `entry` / `focus` note (`entry: node.ts` on a folder)",
    "files and folders with no import arrow to the rest are not drawn: `isolated: N files` in the graph line, listed in the sidecar",
    "the TOON output counts what is hidden (externals, tests, type-only, hub edges); unresolved imports are listed, never dropped",
    "then draw the .exd as printed; dense or wide views print `engine: suggest d2`, so use `draw imports.exd --engine d2 --png`",
    "zoom: --focus <file|dir> [--depth 2] [--dir out|in|both]; open a folder: --expand <dir>; flat labels: --group none",
    "more: --include/--exclude <globs>, --tests, --types, --externals count|show, --hubs show, --tsconfig <file>, --format json, --force",
  ],
  example: ["$ extract src", "$ draw imports.exd --engine d2 --png", "$ extract src --focus src/cli/router.ts --depth 2 --out router"].join("\n"),
  help: ["$ extract --help", "$ syntax routing", "$ syntax tips"],
};

export function renderExtractSlice(tool: string): string {
  return renderNativeSlice("", EXTRACT_SLICE, tool);
}
