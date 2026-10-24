import { layeringOf } from "./layering.js";

// How dense is an extract view, and what does the density change? Two decisions use the same measure:
//   1. the box budget: a view with >= 12 connected boxes and more than 1.5 edges per box is cut again with a smaller
//      --max-nodes (aggregate.ts, only when --max-nodes was not typed), down to a floor of 12;
//   2. the engine: the shared router (src/engines/route.ts) stays tuned for hand-written graphs (edges > 2 x nodes, ...).
//      Import graphs are denser per box and the arrows converge on a few files, so `extract` adds its own, tighter rules
//      that only ever turn "fits excalidraw" into "suggest d2": too many arrows per box, too many arrows into one box, and
//      too many boxes side by side (a wide layer).
//
// Calibration (vision verdicts of QA rounds 1-3; n = boxes with at least one drawn edge, m = drawn edges, in = most
// arrows landing on one box, W = boxes on the widest layer of layering.ts):
//   rejected on excalidraw: excalidraw-default/none n25 m50 (2.00), excalidraw-focus n15 m30 (2.00), hono-max15 n14 m29 (2.07),
//                           hono-none n23 m43 (1.87), vitest-none n18 m32 (1.78, in 7: "arrowheads pile up"),
//                           self-none n24 m38 (1.58, round 2: "ambiguous labels on shared lines, stacked arrowheads"),
//                           vitest-none round 3 n22 m32 (1.45, W 9, 4499x945 px, 51 crossings)
//   accepted on excalidraw: commander n8 m14 (1.75, in 4), self-max15 n14 m24 (1.71, in 6), excalidraw-max15 n13 m22 (1.69, in 5),
//                           zod n19 m24 (1.26, in 5), zod-none round 3 (W 7, 2515x1082)
//   accepted on d2:         hono-default n24 m44 (1.83)
// so from 12 connected boxes on, more than 1.5 edges per box is too dense for excalidraw (the 1.69-1.75 graphs that were
// accepted at 12-14 boxes move to d2 too: one line instead of two); 7 arrows landing on one box stack their arrowheads
// whatever the ratio (accepted views peak at 6); and a layer wider than 7 boxes spreads the excalidraw router over long
// horizontal bundles (every accepted excalidraw view has W <= 7, the rejected flat one has W 9).

export const EXTRACT_DENSE_MIN_NODES = 12;
export const EXTRACT_DENSE_RATIO = 1.5;
export const EXTRACT_DENSE_IN_DEGREE = 7;
/** A layer with more boxes than this is too wide for excalidraw (layering.ts). */
export const EXTRACT_MAX_WIDTH = 7;
/** The automatic budget never goes below this many boxes. */
export const BUDGET_FLOOR = 12;


export interface DensityInput {
  edges: Array<{ from: string; to: string; stub: boolean }>;
}

export interface Density {
  /** Boxes with at least one drawn edge. */
  boxes: number;
  /** Drawn edges (stub lines excluded). */
  edges: number;
  /** Most arrows landing on one box. */
  peak: number;
}

export function densityOf(view: DensityInput): Density {
  const linked = new Set<string>();
  const into = new Map<string, number>();
  let edges = 0;
  for (const e of view.edges) {
    if (e.stub) continue;
    edges++;
    linked.add(e.from);
    linked.add(e.to);
    into.set(e.to, (into.get(e.to) ?? 0) + 1);
  }
  return { boxes: linked.size, edges, peak: Math.max(0, ...into.values()) };
}

/** True when the picture has too many edges per box for its size, whatever the engine (the budget retry trigger). */
export function crowded(d: Density): boolean {
  return d.boxes >= EXTRACT_DENSE_MIN_NODES && d.edges > EXTRACT_DENSE_RATIO * d.boxes;
}

/** A short reason (`dense: 43 edges on 23 boxes`) when the view is too dense or too wide for excalidraw, else undefined. */
export function denseReason(view: DensityInput): string | undefined {
  const d = densityOf(view);
  if (d.boxes < EXTRACT_DENSE_MIN_NODES) return undefined;
  if (crowded(d)) return `dense: ${d.edges} edges on ${d.boxes} boxes`;
  if (d.peak >= EXTRACT_DENSE_IN_DEGREE) return `dense: ${d.peak} arrows into one box`;
  const w = layeringOf(view).width;
  return w > EXTRACT_MAX_WIDTH ? `wide: ${w} boxes side by side` : undefined;
}
