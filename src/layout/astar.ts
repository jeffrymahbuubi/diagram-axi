// Orthogonal A* router used by the repair pass: finds a bend-light polyline between two ports that
// keeps clear of the nodes, avoids crossing and running along routes that are already placed, and
// stays apart from routes of the same node pair. The search runs on the grid formed by the
// interesting coordinates (node edges grown by a margin, gap midpoints, port stubs, lanes beside the
// same pair's routes), so results are short, axis-aligned and deterministic.

import type { Box, Point } from "./engine.js";
import { segmentHits } from "./geom.js";
import type { Budget } from "./budget.js";
import { NORMAL, cleanPath, type Side } from "./route-util.js";
import { T } from "./tune.js";

const BEND_COST = 30;
const CROSS_COST = 60;
/** Per px of an overlapping run next to another route / next to a route of the same node pair. */
const SHARE_COST = 3;
const SAME_PAIR_COST = 5;
/** Same-pair routes closer than this (and overlapping) are penalized; other routes use SHARE_GAP. */
const SAME_PAIR_GAP = 28;
/** Grid lines laid beside the long runs of placed routes (T.shareGap + 0.5 off, so a route on one clears the share gap), at most T.maxLanes per axis. */
const LANE_MIN_RUN = 60;
/** A lane within LANE_NEAR of an existing grid line is skipped (two lines a few px apart make the route jog between them). */
const LANE_NEAR = 6;
/** Runs along a zone border closer than ZONE_GAP cost ZONE_COST per px (a route hugging a border reads as part of it). */
const ZONE_GAP = 12;
const ZONE_COST = 3;
/** Runs along the side of one of the route's own nodes closer than HUG_GAP cost T.hugCost per px. */
const HUG_GAP = 12;
/** Extra price of crossing the stretch of a placed route right behind its arrowhead (an arrow over a head reads as one blob). */
const HEAD_CROSS_COST = 120;
/** Shortest stub tried when no route with the full stub (T.astarStub) exists (tight spots between nodes). */
export const SHORT_STUB = 12;

export interface AStarInput {
  /** Port on the start node outline, the side it sits on, and the same for the end. */
  pa: Point;
  sa: Side;
  pb: Point;
  sb: Side;
  /** Node boxes the route must stay out of; `ends` are the two the route joins (kept clear by 1 px only). */
  obstacles: Box[];
  ends: Box[];
  margin: number;
  /** Routes already placed (crossings / shared tracks) and those of the same node pair (spacing). */
  placed: Point[][];
  samePair: Point[][];
  /** Zone borders as closed polylines: running along one closer than ZONE_GAP is penalized (crossing it is free). */
  borders?: Point[][];
  /** Arrowhead windows of the placed routes (headWindows in route-util): crossing one costs extra. */
  heads?: Point[][];
  /** Search window: ports' bounding box grown by this much (larger when the first try finds nothing). */
  window: number;
  /** Work budget charged per expansion; the search gives up (no route) once it is exhausted. */
  budget?: Budget;
  /** Length of the straight stub at each port (default T.astarStub). */
  stub?: number;
  /** Price (T.hugCost) runs along the sides of the two end nodes: only the polish pass asks, it makes the search dearer. */
  hug?: boolean;
}

const DIRS: Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];
const dirOf = (n: Point) => DIRS.findIndex((d) => d.x === n.x && d.y === n.y);

