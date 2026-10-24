// Edge labels (U10): ELK puts the label of an edge at a spot of its own choosing: over a node's corner, on another
// edge, beside a neighbour's label, or half outside the subgraph the edge lives in. The label can sit anywhere along
// its own edge without changing the layout, so after a render the engine looks for a spot on the route where it
// collides with nothing, and renders once more with those spots (window.__axiLabelAt, honoured by the patch in
// scripts/build-mermaid.mjs, which sets the translate of the label).

import type { NeutralBox, NeutralScene } from "../neutral.js";
import { segmentHitsBox } from "./titles.js";

export type Pt = [number, number];

const overlap = (a: NeutralBox, b: NeutralBox, m = 0): boolean => a.x + m < b.x + b.w && b.x + m < a.x + a.w && a.y + m < b.y + b.h && b.y + m < a.y + a.h;
const inside = (inner: NeutralBox, outer: NeutralBox, m = 0): boolean => inner.x >= outer.x + m && inner.y >= outer.y + m && inner.x + inner.w <= outer.x + outer.w - m && inner.y + inner.h <= outer.y + outer.h - m;

const PENALTY = { collide: 100, segment: 30, distance: 0.03 };
/** Px of route kept free at each end of a label's spot (the arrowhead and the node border). */
const END_CLEAR = 18;
/** Px between two candidate spots on a route. */
const STEP = 6;

/** Points every `step` px along the polyline, as [x, y, distance from the start]. */
export function samples(poly: Pt[], step = STEP): [number, number, number][] {
  const out: [number, number, number][] = [];
  let walked = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1] as Pt;
    const b = poly[i] as Pt;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d < len; d += step) out.push([a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len, walked + d]);
    walked += len;
  }
  const last = poly[poly.length - 1] as Pt;
  out.push([last[0], last[1], walked]);
  return out;
}

/** Whether the segment of `poly` nearest to (x, y) is vertical. */
function isVertical(poly: Pt[], x: number, y: number): boolean {
  let best = Infinity;
  let vertical = false;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1] as Pt;
    const b = poly[i] as Pt;
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / len2));
    const d = Math.hypot(x - (a[0] + (b[0] - a[0]) * t), y - (a[1] + (b[1] - a[1]) * t));
    if (d < best) {
      best = d;
      vertical = Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]);
    }
  }
  return vertical;
}

/**
 * Where each edge label that collides with something moves to (the new center), or undefined when none moves.
 * A label collides with a node, another label, a zone title, an edge that is not its own, or (when both ends of
 * its edge are in one subgraph) the frame of that subgraph. Spots are points of the label's own route; the one
 * with the fewest collisions wins, nearest to where ELK put it on a tie. `titles` are the zone title boxes as they
 * will be drawn (default: where `scene` has them).
 */
export function placeLabels(scene: NeutralScene, titles?: Record<string, NeutralBox>): Record<string, Pt> | undefined {
  const nodes = scene.nodes.filter((n) => n.kind === "node");
  const zoneBox = new Map(scene.nodes.filter((n) => n.kind === "zone").map((n) => [n.id, n.box] as const));
  const parentOf = new Map(scene.nodes.map((n) => [n.id, n.parent] as const));
  /** The zones a node is in: its parent, that one's parent, and so on. */
  const chain = (id: string): Set<string> => {
    const out = new Set<string>();
    for (let p = parentOf.get(id); p !== undefined && !out.has(p); p = parentOf.get(p)) out.add(p);
    return out;
  };
  const obstacles: NeutralBox[] = nodes.map((n) => n.box);
  for (const l of scene.labels) if (zoneBox.has(l.ownerId)) obstacles.push(titles?.[l.ownerId] ?? l.box);
  const current = scene.edges.map((e) => (e.label ? { ...e.label } : undefined));

  const score = (i: number, box: NeutralBox): number => {
    const e = scene.edges[i]!;
    let s = 0;
    if (obstacles.some((b) => overlap(box, b, 2))) s += PENALTY.collide; // a node or a zone title
    for (let j = 0; j < current.length; j++) {
      const other = current[j];
      if (j !== i && other && overlap(box, other, 1)) s += PENALTY.collide;
    }
    const mine = chain(e.src);
    const theirs = chain(e.dst);
    for (const [id, z] of zoneBox) {
      if (mine.has(id) && theirs.has(id)) {
        if (!inside(box, z, 2)) s += PENALTY.collide; // joins two members of the zone: inside it
      } else if (!mine.has(id) && !theirs.has(id) && overlap(box, z, 2)) s += PENALTY.collide; // a zone neither end belongs to
    }
    const probe: NeutralBox = { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 };
    scene.edges.forEach((f, j) => {
      if (j === i) return;
      for (let k = 1; k < f.poly.length; k++) if (segmentHitsBox(f.poly[k - 1] as Pt, f.poly[k] as Pt, probe)) s += PENALTY.segment;
    });
    return s;
  };

  const moved: Record<string, Pt> = {};
  const order = scene.edges.map((e, i) => ({ i, s: e.label ? score(i, e.label) : 0 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  for (const { i } of order) {
    const e = scene.edges[i]!;
    const label = current[i]!;
    const here: Pt = [label.x + label.w / 2, label.y + label.h / 2];
    const total = samples(e.poly).at(-1)?.[2] ?? 0;
    let best = { s: score(i, label), d: 0, c: here };
    for (const [x, y, d] of samples(e.poly)) {
      if (d < END_CLEAR || d > total - END_CLEAR) continue;
      // on a vertical stretch the label may also straddle the line off-center (still crossed by it), which frees it
      // from a frame or a neighbour beside the route
      const offsets = isVertical(e.poly, x, y) ? [0, -0.3 * label.w, 0.3 * label.w, -0.45 * label.w, 0.45 * label.w] : [0];
      for (const off of offsets) {
        const cx = x + off;
        const box: NeutralBox = { x: cx - label.w / 2, y: y - label.h / 2, w: label.w, h: label.h };
        const s = score(i, box);
        const away = Math.hypot(cx - here[0], y - here[1]) + Math.abs(off) * 3;
        if (s + away * PENALTY.distance < best.s + best.d * PENALTY.distance) best = { s, d: away, c: [cx, y] };
      }
    }
    if (best.c !== here) {
      moved[e.id] = [Math.round(best.c[0] * 100) / 100, Math.round(best.c[1] * 100) / 100];
      current[i] = { x: best.c[0] - label.w / 2, y: best.c[1] - label.h / 2, w: label.w, h: label.h };
    }
  }
  return Object.keys(moved).length > 0 ? moved : undefined;
}

/**
 * placeLabels as the translate each moved label is drawn at: the translate of its `edgeLabel` group in `svg` (the
 * render the scene was measured on) plus the move of the label's center. Undefined when none moves.
 */
export function moveLabels(scene: NeutralScene, svg: string, moves: Record<string, Pt> | undefined): Record<string, Pt> | undefined {
  if (!moves) return undefined;
  const out: Record<string, Pt> = {};
  const re = /<g class="edgeLabel"[^>]*transform="translate\(([-0-9.e]+),\s*([-0-9.e]+)\)"[^>]*><g class="label" data-id="([^"]+)"/g;
  for (const m of svg.matchAll(re)) {
    const id = m[3] as string;
    const to = moves[id];
    const e = scene.edges.find((x) => x.id === id);
    if (!to || !e?.label) continue;
    out[id] = [Math.round((Number(m[1]) + to[0] - (e.label.x + e.label.w / 2)) * 100) / 100, Math.round((Number(m[2]) + to[1] - (e.label.y + e.label.h / 2)) * 100) / 100];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
