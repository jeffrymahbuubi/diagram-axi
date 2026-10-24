// Geometry helpers for edge routing: sides, ports on node outlines, route validity and scoring.

import type { ArrowKind, ShapeKind } from "../dsl/ast.js";
import type { Box, Point } from "./engine.js";
import { center, dot, len, segmentHits, sub } from "./geom.js";
import type { RouteNode } from "./route.js";
import { T } from "./tune.js";

/** An arrowhead is about this long: nothing may cross the route this far behind a tip. */
export const HEAD_LEN = 20;
export const MIN_SEGMENT = 2;
const MAX_RAILS = 14;

/** Arrowheads at [start, end] per arrow kind (as drawn by scene/build.ts). */
export const headsOf = (kind: ArrowKind): [boolean, boolean] => (kind === "line" ? [false, false] : kind === "both" ? [true, true] : [false, true]);

export const OPPOSITE: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };
export type Side = "left" | "right" | "top" | "bottom";

export const NORMAL: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};


/** The side of `box` the ray from its center toward `toward` leaves through. */
export function sideToward(box: Box, toward: Point): Side {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (Math.abs(dx) * box.h > Math.abs(dy) * box.w) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** The side of `box` that the point `p` (on or near its outline) is closest to. */
export function sideOfPoint(box: Box, p: Point): Side {
  const d: Array<[Side, number]> = [
    ["left", Math.abs(p.x - box.x)],
    ["right", Math.abs(p.x - (box.x + box.w))],
    ["top", Math.abs(p.y - box.y)],
    ["bottom", Math.abs(p.y - (box.y + box.h))],
  ];
  return d.sort((a, b) => a[1] - b[1])[0]![0];
}

/** Outline point on `side` shifted `off` px along that side from its middle. */
export function portOnSide(shape: ShapeKind, box: Box, side: Side, off: number): Point {
  const c = center(box);
  const hw = box.w / 2;
  const hh = box.h / 2;
  const horizontal = side === "top" || side === "bottom";
  const half = horizontal ? hw : hh; // half-extent along the side
  const depth = horizontal ? hh : hw; // half-extent across it
  const r = Math.min(1, Math.abs(off) / half);
  const f = shape === "diamond" ? 1 - r : shape === "ellipse" ? Math.sqrt(1 - r * r) : 1;
  const n = NORMAL[side];
  return horizontal ? { x: c.x + off, y: c.y + n.y * depth * f } : { x: c.x + n.x * depth * f, y: c.y + off };
}

/** Drop repeated points, collinear points and spikes that turn back on themselves. */
export function cleanPath(path: Point[]): Point[] {
  const pts = path.slice();
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 1; i < pts.length && !changed; i++) {
      if (pts.length > 2 && len(sub(pts[i]!, pts[i - 1]!)) < MIN_SEGMENT) {
        pts.splice(i === pts.length - 1 ? i - 1 : i, 1);
        changed = true;
      }
    }
    for (let i = 1; i < pts.length - 1 && !changed; i++) {
      const u = sub(pts[i]!, pts[i - 1]!);
      const v = sub(pts[i + 1]!, pts[i]!);
      const cross = Math.abs(u.x * v.y - u.y * v.x) / (len(u) * len(v));
      if (cross < 0.02 || dot(u, v) < 0) {
        pts.splice(i, 1);
        changed = true;
      }
    }
  }
  return pts;
}

/** Route is acceptable when it leaves/enters along the side normals and never turns back. */
export function validRoute(pts: Point[], sa: Side, sb: Side): boolean {
  const n = pts.length;
  if (n < 2) return false;
  const first = sub(pts[1]!, pts[0]!);
  const last = sub(pts[n - 1]!, pts[n - 2]!);
  if (len(first) < MIN_SEGMENT || len(last) < MIN_SEGMENT) return false;
  if (dot(first, NORMAL[sa]) <= 0 || dot(last, NORMAL[sb]) >= 0) return false;
  for (let i = 1; i < n - 1; i++) {
    const u = sub(pts[i]!, pts[i - 1]!);
    const v = sub(pts[i + 1]!, pts[i]!);
    if (len(u) < MIN_SEGMENT || len(v) < MIN_SEGMENT || dot(u, v) < 0) return false;
  }
  return true;
}