/** Binary min-heap of (f, g, id) entries in parallel typed arrays; ties break on g, then id (a deterministic order). */
class Heap {
  private f = new Float64Array(256);
  private g = new Float64Array(256);
  private id = new Int32Array(256);
  size = 0;
  private less(i: number, j: number): boolean {
    return (this.f[i]! - this.f[j]! || this.g[i]! - this.g[j]! || this.id[i]! - this.id[j]!) < 0;
  }
  private swap(i: number, j: number) {
    const { f, g, id } = this;
    const tf = f[i]!;
    const tg = g[i]!;
    const ti = id[i]!;
    f[i] = f[j]!;
    g[i] = g[j]!;
    id[i] = id[j]!;
    f[j] = tf;
    g[j] = tg;
    id[j] = ti;
  }
  push(f: number, g: number, id: number) {
    if (this.size === this.f.length) {
      const grow = <T extends Float64Array | Int32Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.f = grow(this.f);
      this.g = grow(this.g);
      this.id = grow(this.id);
    }
    let i = this.size++;
    this.f[i] = f;
    this.g[i] = g;
    this.id[i] = id;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** Removes the smallest entry; its g and id are left in `topG` / `topId`. */
  topG = 0;
  topId = 0;
  pop(): void {
    this.topG = this.g[0]!;
    this.topId = this.id[0]!;
    const last = --this.size;
    if (last > 0) {
      this.f[0] = this.f[last]!;
      this.g[0] = this.g[last]!;
      this.id[0] = this.id[last]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < last && this.less(l, m)) m = l;
        if (r < last && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
  }
}

function uniqueSorted(v: number[]): number[] {
  const s = [...v].sort((p, q) => p - q);
  const out: number[] = [];
  for (const x of s) if (!out.length || x - out[out.length - 1]! > 0.5) out.push(Math.round(x * 10) / 10);
  return out;
}

/** Make the grid line nearest to `v` (within 1 px) exactly `v`, so ports are hit exactly. */
function snap(lines: number[], v: number): void {
  const i = lines.findIndex((l) => Math.abs(l - v) < 1);
  if (i >= 0) lines[i] = v;
}

/** Coordinates worth running a line along: grown node edges, midpoints of wide gaps, stubs and lanes. */
function gridLines(inp: AStarInput, p0: Point, p1: Point, axis: "x" | "y", lo: number, hi: number, olo: number, ohi: number): number[] {
  const boxes = [...inp.obstacles, ...inp.ends];
  const start = axis === "x" ? "x" : "y";
  const size = axis === "x" ? "w" : "h";
  const raw: number[] = [p0[start], p1[start], (p0[start] + p1[start]) / 2];
  const edges: number[] = [];
  for (const b of boxes) {
    raw.push(b[start] - inp.margin, b[start] + b[size] + inp.margin);
    edges.push(b[start], b[start] + b[size]);
  }
  const sorted = [...edges].sort((p, q) => p - q);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap > 2 * inp.margin + 16) raw.push((sorted[i]! + sorted[i - 1]!) / 2);
  }
  // lanes beside routes of the same pair
  for (const r of inp.samePair) {
    for (let i = 1; i < r.length; i++) {
      const p = r[i - 1]!;
      const q = r[i]!;
      const fixedAxis = axis === "x" ? Math.abs(p.x - q.x) < 0.5 : Math.abs(p.y - q.y) < 0.5;
      if (!fixedAxis) continue;
      const v = p[start];
      raw.push(v - 2 * SAME_PAIR_GAP, v - SAME_PAIR_GAP, v + SAME_PAIR_GAP, v + 2 * SAME_PAIR_GAP);
    }
  }
  // lanes beside the long runs of other placed routes: without them a route can only share a track or sit on a node-edge line
  const other = axis === "x" ? "y" : "x";
  const lanes: Array<{ v: number; run: number }> = [];
  for (const r of inp.placed) {
    for (let i = 1; i < r.length; i++) {
      const p = r[i - 1]!;
      const q = r[i]!;
      if (Math.abs(p[start] - q[start]) >= 0.5) continue;
      const run = Math.abs(p[other] - q[other]);
      if (run < LANE_MIN_RUN || Math.max(p[other], q[other]) < olo || Math.min(p[other], q[other]) > ohi || p[start] < lo - T.shareGap || p[start] > hi + T.shareGap) continue;
      lanes.push({ v: p[start], run });
    }
  }
  lanes.sort((a, b) => Math.abs(a.v - raw[2]!) - Math.abs(b.v - raw[2]!) || b.run - a.run || a.v - b.v);
  const fixed = raw.slice();
  let taken = 0;
  for (const l of lanes) {
    if (taken >= T.maxLanes) break;
    for (const v of [l.v - T.shareGap - 0.5, l.v + T.shareGap + 0.5]) {
      if (v < lo || v > hi || fixed.some((f) => Math.abs(f - v) < LANE_NEAR)) continue;
      raw.push(v);
      fixed.push(v);
      taken++;
    }
  }
  return uniqueSorted(raw.filter((v) => v >= lo && v <= hi));
}

