// Self-loops (`a -> a`): a four-point orthogonal loop that leaves and re-enters one side of the node,
// bulging outwards. It is deep enough that the edge label, centered on the outer run, clears the node.
// The side is chosen against the nodes and routes already placed.

import type { Point } from "./engine.js";
import { overlap, segmentHits } from "./geom.js";
import { NORMAL, countHits, crossings, portOnSide, sharesTrack, type Side } from "./route-util.js";
import type { RouteNode } from "./route.js";
import { T } from "./tune.js";

/** How far a loop sticks out of the node (before the label's own half extent is added). */
const LOOP_DEPTH = 30;
/** Largest depth a left/right loop may take before top/bottom is preferred. */
const LOOP_MAX_DEPTH = 90;
const LABEL_PAD = 4;
/** Height a node needs for a labelled self-loop on a side: the outer run is the label plus the run slack, the ends keep loopCorner from the corners. */
export const loopNodeHeight = (label: LoopLabel): number => label.h + T.loopRunSlack + 2 * T.loopCorner;

export interface LoopLabel {
  w: number;
  h: number;
}

/** Candidate loop on `side`: [start port, out, out, end port]; `at` is the middle of the outer run. */
export function loopOn(node: RouteNode, side: Side, label: LoopLabel | undefined): { pts: Point[]; at: Point; depth: number } {
  const alongX = side === "top" || side === "bottom";
  const sideLen = alongX ? node.box.w : node.box.h;
  // A label centered on the outer run hides that part of the loop: where the node is wide enough the
  // run is made longer than the label so the loop still reads as a loop with the label on it.
  const wanted = label && (alongX || T.loopGrow) ? ((alongX ? label.w : label.h) + T.loopRunSlack) / 2 : 0;
  // The ends stay CORNER_CLEAR from the corners so loops on two sides meeting there keep their arrowheads apart.
  const q = Math.min(Math.max(Math.min(22, sideLen * 0.36), wanted, T.loopMinQ), Math.max(T.loopMinQ, sideLen / 2 - T.loopCorner));
  const n = NORMAL[side];
  const p1 = portOnSide(node.shape, node.box, side, -q);
  const p2 = portOnSide(node.shape, node.box, side, q);
  // Clearance beyond the node's bounding box on that side.
  const half = label ? (alongX ? label.h : label.w) / 2 + 6 : 0;
  const depth = Math.max(LOOP_DEPTH, half);
  const { x, y, w, h } = node.box;
  const edge = side === "right" ? x + w : side === "left" ? x : side === "bottom" ? y + h : y;
  const outer = edge + (alongX ? n.y : n.x) * depth;
  const pts: Point[] = alongX
    ? [p1, { x: p1.x, y: outer }, { x: p2.x, y: outer }, p2]
    : [p1, { x: outer, y: p1.y }, { x: outer, y: p2.y }, p2];
  const at = alongX ? { x: (p1.x + p2.x) / 2, y: outer } : { x: outer, y: (p1.y + p2.y) / 2 };
  return { pts, at, depth };
}

/**
 * Route a self-loop. Sides are tried in order of preference (the cross sides of the flow first, then
 * the flow sides) and the one with the fewest clashes wins; ties go to the earlier side.
 */
export function routeLoop(
  node: RouteNode,
  label: LoopLabel | undefined,
  nodes: RouteNode[],
  placed: Point[][],
  axis: "x" | "y",
  reverse: boolean,
  forced?: Side,
): Point[] {
  const others = nodes.filter((n) => n !== node);
  let order: Side[] = axis === "y" ? ["right", "left", "bottom", "top"] : ["bottom", "top", "right", "left"];
  if (reverse && axis === "x") order.reverse();
  if (forced) order = [forced];
  let best: Point[] | undefined;
  let bestScore = Infinity;
  order.forEach((side, pref) => {
    const c = loopOn(node, side, label);
    let score = pref + c.depth / 100;
    if (c.depth > LOOP_MAX_DEPTH) score += 50;
    score += countHits(c.pts, others) * 100;
    score += sharesTrack(c.pts, placed) ? 30 : 0;
    score += crossings(c.pts, placed) * 20;
    if (label) {
      const box = { x: c.at.x - label.w / 2, y: c.at.y - label.h / 2, w: label.w, h: label.h };
      // the label would hide (nearly) the whole outer run: the loop would read as two stubs
      const run = Math.hypot(c.pts[2]!.x - c.pts[1]!.x, c.pts[2]!.y - c.pts[1]!.y);
      if (run < (side === "top" || side === "bottom" ? label.w : label.h) + T.loopRunSlack) score += T.loopRunPrice;
      for (const o of others) if (overlap(box, o.box, LABEL_PAD)) score += 200;
      for (const r of placed) {
        for (let i = 1; i < r.length; i++) {
          if (segmentHits(r[i - 1]!, r[i]!, box, 2)) {
            score += 60;
            break;
          }
        }
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = c.pts;
    }
  });
  return best!;
}