export function countHits(pts: Point[], obstacles: RouteNode[]): number {
  let hits = 0;
  for (const o of obstacles) {
    for (let i = 1; i < pts.length; i++) {
      if (segmentHits(pts[i - 1]!, pts[i]!, o.box, T.clearance)) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

/** Does any axis-aligned segment of `pts` run on the same track as one of `placed` (overlapping extent)? */
export function sharesTrack(pts: Point[], placed: Point[][]): boolean {
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    const vert = Math.abs(p.x - q.x) < 0.5;
    const horiz = Math.abs(p.y - q.y) < 0.5;
    if (!vert && !horiz) continue;
    for (const other of placed) {
      for (let j = 1; j < other.length; j++) {
        const r = other[j - 1]!;
        const s = other[j]!;
        if (vert && Math.abs(r.x - s.x) < 0.5 && Math.abs(r.x - p.x) < T.trackGap) {
          if (Math.min(p.y, q.y) < Math.max(r.y, s.y) - 2 && Math.min(r.y, s.y) < Math.max(p.y, q.y) - 2) return true;
        }
        if (horiz && Math.abs(r.y - s.y) < 0.5 && Math.abs(r.y - p.y) < T.trackGap) {
          if (Math.min(p.x, q.x) < Math.max(r.x, s.x) - 2 && Math.min(r.x, s.x) < Math.max(p.x, q.x) - 2) return true;
        }
      }
    }
  }
  return false;
}

/** The stretch of `pts` within HEAD_LEN px of its end (or start) tip, as a polyline starting at the tip. */
export function headWindow(pts: Point[], atEnd: boolean): Point[] {
  const seq = atEnd ? pts.slice().reverse() : pts;
  const out: Point[] = [seq[0]!];
  let left = HEAD_LEN;
  for (let i = 1; i < seq.length && left > 0; i++) {
    const a = seq[i - 1]!;
    const b = seq[i]!;
    const l = len(sub(b, a));
    if (l <= left) {
      out.push(b);
      left -= l;
    } else {
      out.push({ x: a.x + ((b.x - a.x) * left) / l, y: a.y + ((b.y - a.y) * left) / l });
      left = 0;
    }
  }
  return out;
}

/** Footprint of an arrowhead as drawn: this long behind the tip, this wide on each side (the checker's arrowhead-covered rule). */
export const HEAD_FOOT_LEN = 18;
export const HEAD_FOOT_HALF = 8;

/** Axis-aligned box around the arrowhead at the end (or start) of `pts`; undefined for a degenerate route. */
export function headFootprint(pts: Point[], atEnd: boolean): Box | undefined {
  const n = pts.length;
  for (let k = 1; k < n; k++) {
    const tip = atEnd ? pts[n - k]! : pts[k - 1]!;
    const far = atEnd ? pts[n - 1 - k]! : pts[k]!;
    const l = Math.hypot(far.x - tip.x, far.y - tip.y);
    if (l < 1e-6) continue;
    const ux = (far.x - tip.x) / l;
    const uy = (far.y - tip.y) / l;
    const bx = tip.x + ux * HEAD_FOOT_LEN;
    const by = tip.y + uy * HEAD_FOOT_LEN;
    const wx = Math.abs(uy) > 0.5 ? HEAD_FOOT_HALF : 0;
    const wy = Math.abs(ux) > 0.5 ? HEAD_FOOT_HALF : 0;
    const x1 = Math.min(tip.x, bx) - wx;
    const y1 = Math.min(tip.y, by) - wy;
    return { x: x1, y: y1, w: Math.max(tip.x, bx) + wx - x1, h: Math.max(tip.y, by) + wy - y1 };
  }
  return undefined;
}

/** Footprints of the arrowheads of a route (one per end that carries a head). */
export function headFootprints(pts: Point[], heads: [boolean, boolean]): Box[] {
  const out: Box[] = [];
  for (const [i, atEnd] of [[0, false], [1, true]] as const) {
    if (!heads[i]) continue;
    const b = headFootprint(pts, atEnd);
    if (b) out.push(b);
  }
  return out;
}

/** Area of the overlap of two boxes. */
export function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/** Arrowhead windows of a route: one per end that carries a head. */
export function headWindows(pts: Point[], heads: [boolean, boolean]): Point[][] {
  const out: Point[][] = [];
  if (heads[0]) out.push(headWindow(pts, false));
  if (heads[1]) out.push(headWindow(pts, true));
  return out;
}

/** Crossings of the arrowhead windows of `pts` with `placed`, and of the placed routes' windows with `pts` (a head under another arrow). */
export function headCrossings(pts: Point[], heads: [boolean, boolean], placed: Point[][], placedHeads: Array<[boolean, boolean]>): number {
  let n = 0;
  for (const w of headWindows(pts, heads)) n += crossings(w, placed);
  placed.forEach((other, k) => {
    for (const w of headWindows(other, placedHeads[k]!)) n += crossings(pts, [w]);
  });
  return n;
}

/** Ends of `pts` whose straight run is shorter than FINAL_STUB (a two-point route counts once). */
export function shortStubs(pts: Point[]): number {
  const n = pts.length;
  const first = len(sub(pts[1]!, pts[0]!));
  const last = len(sub(pts[n - 1]!, pts[n - 2]!));
  const short = T.finalStub - 0.5;
  return n === 2 ? (first < short ? 1 : 0) : (first < short ? 1 : 0) + (last < short ? 1 : 0);
}

/** Number of proper crossings between the polyline and the already placed routes. */
export function crossings(pts: Point[], placed: Point[][]): number {
  const orient = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    for (const other of placed) {
      for (let j = 1; j < other.length; j++) {
        const p = pts[i - 1]!;
        const q = pts[i]!;
        const r = other[j - 1]!;
        const s = other[j]!;
        if (orient(p, q, r) * orient(p, q, s) < 0 && orient(r, s, p) * orient(r, s, q) < 0) n++;
      }
    }
  }
  return n;
}

/** Rail positions between `lo` and `hi` (either order): the middle first, then outwards in RAIL_PITCH steps. */
export function railOffsets(lo: number, hi: number): number[] {
  const mid = (lo + hi) / 2;
  const room = Math.abs(hi - lo) / 2 - T.railMargin;
  const out = [mid];
  for (let k = 1; k <= MAX_RAILS && k * T.railPitch <= room; k++) out.push(mid + k * T.railPitch, mid - k * T.railPitch);
  return out;
}

/** Orthogonal candidates between two ports: L for mixed sides, Z on rails RAIL_PITCH apart otherwise. */
export function orthogonal(a: Point, b: Point, sa: Side, sb: Side, planned?: number): Point[][] {
  const ha = sa === "left" || sa === "right";
  const hb = sb === "left" || sb === "right";
  if (ha && !hb) return [[a, { x: b.x, y: a.y }, b]];
  if (!ha && hb) return [[a, { x: a.x, y: b.y }, b]];
  const out: Point[][] = [];
  const rails = railOffsets(ha ? a.x : a.y, ha ? b.x : b.y);
  const [lo, hi] = ha ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  if (planned !== undefined && planned > lo + T.railMargin - 4 && planned < hi - T.railMargin + 4) rails.unshift(planned);
  if (ha) {
    for (const x of rails) out.push([a, { x, y: a.y }, { x, y: b.y }, b]);
  } else {
    for (const y of rails) out.push([a, { x: a.x, y }, { x: b.x, y }, b]);
  }
  if (out.length < 3) {
    for (const f of [0.4, 0.6, 0.3, 0.7]) {
      if (ha) out.push([a, { x: a.x + (b.x - a.x) * f, y: a.y }, { x: a.x + (b.x - a.x) * f, y: b.y }, b]);
      else out.push([a, { x: a.x, y: a.y + (b.y - a.y) * f }, { x: b.x, y: a.y + (b.y - a.y) * f }, b]);
    }
  }
  return out;
}