/** Route segments sorted by direction once per search, so a step only visits the segments that can affect it. */
interface Segs {
  /** Horizontal / vertical segments as flat (fixed coordinate, from, to) triples; a zero-length one is in both. */
  h: number[];
  v: number[];
  /** Diagonals as flat (ax, ay, bx, by) quadruples. */
  d: number[];
  /** Number of segments, the cost of scanning them. */
  count: number;
}

/** Sort the segments of `routes` that come within `slack` of the box `[x1,x2]x[y1,y2]` (the others cannot touch any step). */
function classify(routes: Point[][], x1: number, y1: number, x2: number, y2: number, slack: number): Segs {
  const out: Segs = { h: [], v: [], d: [], count: 0 };
  for (const r of routes) {
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1]!;
      const b = r[i]!;
      if (Math.max(a.x, b.x) < x1 - slack || Math.min(a.x, b.x) > x2 + slack || Math.max(a.y, b.y) < y1 - slack || Math.min(a.y, b.y) > y2 + slack) continue;
      const aHoriz = Math.abs(a.y - b.y) < 0.5;
      const aVert = Math.abs(a.x - b.x) < 0.5;
      if (aHoriz) out.h.push(a.y, Math.min(a.x, b.x), Math.max(a.x, b.x));
      if (aVert) out.v.push(a.x, Math.min(a.y, b.y), Math.max(a.y, b.y));
      if (!aHoriz && !aVert) out.d.push(a.x, a.y, b.x, b.y);
      out.count++;
    }
  }
  return out;
}

/** Total penalty for running the axis-aligned unit step (px,py)-(qx,qy) next to / across the other routes. */
function stepPenalty(px: number, py: number, qx: number, qy: number, placed: Segs, same: Segs, border: Segs, heads: Segs, own: Segs): number {
  let cost = 0;
  const horiz = Math.abs(py - qy) < 0.5;
  const lo = horiz ? Math.min(px, qx) : Math.min(py, qy);
  const hi = horiz ? Math.max(px, qx) : Math.max(py, qy);
  const fixedV = horiz ? py : px;
  // runs next to the other routes (parallel segments within `gap`), priced per px
  const scan = (list: number[], gap: number, price: number) => {
    for (let k = 0; k < list.length; k += 3) {
      const run = Math.min(hi, list[k + 2]!) - Math.max(lo, list[k + 1]!);
      if (Math.abs(list[k]! - fixedV) < gap && run > 3) cost += price * run;
    }
  };
  scan(horiz ? placed.h : placed.v, T.shareGap, SHARE_COST);
  scan(horiz ? same.h : same.v, SAME_PAIR_GAP, SAME_PAIR_COST);
  scan(horiz ? border.h : border.v, ZONE_GAP, ZONE_COST);
  if (own.count) scan(horiz ? own.h : own.v, HUG_GAP, T.hugCost);
  // proper crossings: a perpendicular segment passing through the step
  const cross = horiz ? placed.v : placed.h;
  for (let k = 0; k < cross.length; k += 3) {
    const v = cross[k]!;
    if (v > lo + 1 && v < hi - 1 && fixedV > cross[k + 1]! + 1 && fixedV < cross[k + 2]! - 1) cost += CROSS_COST;
  }
  const hcross = horiz ? heads.v : heads.h;
  for (let k = 0; k < hcross.length; k += 3) {
    const v = hcross[k]!;
    if (v > lo + 1 && v < hi - 1 && fixedV > hcross[k + 1]! + 1 && fixedV < hcross[k + 2]! - 1) cost += HEAD_CROSS_COST;
  }
  // diagonal: a crossing when the step really intersects it
  const diag = placed.d;
  for (let k = 0; k < diag.length; k += 4) {
    const ax = diag[k]!;
    const ay = diag[k + 1]!;
    const d1x = qx - px;
    const d1y = qy - py;
    const d2x = diag[k + 2]! - ax;
    const d2y = diag[k + 3]! - ay;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) > 1e-9) {
      const t = ((ax - px) * d2y - (ay - py) * d2x) / den;
      const u = ((ax - px) * d1y - (ay - py) * d1x) / den;
      if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) cost += CROSS_COST;
    }
  }
  return cost;
}

