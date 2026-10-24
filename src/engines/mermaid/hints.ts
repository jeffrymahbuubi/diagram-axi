// Advisory fixes for checker findings on Mermaid output (KTD5). Mermaid and ELK own the layout, so a
// fix never names coordinates: it changes the layout engine, the direction, the label text or the
// diagram's shape. Pure: findings in, rows out. Kept apart from src/quality/hints.ts (exd fixes).

import type { Finding } from "../../quality/analyze.js";
import type { QualityRow } from "../../quality/hints.js";
import type { Kind } from "../types.js";

export interface MermaidHintOptions {
  /** Layout the diagram was drawn with (`elk` or `dagre`). */
  layout?: string;
  kind?: Kind;
}

const DETAIL_MAX = 150;
const clip = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 3)}...` : s);

/** The other layout engine, as the first thing to try. */
const otherLayout = (layout: string | undefined): string => (layout === "dagre" ? "elk" : "dagre");

function fixFor(code: string, o: MermaidHintOptions): string | undefined {
  const swap = `try --layout ${otherLayout(o.layout)}`;
  switch (code) {
    case "node-overlap":
    case "zone-intrusion":
    case "group-containment":
      return `${swap}; if it persists, split the diagram or flatten nested subgraphs`;
    case "label-label-overlap":
    case "label-on-node":
    case "label-on-foreign-arrow":
      return `shorten the edge labels (1-3 words) or ${swap}`;
    case "text-overflow":
      return "shorten the node label or break it with <br>";
    case "arrow-through-node":
      return `${swap}, or change the direction (flowchart LR vs TD)`;
    case "parallel-edges-close":
      return "merge the parallel edges into one with a combined label";
    case "arrow-crossings":
    case "route-ratio":
      return `${swap}, change the direction, or split the diagram into two`;
    case "aspect-ratio":
      return "change the direction (flowchart LR vs TD) or split the diagram";
    default:
      return undefined;
  }
}

/** Rows for `draw`/`inspect` on a Mermaid diagram; findings without a Mermaid fix are left out. */
export function mermaidHints(findings: readonly Finding[], o: MermaidHintOptions = {}): QualityRow[] {
  const seen = new Set<string>();
  const rows: QualityRow[] = [];
  for (const f of findings) {
    const fix = fixFor(f.code, o);
    if (!fix || seen.has(f.code)) continue;
    seen.add(f.code);
    rows.push({ code: f.code, severity: f.severity, detail: clip(f.detail), fix });
  }
  return rows;
}
