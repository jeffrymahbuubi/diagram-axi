// A routed diagram as a board of nodes, edge routes and placed edge labels, with the geometric
// defects that make a layout unreadable counted per edge: a label on a node / another label / another
// edge's arrow, an arrow through a node it does not join, and parallel arrows between one pair that
// run too close together. The repair pass (repair.ts) re-routes edges until the count stops falling.

import type { Budget } from "./budget.js";
import type { Box, Point } from "./engine.js";
import { segmentHits } from "./geom.js";
import { zoneViolations, type Zone } from "./zones.js";
import { overlapDepth, rectPoly, segInside, shapePoly, type Poly } from "./poly.js";
import { headCrossings, headFootprints, overlapArea, shortStubs } from "./route-util.js";
import type { RouteNode } from "./route.js";
import { T } from "./tune.js";

export interface BoardEdge {
  index: number;
  from: string;
  to: string;
  route: Point[];
  /** Size of the edge's label (absent without one); `box` is where it is currently placed. */
  label?: { w: number; h: number };
  box?: Box;
  /** Whether the start / end carries an arrowhead (default: end only). */
  heads?: [boolean, boolean];
}

/** A label counts as touching a thing when it penetrates it by more than this many px. */
const LABEL_TOUCH = 0.05;
/** An arrow passing this close to a label box (outside it) counts as touching it. */
const ARROW_GAP = 0.6;
/** Arrow segments this deep inside a node (shrunk by THROUGH_INSET) are defects. */
const THROUGH_INSET = 2;
const THROUGH_DEPTH = 1;
/** Routes keep this far from zone titles. */
const TITLE_PAD = 3;
/** Pairs closer than PARALLEL_DIST along a shared run of PARALLEL_RUN or more are defects. */
const PARALLEL_DIST = 20;
const PARALLEL_RUN = 16;
const PARALLEL_SIN = 0.12;
/** Routes of different node pairs that run parallel (sine below), closer than DIST, over RUN or more are drawn on top of each other. */
const OVERLAP_SIN = 0.05;
const OVERLAP_DIST = 10;
const OVERLAP_RUN = 24;
/** Two arrow ends on one node closer than this (one of them with a head) overlap. */
const CROWDED = 18;
/** Visual (round 5) thresholds, as the checker's R5 rules: share of a head's footprint a label may hide, head pitch, track gap and run, hug distance and run. */
const FOOT_COVER = 0.2;
const FOOT_SHRINK = 2.5;
const HEAD_PITCH = 28;
const TRACK_GAP = 18;
const TRACK_RUN = 40;
const TRACK_SIN = 0.05;
/** Collinear segments of two arrows (within END_DIST) that touch or lie within END_GAP of each other read as one line. */
const END_DIST = 6;
const END_GAP = 10;
const HUG_GAP = 12;
const HUG_RUN = 24;

export interface Score {
  /** Defects involving the edge. */
  hard: number;
  /** Soft cost of the edge's route: proper crossings with other routes, plus (weighted) arrowheads crossed and ends shorter than FINAL_STUB. */
  cross: number;
  /** Other edges involved in a defect with this one. */
  others: Set<number>;
}

/** Polygon of the box last asked about: a probe box is tested against many segments in a row (boxes are never mutated). */
let probed: Box | undefined;
let probedPoly: Poly = [];

function segsHitBox(p: Point, q: Point, b: Box): boolean {
  if (Math.max(p.x, q.x) < b.x || Math.min(p.x, q.x) > b.x + b.w || Math.max(p.y, q.y) < b.y || Math.min(p.y, q.y) > b.y + b.h) return false;
  if (b !== probed) {
    probed = b;
    probedPoly = rectPoly(b);
  }
  return segInside(p, q, probedPoly) > 0 || (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) || (q.x >= b.x && q.x <= b.x + b.w && q.y >= b.y && q.y <= b.y + b.h);
}

const shrunk = (b: Box, d: number): Box => ({ x: b.x + d, y: b.y + d, w: Math.max(0, b.w - 2 * d), h: Math.max(0, b.h - 2 * d) });