/** Route from `pa` (leaving by side `sa`) to `pb` (entering by side `sb`); undefined when blocked. */
export function astarRoute(inp: AStarInput): Point[] | undefined {
  if (inp.budget?.exhausted) return undefined;
  const na = NORMAL[inp.sa];
  const nb = NORMAL[inp.sb];
  const stub = inp.stub ?? T.astarStub;
  const s0: Point = { x: inp.pa.x + na.x * stub, y: inp.pa.y + na.y * stub };
  const g0: Point = { x: inp.pb.x + nb.x * stub, y: inp.pb.y + nb.y * stub };
  const pad = Math.max(1, inp.margin - 1);
  const blocks: Array<{ box: Box; pad: number }> = [
    ...inp.obstacles.map((box) => ({ box, pad })),
    ...inp.ends.map((box) => ({ box, pad: 1 })),
  ];
  if (blocks.some((b) => segmentHits(s0, s0, b.box, b.pad)) || blocks.some((b) => segmentHits(g0, g0, b.box, b.pad))) return undefined;

  const x1 = Math.min(s0.x, g0.x) - inp.window;
  const x2 = Math.max(s0.x, g0.x) + inp.window;
  const y1 = Math.min(s0.y, g0.y) - inp.window;
  const y2 = Math.max(s0.y, g0.y) + inp.window;
  const xs = gridLines(inp, s0, g0, "x", x1, x2, y1, y2);
  const ys = gridLines(inp, s0, g0, "y", y1, y2, x1, x2);
  snap(xs, s0.x);
  snap(xs, g0.x);
  snap(ys, s0.y);
  snap(ys, g0.y);
  const X = xs.length;
  const Y = ys.length;
  const ix0 = xs.findIndex((v) => Math.abs(v - s0.x) < 0.6);
  const iy0 = ys.findIndex((v) => Math.abs(v - s0.y) < 0.6);
  const ixg = xs.findIndex((v) => Math.abs(v - g0.x) < 0.6);
  const iyg = ys.findIndex((v) => Math.abs(v - g0.y) < 0.6);
  if (ix0 < 0 || iy0 < 0 || ixg < 0 || iyg < 0) return undefined;

  // Only what comes near the grid can touch a step: boxes and route segments farther out are left out of the scans.
  const gx1 = xs[0]!;
  const gx2 = xs[X - 1]!;
  const gy1 = ys[0]!;
  const gy2 = ys[Y - 1]!;
  const near = blocks.filter(({ box: b, pad: pd }) => b.x - pd <= gx2 && b.x + b.w + pd >= gx1 && b.y - pd <= gy2 && b.y + b.h + pd >= gy1);
  const blocked = (p: Point, q: Point) => {
    for (const b of near) if (segmentHits(p, q, b.box, b.pad)) return true;
    return false;
  };
  const placed = classify(inp.placed, gx1, gy1, gx2, gy2, SAME_PAIR_GAP + 2);
  const same = classify(inp.samePair, gx1, gy1, gx2, gy2, SAME_PAIR_GAP + 2);
  const border = classify(inp.borders ?? [], gx1, gy1, gx2, gy2, ZONE_GAP + 2);
  const heads = classify(inp.heads ?? [], gx1, gy1, gx2, gy2, 2);
  const own = T.hugCost && inp.hug
    ? classify(inp.ends.map((b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }]), gx1, gy1, gx2, gy2, HUG_GAP + 2)
    : classify([], 0, 0, 0, 0, 0);
  const blockWork = near.length + 1;
  const penaltyWork = placed.count + same.count + border.count + heads.count + own.count + 1;
  const budget = inp.budget;

  const total = X * Y * 4;
  inp.budget?.spend(40 + total / 8);
  const gBest = new Float64Array(total).fill(Infinity);
  const from = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const heap = new Heap();
  const hx = Float64Array.from(xs, (v) => Math.abs(v - g0.x));
  const hy = Float64Array.from(ys, (v) => Math.abs(v - g0.y));
  const sid = (ix: number, iy: number, d: number) => (iy * X + ix) * 4 + d;
  const h = (ix: number, iy: number) => hx[ix]! + hy[iy]!;
  const dEnd = (dirOf(nb) + 2) % 4; // heading into the end port
  const dStart = dirOf(na);
  const start = sid(ix0, iy0, dStart);
  gBest[start] = 0;
  heap.push(h(ix0, iy0), 0, start);
  const stepCache = new Float64Array(total).fill(NaN); // (from point, dir) -> cost, -1 blocked, NaN not yet known
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  // Whether the unit step from (ix,iy) in direction nd to (jx,jy) is free of the boxes, found once per step.
  const blk = new Uint8Array(total); // 0 not yet known, 1 free, 2 blocked
  const free = (ix: number, iy: number, nd: number, jx: number, jy: number): boolean => {
    const k = sid(ix, iy, nd);
    let b = blk[k]!;
    if (!b) {
      budget?.spend(blockWork);
      b = blocked({ x: xs[ix]!, y: ys[iy]! }, { x: xs[jx]!, y: ys[jy]! }) ? 2 : 1;
      blk[k] = b;
    }
    return b === 1;
  };
  // A route exists exactly when the goal cell can be reached over free steps (a walk never needs to turn back on
  // itself, and the first move may not leave against the port's direction). Failing searches are by far the most
  // common, and this finds them without pricing any step or touching the heap.
  const seen = new Uint8Array(X * Y);
  const stack = [iy0 * X + ix0];
  seen[iy0 * X + ix0] = 1;
  let reached = ix0 === ixg && iy0 === iyg;
  while (stack.length && !reached) {
    const cell = stack.pop()!;
    const cx = cell % X;
    const cy = (cell - cx) / X;
    for (let nd = 0; nd < 4 && !reached; nd++) {
      if (cell === iy0 * X + ix0 && nd === (dStart + 2) % 4) continue;
      const jx = cx + DX[nd]!;
      const jy = cy + DY[nd]!;
      if (jx < 0 || jy < 0 || jx >= X || jy >= Y || seen[jy * X + jx] || !free(cx, cy, nd, jx, jy)) continue;
      seen[jy * X + jx] = 1;
      if (jx === ixg && jy === iyg) reached = true;
      else stack.push(jy * X + jx);
    }
  }
  if (!reached) return undefined;

  let goal = -1;
  while (heap.size) {
    if (budget) {
      if (budget.exhausted) return undefined;
      budget.spend(6);
    }
    heap.pop();
    const g = heap.topG;
    const id = heap.topId;
    if (closed[id]) continue;
    closed[id] = 1;
    const d = id % 4;
    const cell = (id - d) / 4;
    const ix = cell % X;
    const iy = (cell - ix) / X;
    if (ix === ixg && iy === iyg) {
      // arriving at the end stub: the last move into the port may bend once
      goal = id;
      break;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const jx = ix + DX[nd]!;
      const jy = iy + DY[nd]!;
      if (jx < 0 || jy < 0 || jx >= X || jy >= Y) continue;
      // never enter the end stub point heading away from the port: cleanPath would cut that spike and leave a stub shorter than STUB
      if (jx === ixg && jy === iyg && nd === (dEnd + 2) % 4) continue;
      const key = sid(ix, iy, nd);
      let step = stepCache[key]!;
      if (step !== step) {
        const px = xs[ix]!;
        const py = ys[iy]!;
        const qx = xs[jx]!;
        const qy = ys[jy]!;
        if (free(ix, iy, nd, jx, jy)) {
          budget?.spend(penaltyWork);
          step = Math.abs(qx - px) + Math.abs(qy - py) + stepPenalty(px, py, qx, qy, placed, same, border, heads, own);
        } else step = -1;
        stepCache[key] = step;
      }
      if (step < 0) continue;
      let cost = g + step + (nd !== d ? BEND_COST : 0);
      if (jx === ixg && jy === iyg && nd !== dEnd) cost += BEND_COST;
      const nid = sid(jx, jy, nd);
      if (closed[nid] || cost >= gBest[nid]!) continue;
      gBest[nid] = cost;
      from[nid] = id;
      heap.push(cost + h(jx, jy), cost, nid);
    }
  }
  if (goal < 0) return undefined;
  const pts: Point[] = [];
  for (let id = goal; id >= 0; id = from[id]!) {
    const d = id % 4;
    const cell = (id - d) / 4;
    const ix = cell % X;
    pts.push({ x: xs[ix]!, y: ys[(cell - ix) / X]! });
  }
  pts.reverse();
  const path = cleanPath([inp.pa, ...pts, inp.pb]);
  return path.length >= 2 ? path : undefined;
}
