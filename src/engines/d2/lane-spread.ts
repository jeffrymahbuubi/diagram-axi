// Post-layout lane spreading for ELK's orthogonal routes. ELK packs parallel edge segments 10 px apart (or on top of each
// other) and lands many arrowheads within a few px on one node side. This pass nudges single segments sideways: the
// segment's two corners move together, so a route stays orthogonal, and a segment that touches a node slides along the
// node's border (the end is re-projected onto the outline). A move is kept only when it lowers the number of crowding
// violations of that edge against all others without making it pass through a node; otherwise the route is left as laid out.
// Runs before label placement, so labels and zone titles are placed on the final routes. Edges are never merged or re-routed.

import { segInsideLength } from "../../quality/geom.js";
import { attach, outlineOf, type Outline, type Pt } from "./lane-shapes.js";
import type { D2Connection, D2Diagram } from "./wasm.js";

const TITLE_ID = /^d2_title_*$/;
const LIFELINE_ID = /^\(.* -- \)\[\d+\]$/;

/** Wanted clearance (px) between parallel segments of arrows between different node pairs (the checker's track-spacing line), and the overlap that counts. */
const LANE_GAP = 18;
const LANE_RUN = 20;
/** Same for arrows between the same two nodes. */
const PAIR_GAP = 22;
const PAIR_RUN = 14;
/** The checker's parallel-edges-close line (HARD): same-pair arrows closer than this over a run this long. A move into it costs HARD_COST. */
const PAIR_HARD = 20.5;
const PAIR_HARD_RUN = 16;
const HARD_COST = 4;
/** The checker's arrowheads-crowded line for D2 (head breadth 12 + 6), with a hair of margin. */
const HEAD_HARD = 18.5;
/** Wanted distance (px) between two arrow ends on one node. */
const END_GAP = 20;
/** Shortest segment kept in the middle of a route, and at an end (room for the arrowhead). */
const MIN_SEG = 6;
const MIN_END = 12;
/** An arrow may not run this far (px) inside a node it does not end on, or inside its own node away from its ends. */
const THROUGH = 1.5;
const OWN_THROUGH = 3;

/** Margin (px) kept between a label and the arrow next to its own, and the most room one label may ask for. */
const LABEL_ROOM = 3;
const LABEL_ROOM_MAX = 60;

const DELTAS = [6, 12, 18, 24, 32, 44, 56];
const MAX_SWEEPS = 8;

interface Route {
  c: D2Connection;
  pts: Pt[];
  /** Bounding box of `pts`, to skip pairs that are far apart. */
  bb: [number, number, number, number];
  pair: string;
  loop: boolean;
  /** Orthogonal polyline that may be edited. */
  editable: boolean;
  head: [boolean, boolean];
}

export interface LaneStats {
  edges: number;
  moved: number;
  before: number;
  after: number;
}

const vertical = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) < 1e-4;
const horizontal = (a: Pt, b: Pt): boolean => Math.abs(a[1] - b[1]) < 1e-4;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const bbox = (pts: Pt[]): [number, number, number, number] => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
/** Pairs whose boxes are further apart than every threshold above cannot violate anything. */
const FAR = 70;

/** ELK's routes drift by a fraction of a px (1080 -> 1080.166 over 600 px of "vertical"); this much is snapped straight. */
const SNAP = 1.5;

/**
 * Snaps near-vertical and near-horizontal segments straight, drops repeated points and the middle points of straight
 * runs; undefined when a segment is neither vertical nor horizontal.
 */