function boxDepth(a: Box, b: Box): number {
  return Math.min(Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

function parallelRun(a1: Point, a2: Point, b1: Point, b2: Point, maxSin = PARALLEL_SIN, minRun = PARALLEL_RUN): { dist: number; run: number } | null {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1 || lb < 1) return null;
  if (Math.abs(ax * by - ay * bx) / (la * lb) > maxSin) return null;
  const ux = ax / la;
  const uy = ay / la;
  const s1 = (b1.x - a1.x) * ux + (b1.y - a1.y) * uy;
  const s2 = (b2.x - a1.x) * ux + (b2.y - a1.y) * uy;
  const run = Math.min(la, Math.max(s1, s2)) - Math.max(0, Math.min(s1, s2));
  if (run < minRun) return null;
  const d1 = Math.abs((b1.x - a1.x) * uy - (b1.y - a1.y) * ux);
  const d2 = Math.abs((b2.x - a1.x) * uy - (b2.y - a1.y) * ux);
  return { dist: (d1 + d2) / 2, run };
}

function properCross(p: Point, q: Point, r: Point, s: Point): Point | undefined {
  const d1x = q.x - p.x;
  const d1y = q.y - p.y;
  const d2x = s.x - r.x;
  const d2y = s.y - r.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return undefined;
  const t = ((r.x - p.x) * d2y - (r.y - p.y) * d2x) / den;
  const u = ((r.x - p.x) * d1y - (r.y - p.y) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return undefined;
  return { x: p.x + t * d1x, y: p.y + t * d1y };
}

const pairOf = (e: { from: string; to: string }) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`);

export class Board {
  readonly edges = new Map<number, BoardEdge>();
  private readonly outline = new Map<string, Poly>();
  private readonly inner = new Map<string, Poly>();

  constructor(
    readonly nodes: Map<string, RouteNode>,
    /** Boxes labels must stay off (zone titles). */
    readonly fixed: Box[],
    edges: BoardEdge[],
    /** Zones the labels must respect (zones.ts). */
    readonly zones: readonly Zone[] = [],
    /** Work budget charged by every scan of the board; the repair pass stops once it is exhausted. */
    readonly budget?: Budget,
  ) {
    for (const n of nodes.values()) {
      this.outline.set(n.id, shapePoly(n.shape, n.box));
      this.inner.set(n.id, shapePoly(n.shape, n.box, THROUGH_INSET));
    }
    for (const e of edges) this.edges.set(e.index, e);
  }

  /** Number of route segments on the board (the unit the work budget counts scans in). */
  private segments(): number {
    let n = 0;
    for (const e of this.edges.values()) n += e.route.length - 1;
    return n;
  }

  /** Does a label box clash with a node shape, a fixed box or another placed label (excluding `self`)? */
  labelClashes(box: Box, self: number): number {
    let n = 0;
    this.budget?.spend(3 * (this.outline.size + this.fixed.length + this.edges.size) + 2);
    const poly = rectPoly(box);
    for (const [id, o] of this.outline) {
      const b = this.nodes.get(id)!.box;
      if (boxDepth(box, b) <= LABEL_TOUCH) continue;
      if (overlapDepth(poly, o) > LABEL_TOUCH) n++;
    }
    for (const f of this.fixed) if (boxDepth(box, f) > LABEL_TOUCH) n++;
    for (const e of this.edges.values()) if (e.index !== self && e.box && boxDepth(box, e.box) > LABEL_TOUCH) n++;
    const me = this.edges.get(self);
    if (me) n += zoneViolations(this.zones, me.from, me.to, box);
    return n;
  }

  /** Foreign routes crossing a label box (excluding the routes of `self`). */
  labelArrowHits(box: Box, self: number): number {
    const probe = shrunk(box, -ARROW_GAP);
    let n = 0;
    if (this.budget) this.budget.spend(2 + 2 * this.segments());
    for (const e of this.edges.values()) {
      if (e.index === self) continue;
      for (let i = 1; i < e.route.length; i++) {
        if (segsHitBox(e.route[i - 1]!, e.route[i]!, probe)) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  score(i: number): Score {
    const me = this.edges.get(i)!;
    if (this.budget) {
      // Pair tests of my segments against everyone else's, plus the node and label probes (1 unit ~ 7 ns).
      const mine = me.route.length - 1;
      this.budget.spend(8 * mine * this.segments() + 20 * this.edges.size + 6 * this.inner.size * mine + 4);
    }
    const others = new Set<number>();
    let hard = 0;
    const flag = (j: number) => {
      hard++;
      others.add(j);
    };
    if (me.box) {
      const poly = rectPoly(me.box);
      for (const [id, o] of this.outline) {
        const b = this.nodes.get(id)!.box;
        if (boxDepth(me.box, b) <= LABEL_TOUCH) continue;
        if (overlapDepth(poly, o) > LABEL_TOUCH) hard++;
      }
      for (const f of this.fixed) if (boxDepth(me.box, f) > LABEL_TOUCH) hard++;
      hard += zoneViolations(this.zones, me.from, me.to, me.box);
      for (const e of this.edges.values()) {
        if (e.index !== i && e.box && boxDepth(me.box, e.box) > LABEL_TOUCH) flag(e.index);
      }
      const probe = shrunk(me.box, -ARROW_GAP);
      for (const e of this.edges.values()) {
        if (e.index === i) continue;
        for (let k = 1; k < e.route.length; k++) {
          if (segsHitBox(e.route[k - 1]!, e.route[k]!, probe)) {
            flag(e.index);
            break;
          }
        }
      }
    }
    // other labels hit by my route
    for (const e of this.edges.values()) {
      if (e.index === i || !e.box) continue;
      const probe = shrunk(e.box, -ARROW_GAP);
      for (let k = 1; k < me.route.length; k++) {
        if (segsHitBox(me.route[k - 1]!, me.route[k]!, probe)) {
          flag(e.index);
          break;
        }
      }
    }
    // my route through nodes it does not join
    for (const [id, o] of this.inner) {
      if (id === me.from || id === me.to) continue;
      let worst = 0;
      for (let k = 1; k < me.route.length; k++) worst = Math.max(worst, segInside(me.route[k - 1]!, me.route[k]!, o));
      if (worst > THROUGH_DEPTH) hard++;
    }
    // my route across a zone title
    for (const f of this.fixed) {
      for (let k = 1; k < me.route.length; k++) {
        if (segmentHits(me.route[k - 1]!, me.route[k]!, f, TITLE_PAD)) {
          hard++;
          break;
        }
      }
    }
    // parallel arrows of the same node pair
    const key = me.from < me.to ? `${me.from}|${me.to}` : `${me.to}|${me.from}`;
    let cross = 0;
    for (const e of this.edges.values()) {
      if (e.index === i) continue;
      if (e.from !== e.to && me.from !== me.to) {
        const k2 = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
        if (k2 === key && this.tooClose(me.route, e.route)) flag(e.index);
      }
      cross += this.crossings(me.route, e.route);
      if (T.headCross) cross += T.headCross * headCrossings(me.route, me.heads ?? [false, true], [e.route], [e.heads ?? [false, true]]);
      if (this.stacked(me, e)) flag(e.index);
      if (this.crowded(me, e)) flag(e.index);
    }
    if (T.stubCost) cross += T.stubCost * shortStubs(me.route);
    return { hard, cross, others };
  }

  /**
   * Visual defects of edge `i` (SOFT in the checker, so they never count as HARD): its arrowheads under a label or
   * another arrow, its label or route over another arrow's head, heads closer than a pitch, parallel tracks too
   * close, a route running along the side of one of its own nodes. `others` are the edges involved.
   */
  visual(i: number): { n: number; others: Set<number> } {
    const me = this.edges.get(i)!;
    const others = new Set<number>();
    let n = 0;
    const flag = (j?: number) => {
      n++;
      if (j !== undefined && j !== i) others.add(j);
    };
    const mine = headFootprints(me.route, me.heads ?? [false, true]);
    if (this.budget) this.budget.spend(40 * (me.route.length - 1) * this.segments() + 60 * this.edges.size + 40 * this.nodes.size * (me.route.length - 1) + 8);
    const ends = (b: BoardEdge) => [
      { id: b.from, p: b.route[0]!, head: b.heads?.[0] ?? false },
      { id: b.to, p: b.route[b.route.length - 1]!, head: b.heads?.[1] ?? true },
    ];
    const routeThrough = (route: Point[], f: Box): boolean => {
      const inner = shrunk(f, FOOT_SHRINK);
      if (inner.w <= 0 || inner.h <= 0) return false;
      for (let k = 1; k < route.length; k++) if (segsHitBox(route[k - 1]!, route[k]!, inner)) return true;
      return false;
    };
    for (const e of this.edges.values()) {
      // my heads under e's label (e may be me) or e's route
      for (const f of mine) {
        if (e.box && overlapArea(f, e.box) > FOOT_COVER * f.w * f.h) flag(e.index);
        if (e.index !== i && routeThrough(e.route, f)) flag(e.index);
      }
      if (e.index === i) continue;
      // e's heads under my label or my route
      for (const f of headFootprints(e.route, e.heads ?? [false, true])) {
        if (me.box && overlapArea(f, me.box) > FOOT_COVER * f.w * f.h) flag(e.index);
        if (routeThrough(me.route, f)) flag(e.index);
      }
      // heads closer than a pitch on one node
      let close = false;
      for (const p of ends(me)) {
        for (const q of ends(e)) {
          if (p.id === q.id && (p.head || q.head) && Math.hypot(p.p.x - q.p.x, p.p.y - q.p.y) < HEAD_PITCH - 0.5) close = true;
        }
      }
      if (close) flag(e.index);
      // tracks too close
      let tight = false;
      for (let x = 1; x < me.route.length && !tight; x++) {
        for (let y = 1; y < e.route.length && !tight; y++) {
          const r = parallelRun(me.route[x - 1]!, me.route[x]!, e.route[y - 1]!, e.route[y]!, TRACK_SIN, -END_GAP);
          if (r && ((r.run >= TRACK_RUN && r.dist < TRACK_GAP - 0.5) || r.dist < END_DIST - 0.5)) tight = true;
        }
      }
      if (tight) flag(e.index);
    }
    // a run along the side of a node that is not mine (reads as running through it), as the checker's node-edge-graze
    for (const [id, node] of this.nodes) {
      if (id === me.from || id === me.to || node.shape === "ellipse") continue;
      const poly = this.outline.get(id)!;
      let graze = false;
      for (let x = 1; x < me.route.length && !graze; x++) {
        for (let k = 0; k < poly.length && !graze; k++) {
          const r = parallelRun(me.route[x - 1]!, me.route[x]!, poly[k]!, poly[(k + 1) % poly.length]!, TRACK_SIN, HUG_RUN);
          if (r && r.dist < HUG_GAP - 0.5) graze = true;
        }
      }
      if (graze) flag();
    }
    // a run along a zone border (it reads as part of the border), as the checker's node-edge-graze
    for (const z of this.zones) {
      const b = z.box;
      const loop = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
      let graze = false;
      for (let x = 1; x < me.route.length && !graze; x++) {
        for (let k = 0; k < 4 && !graze; k++) {
          const r = parallelRun(me.route[x - 1]!, me.route[x]!, loop[k]!, loop[(k + 1) % 4]!, TRACK_SIN, HUG_RUN);
          if (r && r.dist < HUG_GAP - 0.5) graze = true;
        }
      }
      if (graze) flag();
    }
    // a run along the side of one of my own nodes (it then enters from the far side: it reads like a self-loop)
    if (me.from !== me.to) {
      for (const id of [me.from, me.to]) {
        const node = this.nodes.get(id);
        const poly = this.outline.get(id);
        if (!node || !poly || node.shape === "ellipse") continue;
        let hug = false;
        for (let x = 1; x < me.route.length && !hug; x++) {
          for (let k = 0; k < poly.length && !hug; k++) {
            const r = parallelRun(me.route[x - 1]!, me.route[x]!, poly[k]!, poly[(k + 1) % poly.length]!, TRACK_SIN, HUG_RUN);
            if (r && r.dist < HUG_GAP - 0.5) hug = true;
          }
        }
        if (hug) flag();
      }
    }
    return { n, others };
  }

  /** Routes of different node pairs (or two loops) drawn on top of each other. */
  private stacked(a: BoardEdge, b: BoardEdge): boolean {
    const loop = a.from === a.to;
    if (!loop && pairOf(a) === pairOf(b)) return false;
    for (let x = 1; x < a.route.length; x++) {
      for (let y = 1; y < b.route.length; y++) {
        const r = parallelRun(a.route[x - 1]!, a.route[x]!, b.route[y - 1]!, b.route[y]!, OVERLAP_SIN, OVERLAP_RUN);
        if (r && r.dist < OVERLAP_DIST) return true;
      }
    }
    return false;
  }

  /** Arrow ends of two edges on one node that are closer than an arrowhead is wide (one of them with a head). */
  private crowded(a: BoardEdge, b: BoardEdge): boolean {
    const ends = (e: BoardEdge) => [
      { id: e.from, p: e.route[0]!, head: e.heads?.[0] ?? false },
      { id: e.to, p: e.route[e.route.length - 1]!, head: e.heads?.[1] ?? true },
    ];
    for (const p of ends(a)) {
      for (const q of ends(b)) {
        if (p.id === q.id && (p.head || q.head) && Math.hypot(p.p.x - q.p.x, p.p.y - q.p.y) < CROWDED) return true;
      }
    }
    return false;
  }

  private tooClose(a: Point[], b: Point[]): boolean {
    for (let x = 1; x < a.length; x++) {
      for (let y = 1; y < b.length; y++) {
        const r = parallelRun(a[x - 1]!, a[x]!, b[y - 1]!, b[y]!);
        if (r && r.dist < PARALLEL_DIST) return true;
      }
    }
    return false;
  }

  private crossings(a: Point[], b: Point[]): number {
    const ends = [a[0]!, a[a.length - 1]!, b[0]!, b[b.length - 1]!];
    let n = 0;
    for (let x = 1; x < a.length; x++) {
      for (let y = 1; y < b.length; y++) {
        const hit = properCross(a[x - 1]!, a[x]!, b[y - 1]!, b[y]!);
        if (hit && !ends.some((p) => Math.hypot(p.x - hit.x, p.y - hit.y) < 3)) n++;
      }
    }
    return n;
  }

  /** Indexes of edges that take part in at least one defect, ascending. */
  defective(): number[] {
    const out: number[] = [];
    for (const i of this.edges.keys()) if (this.score(i).hard > 0) out.push(i);
    return out.sort((a, b) => a - b);
  }

  /** Total number of defects (each counted once from each side, which is fine for comparisons). */
  totalHard(): number {
    let n = 0;
    for (const i of this.edges.keys()) n += this.score(i).hard;
    return n;
  }
}
