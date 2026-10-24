// Room for edge ends (KTD5/U10): ELK spreads the ends of the edges on one side of a node over that side, and
// Mermaid draws the node only as big as its label, so a hub with eight edges on a 47 px side gets ends 4 px
// apart: arrows drawn on top of each other and arrowheads in a heap. The engine renders once, reads on which
// side of which node every edge actually ends, and renders again with the crowded nodes grown, via the
// minimum label box that scripts/build-mermaid.mjs lets the page honour (window.__axiNodeMin).

import type { NeutralBox, NeutralScene } from "../neutral.js";

export interface Sizing {
  /** Px between two edge ends on a side when one of them has an arrowhead (the checker's crowding limit is 18). */
  head: number;
  /** Px between two arrowless ends (collinear limit 10). */
  tail: number;
  /** Px between ends of edges that connect the same two nodes (parallel limit 20). */
  pair: number;
  /** Px kept free at both ends of a side. */
  margin: number;
  /** Px between the ends on a side that carries a self-loop (ELK divides the side by k + 1 there; a loop needs 16 px between its ends). */
  loop: number;
  /** Px a node keeps beside its label (the checker allows the label 4 px less than the box). */
  fit: number;
  /** Px a shape adds around its label box (Mermaid's flowchart padding, twice). */
  pad: number;
}

/** Minimum label box (px) per node id: the node is drawn at least this big around its label. */
export type NodeMin = Record<string, { w?: number; h?: number }>;

export const DEFAULT_SIZING: Sizing = { head: 20.5, tail: 12, pair: 22, margin: 22, loop: 20, fit: 30, pad: 30 };

type Side = "N" | "E" | "S" | "W";

/** The side of `box` that point `p` is nearest to. */
export function sideOf(box: NeutralBox, [x, y]: [number, number]): Side {
  const d: [number, Side][] = [
    [Math.abs(y - box.y), "N"],
    [Math.abs(x - (box.x + box.w)), "E"],
    [Math.abs(y - (box.y + box.h)), "S"],
    [Math.abs(x - box.x), "W"],
  ];
  return d.reduce((best, c) => (c[0] < best[0] ? c : best))[1];
}

/**
 * The side of its node an edge end sits on, from the way the route leaves it (ELK routes are orthogonal, so the
 * first segment runs away from the side it starts on). A diamond's or a stadium's outline is far inside the box, so
 * the nearest box side to the end point can be the wrong one; falls back to it for a zero-length segment.
 */
export function endSide(box: NeutralBox, poly: [number, number][], end: "start" | "end"): Side {
  const p = poly[end === "start" ? 0 : poly.length - 1] as [number, number];
  const q = poly[end === "start" ? 1 : poly.length - 2] as [number, number];
  // Mermaid sometimes cuts a route at the outline of the node's polygon and leaves a stub before the real port:
  // when the second point is on a box side and the first is not, that is the port.
  const onSide = (pt: [number, number]): boolean => Math.min(Math.abs(pt[0] - box.x), Math.abs(pt[0] - box.x - box.w), Math.abs(pt[1] - box.y), Math.abs(pt[1] - box.y - box.h)) < 1.2;
  if (!onSide(p) && onSide(q)) return sideOf(box, q);
  const dx = end === "start" ? q[0] - p[0] : p[0] - q[0];
  const dy = end === "start" ? q[1] - p[1] : p[1] - q[1];
  const away: [number, number] = end === "start" ? [dx, dy] : [-dx, -dy];
  if (Math.hypot(dx, dy) < 1) return sideOf(box, p);
  return Math.abs(away[1]) >= Math.abs(away[0]) ? (away[1] > 0 ? "S" : "N") : away[0] > 0 ? "E" : "W";
}

interface End {
  head: boolean;
  pair: string;
  loop: boolean;
}

/**
 * `prev` with the nodes whose sides are too short for their edge ends grown to fit; undefined when nothing
 * is. A side with k ends needs 2 x margin + (k - 1) x gap, the gap being the head, pair or tail spacing
 * of the ends on it. The width grows for ends on a top or bottom side, the height for a left or right one.
 */
export function growNodes(scene: NeutralScene, prev: NodeMin, s: Sizing = DEFAULT_SIZING): NodeMin | undefined {
  const boxes = new Map(scene.nodes.filter((n) => n.kind === "node").map((n) => [n.id, n.box] as const));
  const ends = new Map<string, End[]>();
  const add = (node: string, side: Side, head: boolean, pair: string, loop = false): void => {
    const box = boxes.get(node);
    if (!box) return;
    const key = `${node}\u0000${side}`;
    const list = ends.get(key) ?? [];
    list.push({ head, pair, loop });
    ends.set(key, list);
  };
  for (const e of scene.edges) {
    if (!e.src || !e.dst || e.poly.length < 2) continue;
    const pair = [e.src, e.dst].sort().join("\u0000");
    const loop = e.src === e.dst;
    const sBox = boxes.get(e.src);
    const dBox = boxes.get(e.dst);
    if (sBox) add(e.src, endSide(sBox, e.poly, "start"), e.startArrow === true, pair, loop);
    if (dBox) add(e.dst, endSide(dBox, e.poly, "end"), e.endArrow !== false, pair, loop);
  }

  let grown: NodeMin | undefined;
  const grow = (node: string, axis: "w" | "h", have: number, need: number): void => {
    if (need <= have + 0.5) return;
    grown ??= structuredClone(prev);
    const entry = (grown[node] ??= {});
    const base = entry[axis] ?? have - s.pad;
    entry[axis] = Math.max(entry[axis] ?? 0, Math.round((base + (need - have)) * 10) / 10);
  };
  for (const [key, list] of ends) {
    if (list.length < 2 && !list[0]?.loop) continue;
    const [node, side] = key.split("\u0000") as [string, Side];
    const box = boxes.get(node) as NeutralBox;
    const plain = list.filter((x) => !x.loop);
    const repeated = new Set(plain.map((x) => x.pair)).size < plain.length;
    const gap = Math.max(list.some((x) => x.head) ? s.head : s.tail, repeated ? s.pair : 0);
    const need = list.some((x) => x.loop) ? 2 * s.margin + (list.length + 1) * Math.max(gap, s.loop) : 2 * s.margin + (list.length - 1) * gap;
    const axis = side === "N" || side === "S" ? "w" : "h";
    grow(node, axis, axis === "w" ? box.w : box.h, need);
  }
  // a label wider than its node (Mermaid draws a cylinder 135 px wide whatever its text): room for it
  for (const l of scene.labels) {
    const box = boxes.get(l.ownerId);
    if (box) grow(l.ownerId, "w", box.w, l.box.w + s.fit);
  }
  return grown;
}

/**
 * A stadium ("id([text])") has half-round ends: ends of edges that sit near its corners land far inside its
 * bounding box, and a grown stadium is mostly curve. The nodes in `ids` (those that had to grow) are
 * declared as rounded rectangles ("id(text)") instead.
 */
export function roundStadiums(source: string, ids: Iterable<string>): string {
  let out = source;
  for (const id of ids) {
    if (!/^[A-Za-z0-9_]+$/.test(id)) continue;
    out = out.replace(new RegExp(`^(\\s*${id})\\(\\[(.*?)\\]\\)`, "gm"), "$1($2)");
  }
  return out;
}