export function orthogonal(route: { x: number; y: number }[]): Pt[] | undefined {
  const pts: Pt[] = [];
  for (const p of route) {
    const q: Pt = [p.x, p.y];
    const last = pts[pts.length - 1];
    if (last) {
      const dx = Math.abs(last[0] - q[0]);
      const dy = Math.abs(last[1] - q[1]);
      if (dx <= SNAP && dy <= SNAP) continue; // a repeated point
      if (dx <= SNAP && dy > SNAP) q[0] = last[0];
      else if (dy <= SNAP && dx > SNAP) q[1] = last[1];
    }
    pts.push(q);
  }
  for (let i = 1; i < pts.length; i++) if (!vertical(pts[i - 1]!, pts[i]!) && !horizontal(pts[i - 1]!, pts[i]!)) return undefined;
  for (let i = pts.length - 2; i >= 1; i--) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    if ((vertical(a, b) && vertical(b, c)) || (horizontal(a, b) && horizontal(b, c))) pts.splice(i, 1);
  }
  return pts.length >= 2 ? pts : undefined;
}

/** Half the label of `r` across a lane (plus a margin), when the lane is long enough to hold it; 0 otherwise. */
function room(r: Route, v: boolean, shared: number): number {
  const w = r.c.label ? (r.c.labelWidth ?? 0) : 0;
  const h = r.c.label ? (r.c.labelHeight ?? 0) : 0;
  if (shared < (v ? h : w)) return 0;
  return Math.min(LABEL_ROOM_MAX, (v ? w : h) / 2 + LABEL_ROOM);
}

/** Overlap length of the extents of two parallel segments. */
function run(a: Pt, b: Pt, c: Pt, d: Pt, v: boolean): number {
  const i = v ? 1 : 0;
  return Math.min(Math.max(a[i], b[i]), Math.max(c[i], d[i])) - Math.max(Math.min(a[i], b[i]), Math.min(c[i], d[i]));
}

/**
 * Moves segment `k` of `pts` sideways by `delta` (an end segment slides along its node's border). Undefined when the result
 * would flip or shrink a neighbouring segment, or an end cannot be put on its node.
 */
export function shiftSegment(pts: Pt[], k: number, delta: number, src: Outline | undefined, dst: Outline | undefined): Pt[] | undefined {
  const m = pts.length - 1;
  const out = pts.map((p): Pt => [p[0], p[1]]);
  const v = vertical(pts[k]!, pts[k + 1]!);
  const ci = v ? 0 : 1; // coordinate that changes
  const ai = v ? 1 : 0; // coordinate along the segment
  const c = pts[k]![ci] + delta;
  const axis = v ? "v" : "h";
  if (k === 0) {
    if (!src) return undefined;
    const p = attach(src, axis, c, pts[1]![ai] > pts[0]![ai]);
    if (!p) return undefined;
    out[0] = p;
  } else out[k]![ci] = c;
  if (k + 1 === m) {
    if (!dst) return undefined;
    const p = attach(dst, axis, c, pts[m - 1]![ai] > pts[m]![ai]);
    if (!p) return undefined;
    out[m] = p;
  } else out[k + 1]![ci] = c;
  for (let s = Math.max(0, k - 1); s <= Math.min(m - 1, k + 1); s++) {
    const sv = vertical(pts[s]!, pts[s + 1]!);
    const i = sv ? 1 : 0;
    const was = pts[s + 1]![i] - pts[s]![i];
    const now = out[s + 1]![i] - out[s]![i];
    const min = s === 0 || s === m - 1 ? MIN_END : MIN_SEG;
    if (Math.sign(was) !== Math.sign(now) || Math.abs(now) < Math.min(min, Math.abs(was))) return undefined;
  }
  return out.map((p): Pt => [r2(p[0]), r2(p[1])]);
}

/** Lane clearances of one arrow against the others, plus passing through nodes: the count of violations it takes part in. */
class Scene {
  readonly routes: Route[];
  readonly outlines: Map<string, Outline>;
  readonly obstacles: Outline[];

  constructor(routes: Route[], outlines: Map<string, Outline>, obstacles: Outline[]) {
    this.routes = routes;
    this.outlines = outlines;
    this.obstacles = obstacles;
  }

