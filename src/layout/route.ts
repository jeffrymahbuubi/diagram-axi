// Edge routing on top of positioned nodes. Dagre's own edge paths are computed against the
// inflated (group-padded) node boxes and carry compound-cluster waypoints, which produce long
// diagonals and sharp kinks. Instead every edge gets a fresh route between the *real* node
// outlines: facing sides along the flow axis, a straight segment when the ends are nearly aligned,
// otherwise a 1-bend / Z orthogonal route, with the cleaned dagre path as a last-resort detour.
// Edges that leave from (or arrive at) the same node side are spread along it so they never share
// an end point. Self-loops get a short orthogonal loop (loops.ts). Whatever still collides afterwards
// (a label on a node or arrow, an arrow through a node, close parallels) is repaired by repair.ts.
// Everything is deterministic (edges are processed in index order).

import type { ShapeKind } from "../dsl/ast.js";
import type { Box, Point } from "./engine.js";
import { astarRoute } from "./astar.js";
import type { Budget } from "./budget.js";
import { zoneBorders, type Zone } from "./zones.js";
import { loopNodeHeight, routeLoop } from "./loops.js";
import { center, parallelGap } from "./geom.js";
import { T } from "./tune.js";
import { OPPOSITE, countHits, cleanPath, crossings, headCrossings, headWindows, orthogonal, portOnSide, shortStubs, sharesTrack, sideToward, validRoute, type Side } from "./route-util.js";

export { fractionAt, pointAt, placeLabels, type LabelRequest } from "./labels.js";

export interface RouteNode {
  id: string;
  shape: ShapeKind;
  box: Box;
}

export interface RouteEdge {
  index: number;
  from: string;
  to: string;
  /** Raw dagre waypoints (inflated coordinates); only used as a last-resort detour. */
  fallback: Point[];
  /** Width of the edge's label box (0 or absent without a label); sets how far apart a pair must run. */
  labelW?: number;
  labelH?: number;
  /** Whether the start / end carries an arrowhead (default: end only). */
  heads?: [boolean, boolean];
}


/** Max distance between neighbouring ports on one side, and the share of the side they may span. */
const PORT_SPACING = 28;
const SPAN_RECT = 0.84;
const SPAN_CURVED = 0.56;
/** Clearance (px) of the A* detours tried when no orthogonal candidate is clean. */
const ASTAR_MARGIN = 14;
/** Parallel edges between one pair of nodes keep at least this distance (perpendicular) between them. */
const PAIR_GAP = 46;
/** Parallel runs of one pair closer than this are scored as a defect. */
const PAIR_CLOSE = 40;
/** Nodes count as apart on the cross axis (for routing a pair round them) only with this much room. */
const CROSS_MIN_GAP = 40;
/** Share of a side that a pair's parallel lanes may use (more than a lone fan), rect / curved shapes. */
const LANE_SPAN_RECT = 0.9;
const LANE_SPAN_CURVED = 0.6;

