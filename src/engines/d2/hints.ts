// Quality rows for D2 diagrams: checker findings turned into fixes. D2 owns the layout, so fixes name
// layout engine, direction and label changes, never coordinates (KTD5). Kept apart from the
// excalidraw rows in src/quality/hints.ts.

import type { Finding } from "../../quality/analyze.js";
import type { QualityRow } from "../../quality/hints.js";
import type { D2Layout } from "./wasm.js";

export interface D2HintOptions {
  layout: D2Layout;
  /** `--sketch` was used (it redraws strokes, not positions). */
  sketch?: boolean;
}

const DETAIL_MAX = 150;

/** Other layout engines worth trying, best first. */
function otherLayouts(layout: D2Layout): string {
  const order: D2Layout[] = ["elk", "tala", "dagre"];
  return order.filter((l) => l !== layout).map((l) => `--layout ${l}`).join(" or ");
}

const SHORTEN = "shorten the label (3 words or fewer) or put the detail in a node";
const SPLIT = "split the diagram, or group related nodes in a container";

function fixFor(code: string, o: D2HintOptions): string {
  const tryLayout = `try ${otherLayouts(o.layout)}`;
  switch (code) {
    case "node-overlap":
    case "zone-intrusion":
    case "group-containment":
      return `${tryLayout}; if it persists check the container nesting in the source`;
    case "label-label-overlap":
    case "label-on-node":
    case "label-on-foreign-arrow":
    case "label-covers-own-arrow":
    case "label-at-crossing":
      return `${SHORTEN}; ${tryLayout}`;
    case "text-overflow":
      return "set the shape's width/height larger, or shorten the label";
    case "arrow-crossings":
      return `${tryLayout}, or flip direction (direction: right|down); ${SPLIT}`;
    case "route-ratio":
    case "aspect-ratio":
      return `flip direction (direction: right|down), ${tryLayout}; ${SPLIT}`;
    case "parallel-edges-close":
    case "arrows-collinear-overlap":
      return `merge parallel edges into one with a combined label; ${tryLayout}`;
    case "arrow-through-node":
    case "node-edge-graze":
      return `${tryLayout}; ${SPLIT}`;
    default:
      return `${tryLayout}, change the direction, or ${SPLIT}`;
  }
}

/** Findings (already filtered by the engine's rule mask) -> rows. */
export function d2QualityRows(findings: Finding[], o: D2HintOptions): QualityRow[] {
  return findings.map((f) => ({
    code: f.code,
    detail: f.detail.length > DETAIL_MAX ? `${f.detail.slice(0, DETAIL_MAX - 3)}...` : f.detail,
    fix: fixFor(f.code, o),
    severity: f.severity,
  }));
}