  private against(a: Route, b: Route): number {
    if (a.bb[2] + FAR < b.bb[0] || b.bb[2] + FAR < a.bb[0] || a.bb[3] + FAR < b.bb[1] || b.bb[3] + FAR < a.bb[1]) return 0;
    let n = 0;
    const same = a.pair === b.pair;
    const need = same ? PAIR_RUN : LANE_RUN;
    let worst = -1; // deepest shortfall, as a share of the wanted gap
    let closeHard = false; // a pair of arrows inside one of the checker's HARD lines (same-pair spacing, arrowhead crowding)
    for (let i = 1; i < a.pts.length; i++) {
      const a1 = a.pts[i - 1]!;
      const a2 = a.pts[i]!;
      const av = vertical(a1, a2);
      for (let j = 1; j < b.pts.length; j++) {
        const b1 = b.pts[j - 1]!;
        const b2 = b.pts[j]!;
        if (av ? !vertical(b1, b2) : !horizontal(b1, b2)) continue;
        const ci = av ? 0 : 1;
        const shared = run(a1, a2, b1, b2, av);
        // arrows between the same two nodes: each label sits on its own arrow and must clear the other one
        const gap = same ? Math.max(PAIR_GAP, room(a, av, shared), room(b, av, shared)) : LANE_GAP;
        const dist = Math.abs(a1[ci] - b1[ci]);
        if (dist < gap && shared >= need) worst = Math.max(worst, (gap - dist) / gap);
        if (same && dist < PAIR_HARD && shared >= PAIR_HARD_RUN) closeHard = true;
      }
    }
    if (worst >= 0) n += 1 + worst; // a violation always costs more than none; a smaller shortfall costs less

    // arrow ends on one node
    const ends = (r: Route): [string, Pt, boolean][] => [
      [r.c.src, r.pts[0]!, r.head[0]],
      [r.c.dst, r.pts[r.pts.length - 1]!, r.head[1]],
    ];
    let crowded = -1;
    for (const [n1, p, h1] of ends(a)) {
      for (const [n2, q, h2] of ends(b)) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (n1 === n2 && (h1 || h2) && d < END_GAP) {
          crowded = Math.max(crowded, (END_GAP - d) / END_GAP);
          if (d < HEAD_HARD) closeHard = true;
        }
      }
    }
    return n + (crowded >= 0 ? 1 + crowded : 0) + (closeHard ? HARD_COST : 0);
  }

  cost(idx: number): number {
    const r = this.routes[idx]!;
    let n = 0;
    this.routes.forEach((o, j) => {
      if (j !== idx) n += this.against(r, o);
    });
    const own = new Set([r.c.src, r.c.dst]);
    for (const o of this.obstacles) {
      const mine = own.has(o.id);
      let worst = 0;
      for (let i = 1; i < r.pts.length; i++) {
        if (mine && (i === 1 || i === r.pts.length - 1)) continue; // the segments that touch the node
        worst = Math.max(worst, segInsideLength(r.pts[i - 1]!, r.pts[i]!, o.poly));
      }
      if (worst > (mine ? OWN_THROUGH : THROUGH)) n++;
    }
    return n;
  }

  total(): number {
    let n = 0;
    for (let i = 0; i < this.routes.length; i++) {
      for (let j = i + 1; j < this.routes.length; j++) n += this.against(this.routes[i]!, this.routes[j]!);
    }
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i]!;
      const own = new Set([r.c.src, r.c.dst]);
      for (const o of this.obstacles) {
        let worst = 0;
        for (let s = 1; s < r.pts.length; s++) {
          if (own.has(o.id) && (s === 1 || s === r.pts.length - 1)) continue;
          worst = Math.max(worst, segInsideLength(r.pts[s - 1]!, r.pts[s]!, o.poly));
        }
        if (worst > (own.has(o.id) ? OWN_THROUGH : THROUGH)) n++;
      }
    }
    return n;
  }
}

