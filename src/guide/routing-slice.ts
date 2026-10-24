// The `syntax routing` slice: which engine draws what (plan KTD4). Rules mirror
// src/engines/route.ts (U4); keep thresholds in sync with the lint constants.

import type { Slice } from "./slices.js";
import { renderNativeSlice } from "./d2-slices.js";

export const ROUTING_SLICE: Slice = {
  topic: "routing",
  summary: "which engine draws what",
  rules: [
    "1. --engine excalidraw|d2|mermaid always wins; --engine auto applies the suggestion",
    "2. --target markdown|github forces mermaid (renders inline on GitHub); --target editable forces excalidraw",
    "3. sequence, class, erd: d2 (sequence goes to mermaid for --target markdown); state, timeline, gitgraph, mindmap: mermaid",
    "4. graph (.exd) stays excalidraw while it fits: <= 25 nodes, edges <= 2 x nodes (dense test starts at 6 nodes), no pair with > 2 edges, <= 8 arrows per node, groups <= 2 deep, <= 6 cross-group edges, no label line > 40 chars",
    "5. otherwise check and draw print: engine: suggest d2 (reason); add --engine d2, or use --engine auto to apply it",
    "native files route by extension: .d2 is d2, .mmd is mermaid; they are never rewritten",
  ],
  example: ["$ check dense.exd", "$ draw dense.exd --engine d2 --png", "$ draw notes.exd --target markdown"].join("\n"),
  help: ["$ syntax d2 example", "$ syntax mermaid example", "$ engines"],
};

/** The routing slice rendered like any other (topic header, rules, example, help[]). */
export function renderRoutingSlice(tool: string): string {
  return renderNativeSlice("",ROUTING_SLICE, tool);
}