const pairKey = (e: { from: string; to: string }) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`);


/**
 * Which sides an edge a -> b leaves and enters by: facing sides along the flow axis when separated
 * on it. `alt` (a second edge between the same pair) prefers the cross axis so the two edges take
 * visibly different paths instead of squeezing side by side. When the pair is not separated on the
 * cross axis there is no such side pair; with `corner` the alt edge then goes round instead: 1 =
 * round the earlier node (it leaves/enters that node by the side facing the other node's cross-axis
 * position and the other node by its flow-facing side), 2 = round the later node. Either is an
 * L-shaped route whose runs stay clear of the primary edge.
 */
/** Are the boxes apart on the cross axis by enough room to route a Z/L between their cross-facing sides? */
function roomyOnCross(a: Box, b: Box, axis: "x" | "y"): boolean {
  return axis === "x"
    ? a.y + a.h + CROSS_MIN_GAP <= b.y || b.y + b.h + CROSS_MIN_GAP <= a.y
    : a.x + a.w + CROSS_MIN_GAP <= b.x || b.x + b.w + CROSS_MIN_GAP <= a.x;
}

function sidesFor(a: Box, b: Box, axis: "x" | "y", alt: boolean, corner: 0 | 1 | 2 = 0, reverse = false): [Side, Side] {
  const sepX = a.x + a.w <= b.x ? "right" : b.x + b.w <= a.x ? "left" : undefined;
  const sepY = a.y + a.h <= b.y ? "bottom" : b.y + b.h <= a.y ? "top" : undefined;
  const flowSep = axis === "x" ? sepX : sepY;
  const crossSep = axis === "x" ? sepY : sepX;
  if (alt && corner > 0 && flowSep && !roomyOnCross(a, b, axis)) {
    // a is earlier in the flow (the layout runs towards the bottom/right unless `reverse`)
    const aFirst = (flowSep === "bottom" || flowSep === "right") !== reverse;
    const [first, second] = aFirst ? [a, b] : [b, a];
    const cf = center(first);
    const cs = center(second);
    const cross: Side = axis === "x" ? (cs.y >= cf.y ? "bottom" : "top") : cs.x >= cf.x ? "right" : "left";
    // corner 1: the earlier node faces the flow, the later one takes the cross side.
    const crossBack: Side = axis === "x" ? (cf.y >= cs.y ? "bottom" : "top") : cf.x >= cs.x ? "right" : "left";
    if (corner === 2) return aFirst ? [flowSep, crossBack] : [crossBack, OPPOSITE[flowSep]];
    return aFirst ? [cross, OPPOSITE[flowSep]] : [flowSep, cross];
  }
  // A second edge prefers the cross axis when there is room for it, else it shares the flow-facing sides.
  const pick = alt ? (roomyOnCross(a, b, axis) ? crossSep : undefined) ?? flowSep ?? crossSep : flowSep ?? crossSep;
  if (pick) return [pick, OPPOSITE[pick]];
  return [sideToward(a, center(b)), sideToward(b, center(a))];
}


interface End {
  edge: number;
  end: 0 | 1;
  node: RouteNode;
  side: Side;
  other: Point;
  pair: string;
}

/** Room along a side that a bucket of ports may use. */
function sideSpan(node: RouteNode, side: Side, lanes: boolean): number {
  const alongX = side === "top" || side === "bottom";
  const curved = node.shape === "diamond" || node.shape === "ellipse";
  const share = lanes ? (curved ? LANE_SPAN_CURVED : LANE_SPAN_RECT) : curved ? SPAN_CURVED : SPAN_RECT;
  const len = alongX ? node.box.w : node.box.h;
  // Ports also keep CORNER_CLEAR from the corners, so ports on two sides meeting there stay apart.
  return Math.min(len * share, len - 2 * T.cornerClear);
}


/**
 * Choose an outline point for every edge end; ends sharing a node side are spread along it. Ends of
 * edges that join the same pair of nodes sit `pairGap` apart (their routes run side by side), others
 * `PORT_SPACING`; the whole fan shrinks to fit the side.
 */
function endBuckets(edges: RouteEdge[], nodes: Map<string, RouteNode>, sides: Map<number, [Side, Side]>): Map<string, End[]> {
  const buckets = new Map<string, End[]>();
  for (const e of edges) {
    const a = nodes.get(e.from)!;
    const b = nodes.get(e.to)!;
    const [sa, sb] = sides.get(e.index)!;
    const pair = pairKey(e);
    const ends: End[] = [
      { edge: e.index, end: 0, node: a, side: sa, other: portOnSide(b.shape, b.box, sb, 0), pair },
      { edge: e.index, end: 1, node: b, side: sb, other: portOnSide(a.shape, a.box, sa, 0), pair },
    ];
    for (const en of ends) {
      const key = `${en.node.id}|${en.side}`;
      const list = buckets.get(key);
      if (list) list.push(en);
      else buckets.set(key, [en]);
    }
  }
  for (const list of buckets.values()) {
    const { side } = list[0]!;
    const alongX = side === "top" || side === "bottom";
    // Order by where the other end lies along the side so the fan does not cross itself.
    list.sort((p, q) => (alongX ? p.other.x - q.other.x : p.other.y - q.other.y) || p.edge - q.edge || p.end - q.end);
  }
  return buckets;
}

/** Offsets of the ends of one (sorted) bucket along its side, `base` apart at least; pairs keep their lane gap. */
function spacingOf(list: End[], pairGap: Map<string, number>, base: number): { at: number[]; lanes: boolean } {
  const at: number[] = [0];
  let lanes = false;
  for (let j = 1; j < list.length; j++) {
    const prev = list[j - 1]!;
    const en = list[j]!;
    const gap = en.pair === prev.pair && en.edge !== prev.edge ? pairGap.get(en.pair) : undefined;
    if (gap !== undefined) lanes = true;
    at.push(at[j - 1]! + Math.max(gap ?? 0, base));
  }
  return { at, lanes };
}

function assignPorts(
  edges: RouteEdge[],
  nodes: Map<string, RouteNode>,
  sides: Map<number, [Side, Side]>,
  pairGap: Map<string, number>,
): Map<string, Point> {
  const buckets = endBuckets(edges, nodes, sides);
  const ports = new Map<string, Point>();
  for (const list of buckets.values()) {
    const { node, side } = list[0]!;
    const { at, lanes } = spacingOf(list, pairGap, PORT_SPACING);
    const total = at[at.length - 1]!;
    const scale = total > 0 ? Math.min(1, sideSpan(node, side, lanes) / total) : 1;
    list.forEach((en, j) => {
      ports.set(`${en.edge}:${en.end}`, portOnSide(node.shape, node.box, side, (at[j]! - total / 2) * scale));
    });
  }
  return ports;
}






/** Would the L route between the side midpoints of the edge's nodes be valid and clear of every other node? */
function clearL(nodes: Map<string, RouteNode>, e: RouteEdge, sa: Side, sb: Side): boolean {
  const a = nodes.get(e.from)!;
  const b = nodes.get(e.to)!;
  const pa = portOnSide(a.shape, a.box, sa, 0);
  const pb = portOnSide(b.shape, b.box, sb, 0);
  const pts = orthogonal(pa, pb, sa, sb)[0]!;
  if (!validRoute(pts, sa, sb)) return false;
  return countHits(pts, [...nodes.values()].filter((n) => n !== a && n !== b)) === 0;
}

interface Plan {
  sides: Map<number, [Side, Side]>;
  alts: Set<number>;
  /** Distance between the ports of one pair's edges where they share a node side. */
  pairGap: Map<string, number>;
}

/**
 * Pick the sides of every edge. Edges between one pair of nodes are grouped; the second, fourth...
 * (`alt`) must not hug the first. Separated on the cross axis they take the cross-facing sides;
 * when the pair is only separated along the flow axis they either run as parallel lanes (when both
 * node sides have room for lanes `gap` apart) or the alt edge goes round the earlier node (L route).
 */
function planSides(live: RouteEdge[], nodes: Map<string, RouteNode>, axis: "x" | "y", reverse: boolean): Plan {
  const groups = new Map<string, RouteEdge[]>();
  for (const e of live) {
    const key = pairKey(e);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const alts = new Set<number>();
  for (const list of groups.values()) list.forEach((e, k) => k % 2 === 1 && alts.add(e.index));
  const box = (id: string) => nodes.get(id)!.box;
  const sidesOf = (e: RouteEdge, corner: 0 | 1 | 2) => sidesFor(box(e.from), box(e.to), axis, alts.has(e.index), corner, reverse);

  const sides = new Map<number, [Side, Side]>();
  for (const e of live) sides.set(e.index, sidesOf(e, 0));
  const count = new Map<string, number>(); // ends per node side
  for (const e of live) {
    const [sa, sb] = sides.get(e.index)!;
    for (const k of [`${e.from}|${sa}`, `${e.to}|${sb}`]) count.set(k, (count.get(k) ?? 0) + 1);
  }

  const pairGap = new Map<string, number>();
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const e0 = list[0]!;
    const a = nodes.get(e0.from)!;
    const b = nodes.get(e0.to)!;
    const labelGap = Math.max(...list.map((e) => (e.labelW ?? 0) / 2 + 10));
    const flowSep = axis === "x" ? a.box.x + a.box.w <= b.box.x || b.box.x + b.box.w <= a.box.x : a.box.y + a.box.h <= b.box.y || b.box.y + b.box.h <= a.box.y;
    if (!flowSep || roomyOnCross(a.box, b.box, axis)) {
      pairGap.set(key, Math.max(PAIR_GAP, labelGap));
      continue;
    }
    // Lanes run between facing sides; diagonal lanes need a wider offset for the same distance.
    const ca = center(a.box);
    const cb = center(b.box);
    const run = Math.max(1, axis === "x" ? Math.abs(cb.x - ca.x) - (a.box.w + b.box.w) / 2 : Math.abs(cb.y - ca.y) - (a.box.h + b.box.h) / 2);
    const drift = axis === "x" ? Math.abs(cb.y - ca.y) : Math.abs(cb.x - ca.x);
    const gap = Math.max((PAIR_GAP * Math.hypot(run, drift)) / run, labelGap);
    const [sa, sb] = sides.get(e0.index)!;
    const m = list.length;
    const fits = (n: RouteNode, side: Side) => {
      const others = (count.get(`${n.id}|${side}`) ?? 0) - m;
      return (m - 1) * gap + Math.max(0, others) * PORT_SPACING <= sideSpan(n, side, true);
    };
    pairGap.set(key, gap);
    if (fits(a, sa) && fits(b, sb)) continue;
    // No room for lanes: send each alt edge round a corner, unless the L would run into a node.
    for (const e of list) {
      if (!alts.has(e.index)) continue;
      for (const variant of [1, 2] as const) {
        const [ea, eb] = sidesOf(e, variant);
        if (clearL(nodes, e, ea, eb)) {
          sides.set(e.index, [ea, eb]);
          break;
        }
      }
    }
  }
  return { sides, alts, pairGap };
}

/** Room the layout must give the edges: node sizes that fit their ports PORT_PITCH apart, and the busiest flow-facing side. */
export interface Demand {
  grow: Map<string, { w: number; h: number }>;
  /** Most Z routes whose cross-axis extents overlap in one rank gap (sets how many rails that gap must hold). */
  fan: number;
  /** Rank gap the labels need: a label may hide about 60% of the run between two ranks, so the gap beyond the label itself is 0.67 times its extent along the flow (capped). */
  labelSep: number;
}

const MAX_GROWN_SPAN = 800;

/** Plan the sides of the edges on the current boxes and report how big the nodes must be for their ports. */
export function portDemand(edges: RouteEdge[], nodes: Map<string, RouteNode>, axis: "x" | "y", reverse = false): Demand {
  const live = edges.filter((e) => e.from !== e.to && nodes.has(e.from) && nodes.has(e.to));
  const { sides, pairGap } = planSides(live, nodes, axis, reverse);
  const grow = new Map<string, { w: number; h: number }>();
  // A labelled self-loop on a left/right side needs an outer run longer than its label: the node gets tall enough for that.
  for (const e of edges) {
    if (!T.loopGrow || e.from !== e.to || !e.labelW || !nodes.has(e.from)) continue;
    const cur = grow.get(e.from) ?? { w: 0, h: 0 };
    cur.h = Math.max(cur.h, Math.min(MAX_GROWN_SPAN, loopNodeHeight({ w: e.labelW, h: e.labelH ?? 24 })));
    grow.set(e.from, cur);
  }
  for (const list of endBuckets(live, nodes, sides).values()) {
    const { node, side } = list[0]!;
    const alongX = side === "top" || side === "bottom";
    const { at, lanes } = spacingOf(list, pairGap, T.portPitch);
    const curved = node.shape === "diamond" || node.shape === "ellipse";
    const share = lanes ? (curved ? LANE_SPAN_CURVED : LANE_SPAN_RECT) : curved ? SPAN_CURVED : SPAN_RECT;
    const total = at[at.length - 1]!;
    const need = Math.min(MAX_GROWN_SPAN, Math.ceil(Math.max(total / share, total + 2 * T.cornerClear)));
    const cur = grow.get(node.id) ?? { w: 0, h: 0 };
    if (alongX) cur.w = Math.max(cur.w, need);
    else cur.h = Math.max(cur.h, need);
    grow.set(node.id, cur);
  }
  // Rails: Z routes between two ranks need a rail each wherever their cross-axis extents overlap.
  const ports = assignPorts(live, nodes, sides, pairGap);
  const channels = new Map<string, Array<[number, number]>>();
  const cross = axis === "y" ? "x" : "y";
  const flow = axis === "y" ? "y" : "x";
  for (const e of live) {
    const [sa, sb] = sides.get(e.index)!;
    const flowSide = (s: Side) => (axis === "y" ? s === "top" || s === "bottom" : s === "left" || s === "right");
    if (!flowSide(sa) || !flowSide(sb) || sa === sb) continue;
    const a = nodes.get(e.from)!;
    const b = nodes.get(e.to)!;
    const pa = ports.get(`${e.index}:0`)!;
    const pb = ports.get(`${e.index}:1`)!;
    if (Math.abs(pa[cross] - pb[cross]) < 3) continue;
    const ca = Math.round(center(a.box)[flow]);
    const cb = Math.round(center(b.box)[flow]);
    const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    const list = channels.get(key) ?? [];
    list.push([Math.min(pa[cross], pb[cross]), Math.max(pa[cross], pb[cross])]);
    channels.set(key, list);
  }
  let fan = 0;
  for (const list of channels.values()) {
    const marks = list.flatMap(([lo, hi]) => [[lo, 1], [hi, -1]] as Array<[number, number]>).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let open = 0;
    for (const [, d] of marks) {
      open += d;
      fan = Math.max(fan, open);
    }
  }
  let labelSep = 0;
  if (T.labelSep) {
    for (const e of live) {
      const along = axis === "x" ? e.labelW ?? 0 : e.labelH ?? 0;
      labelSep = Math.max(labelSep, Math.min(MAX_LABEL_SEP, Math.round(along * 0.67)));
    }
  }
  return { grow, fan: Math.min(fan, MAX_RAILS_PER_GAP), labelSep };
}

const MAX_RAILS_PER_GAP = 16;
const MAX_LABEL_SEP = 120;

/**
 * Rails for Z routes that share a rank gap and whose cross-axis extents overlap: the group is spread
 * evenly around the middle of the gap, RAIL_PITCH apart, in the order the edges were given (nearest to
 * the source first), instead of every edge taking the middle in turn and pushing the rest to one side.
 * Returns the rail coordinate (along the route's main axis) per edge index; lone routes get none.
 */
function planRails(
  zEdges: RouteEdge[],
  sides: Map<number, [Side, Side]>,
  ports: Map<string, Point>,
  nodes: Map<string, RouteNode>,
): Map<number, number> {
  type Z = { e: RouteEdge; lo: number; hi: number; f: number; dir: number; key: string };
  const list: Z[] = zEdges.map((e) => {
    const [sa] = sides.get(e.index)!;
    const ha = sa === "left" || sa === "right";
    const pa = ports.get(`${e.index}:0`)!;
    const pb = ports.get(`${e.index}:1`)!;
    const [f, c] = ha ? (["x", "y"] as const) : (["y", "x"] as const);
    const ca = center(nodes.get(e.from)!.box)[f];
    const cb = center(nodes.get(e.to)!.box)[f];
    const dir = Math.sign(pb[f] - pa[f]);
    return {
      e,
      lo: Math.min(pa[c], pb[c]),
      hi: Math.max(pa[c], pb[c]),
      f: (pa[f] + pb[f]) / 2,
      dir,
      key: `${ha}|${dir}|${Math.round(Math.min(ca, cb))}|${Math.round(Math.max(ca, cb))}|${Math.sign(pb[c] - pa[c])}`,
    };
  });
  const comp = list.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i]!)));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i]!.key === list[j]!.key && list[i]!.lo < list[j]!.hi + 3 && list[j]!.lo < list[i]!.hi + 3) comp[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Z[]>();
  list.forEach((z, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), z]));
  const plan = new Map<number, number>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const mid = g.reduce((s, z) => s + z.f, 0) / g.length;
    g.forEach((z, j) => plan.set(z.e.index, mid + z.dir * (T.railPitch * j - (T.railPitch * (g.length - 1)) / 2)));
  }
  return plan;
}

/**
 * Route every non-loop edge; returns the polyline (source to target) per edge index.
 * `axis` is the flow axis ("x" for RIGHT/LEFT layouts, "y" for DOWN/UP); `reverse` is set for UP/LEFT.
 * `blocks` are boxes no route may cross (zone titles).
 */
export function routeEdges(
  edges: RouteEdge[],
  nodes: Map<string, RouteNode>,
  axis: "x" | "y",
  reverse = false,
  blocks: Box[] = [],
  loopSides?: Map<number, Side>,
  budget?: Budget,
  zones: readonly Zone[] = [],
): Map<number, Point[]> {
  const live = edges.filter((e) => e.from !== e.to && nodes.has(e.from) && nodes.has(e.to));
  const { sides, alts, pairGap } = planSides(live, nodes, axis, reverse);
  const ports = assignPorts(live, nodes, sides, pairGap);
  const blockNodes: RouteNode[] = blocks.map((box, i) => ({ id: `block:${i}`, shape: "rect", box }));
  const all = [...nodes.values(), ...blockNodes];
  const result = new Map<number, Point[]>();
  const placed: Point[][] = [];
  const placedPair: string[] = [];
  const placedHeads: Array<[boolean, boolean]> = [];
  const borders = zoneBorders(zones);

  /** Near-parallel runs of edges between the same pair that sit closer than PAIR_CLOSE. */
  const tooClose = (pts: Point[], pair: string): boolean => {
    for (let k = 0; k < placed.length; k++) {
      if (placedPair[k] !== pair) continue;
      const other = placed[k]!;
      for (let i = 1; i < pts.length; i++) {
        for (let j = 1; j < other.length; j++) {
          if (parallelGap(pts[i - 1]!, pts[i]!, other[j - 1]!, other[j]!) < PAIR_CLOSE) return true;
        }
      }
    }
    return false;
  };

  // Z routes (rails) go last and in an order that lets them nest without crossing: edges running towards
  // higher cross-axis coordinates take the rail nearest their source the larger their ports' coordinates are.
  const zKey = (e: RouteEdge): number | undefined => {
    const [sa, sb] = sides.get(e.index)!;
    const ha = sa === "left" || sa === "right";
    if (ha !== (sb === "left" || sb === "right") || sa === sb) return undefined;
    const pa = ports.get(`${e.index}:0`)!;
    const pb = ports.get(`${e.index}:1`)!;
    const c = ha ? "y" : "x";
    const f = ha ? "x" : "y";
    // Nearly aligned edges run as (slanted) straight lines and need no rail.
    const drift = Math.abs(pb[c] - pa[c]);
    if (!alts.has(e.index) && (drift <= 3 || drift <= T.straightSlope * Math.abs(pb[f] - pa[f]))) return undefined;
    const sum = pa[c] + pb[c];
    return pb[c] >= pa[c] ? -sum : sum + 1e6;
  };
  const order = [
    ...live.filter((e) => zKey(e) === undefined),
    ...live.filter((e) => zKey(e) !== undefined).sort((p, q) => zKey(p)! - zKey(q)! || p.index - q.index),
  ];

  const railPlan = planRails(order.filter((e) => zKey(e) !== undefined), sides, ports, nodes);

  for (const e of order) {
    const a = nodes.get(e.from)!;
    const b = nodes.get(e.to)!;
    const pa = ports.get(`${e.index}:0`)!;
    const pb = ports.get(`${e.index}:1`)!;
    const [sa, sb] = sides.get(e.index)!;
    const obstacles = all.filter((n) => n !== a && n !== b);

    // Cross-axis drift relative to the run between the ends decides straight vs bent.
    const horizontal = sa === "left" || sa === "right";
    const mixed = horizontal !== (sb === "left" || sb === "right"); // one end on each axis: an L, never a line
    const run = Math.abs(horizontal ? pb.x - pa.x : pb.y - pa.y);
    const drift = Math.abs(horizontal ? pb.y - pa.y : pb.x - pa.x);
    const nearlyAligned = drift <= 3 || drift <= T.straightSlope * run;
    const straight = [pa, pb];
    const bent = orthogonal(pa, pb, sa, sb, railPlan.get(e.index));
    // A second edge between the same pair always bends rather than hugging the first one.
    const alt = alts.has(e.index);
    const cands: Point[][] = mixed ? bent : nearlyAligned ? [straight, ...bent] : alt ? bent : [...bent, straight];
    // Dagre's own detour: its interior waypoints only, glued to the chosen ports (a last resort: it jogs and slants).
    const mid = cleanPath([pa, ...e.fallback.slice(1, -1), pb]);
    if (!T.astarFallback && mid.length > 2) cands.push(mid);
    const diagonal = (pts: Point[]) => pts.some((p, i) => i > 0 && Math.abs(p.x - pts[i - 1]!.x) > 0.5 && Math.abs(p.y - pts[i - 1]!.y) > 0.5);

    const pair = pairKey(e);
    const heads = e.heads ?? [false, true];
    let best: Point[] | undefined;
    let bestScore = Infinity;
    /** Cost of a candidate (0 = clean: no node hit, shared track, crossing, close pair, short stub or crossed head). */
    const costOf = (pts: Point[]): number => {
      const hits = countHits(pts, obstacles);
      const bad = validRoute(pts, sa, sb) ? 0 : 1;
      const shared = sharesTrack(pts, placed) ? 1 : 0;
      const cross = crossings(pts, placed);
      const close = tooClose(pts, pair) ? 1 : 0;
      const stubs = T.stubCost ? shortStubs(pts) : 0;
      const headX = T.headCross ? headCrossings(pts, heads, placed, placedHeads) : 0;
      if (hits === 0 && bad === 0 && shared === 0 && cross === 0 && close === 0 && stubs === 0 && headX === 0) return 0;
      // A detour with a slanted run costs more than a crossing: slanted runs of neighbours end up parallel and close.
      return 1e-6 + hits * 10 + bad * 100 + shared * 12 + cross * 2 + close * 6 + stubs * 8 + headX * 6 + (pts.length - 2) + ((pts.length > 2 || !nearlyAligned) && diagonal(pts) ? T.diagonalCost : 0);
    };
    for (const pts of cands) {
      const score = costOf(pts);
      if (score < bestScore) {
        bestScore = score;
        best = pts;
      }
      if (score === 0) break;
    }
    // No clean candidate: let the A* router look for an orthogonal detour round the nodes; it wins when it costs no more.
    if (bestScore > 0 && T.astarFallback && budget && !budget.exhausted) {
      const placedPairRoutes = placed.filter((_, k) => placedPair[k] === pair);
      const blockBoxes = obstacles.map((n) => n.box);
      for (const margin of [ASTAR_MARGIN, 2 * ASTAR_MARGIN]) {
        const alt = astarRoute({ pa, sa, pb, sb, obstacles: blockBoxes, ends: [a.box, b.box], margin, placed, samePair: placedPairRoutes, borders, heads: placed.flatMap((r, k) => headWindows(r, placedHeads[k]!)), window: 160, budget });
        if (!alt) continue;
        const score = costOf(alt);
        if (score <= bestScore) {
          bestScore = score;
          best = alt;
        }
        if (score === 0) break;
      }
    }
    if (T.astarFallback && bestScore >= 10 && mid.length > 2 && costOf(mid) < bestScore) best = mid;
    const route = best!.map((p) => ({ x: p.x, y: p.y }));
    placed.push(route);
    placedPair.push(pair);
    placedHeads.push(heads);
    result.set(e.index, route);
  }
  // Self-loops last, so they pick the side the other routes leave free.
  const nodeList = all;
  for (const e of edges) {
    if (e.from !== e.to || !nodes.has(e.from)) continue;
    const label = e.labelW ? { w: e.labelW, h: e.labelH ?? 24 } : undefined;
    const route = routeLoop(nodes.get(e.from)!, label, nodeList, placed, axis, reverse, loopSides?.get(e.index));
    placed.push(route);
    result.set(e.index, route);
  }
  return result;
}