/** Spreads crowded lanes and arrow ends of a graph diagram (in place). */
export function spreadLanes(diagram: D2Diagram): LaneStats {
  const stats: LaneStats = { edges: 0, moved: 0, before: 0, after: 0 };
  const shapes = diagram.shapes.filter((s) => !TITLE_ID.test(s.id) || s.type !== "text");
  const zoneIds = new Set(shapes.filter((s) => shapes.some((o) => o.id.startsWith(`${s.id}.`))).map((s) => s.id));
  const outlines = new Map(shapes.map((s) => [s.id, outlineOf(s, zoneIds.has(s.id))]));
  const obstacles = [...outlines.values()].filter((o) => !zoneIds.has(o.id));

  const routes: Route[] = [];
  for (const c of diagram.connections) {
    if (LIFELINE_ID.test(c.id) || c.dst.includes("-lifeline-end-") || !outlines.has(c.src) || !outlines.has(c.dst)) continue;
    const pts = c.isCurve === true ? undefined : orthogonal(c.route);
    const loop = c.src === c.dst;
    const line = pts ?? c.route.map((p): Pt => [p.x, p.y]);
    if (line.length < 2) continue;
    routes.push({
      c,
      pts: line,
      bb: bbox(line),
      pair: [c.src, c.dst].sort().join("|"),
      loop,
      editable: pts !== undefined && !loop,
      head: [!!c.srcArrow && c.srcArrow !== "none", !!c.dstArrow && c.dstArrow !== "none"],
    });
  }
  stats.edges = routes.length;
  if (routes.length === 0) return stats;

  const scene = new Scene(routes, outlines, obstacles);
  stats.before = scene.total();
  const original = routes.map((r) => r.pts);
  if (stats.before === 0) {
    stats.after = 0;
    return stats;
  }

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let improved = false;
    const order = routes.map((_, i) => i).sort((a, b) => scene.cost(b) - scene.cost(a) || a - b);
    for (const idx of order) {
      const r = routes[idx]!;
      if (!r.editable) continue;
      const now = scene.cost(idx);
      if (now === 0) continue;
      let best: { pts: Pt[]; cost: number; move: number } | undefined;
      const src = outlines.get(r.c.src);
      const dst = outlines.get(r.c.dst);
      const tried = r.pts;
      for (let k = 0; k + 1 < tried.length; k++) {
        const v = vertical(tried[k]!, tried[k + 1]!);
        const ci = v ? 0 : 1;
        const here = tried[k]![ci];
        const deltas = new Set<number>();
        for (const d of DELTAS) {
          deltas.add(d);
          deltas.add(-d);
        }
        // clear a node the segment runs through
        for (const o of obstacles) {
          if (o.id === r.c.src || o.id === r.c.dst) continue;
          if (segInsideLength(tried[k]!, tried[k + 1]!, o.poly) <= THROUGH) continue;
          const lo = v ? o.x : o.y;
          const hi = v ? o.x + o.w : o.y + o.h;
          for (const gap of [8, 4, 2.5]) {
            deltas.add(r2(hi + gap - here));
            deltas.add(r2(lo - gap - here));
          }
        }
        for (const delta of deltas) {
          const next = shiftSegment(tried, k, delta, src, dst);
          if (!next) continue;
          r.pts = next;
          r.bb = bbox(next);
          const cost = scene.cost(idx);
          r.pts = tried;
          r.bb = bbox(tried);
          const move = Math.abs(delta);
          if (cost < now && (!best || cost < best.cost || (cost === best.cost && move < best.move))) best = { pts: next, cost, move };
        }
      }
      if (best) {
        r.pts = best.pts;
        r.bb = bbox(best.pts);
        improved = true;
      }
    }
    if (!improved) break;
  }

  stats.after = scene.total();
  if (stats.after > stats.before) {
    routes.forEach((r, i) => {
      r.pts = original[i]!;
      r.bb = bbox(r.pts);
    });
    stats.after = stats.before;
    return stats;
  }
  routes.forEach((r, i) => {
    if (r.pts === original[i]) return;
    r.c.route = r.pts.map(([x, y]) => ({ x, y }));
    stats.moved++;
  });
  return stats;
}
