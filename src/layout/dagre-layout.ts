// Dagre-backed LayoutEngine (KTD1). Node sizes come from measured label text (KTD2).
//
// Group handling: dagre runs with compound:true so cluster members stay contiguous, but dagre
// has no cluster padding or title support. So nodes are handed to dagre *inflated* by the
// padding their enclosing groups will add, and the real group boxes are then computed bottom-up
// from the real child boxes (children + nested groups + 24 px padding + title room). The
// inflation keeps group boxes clear of non-member nodes; zones that still end up on top of
// something (a long title widens a zone) are pulled apart afterwards (groups.ts).
//
// Room for edges: the node sizes and the rank gap are not fixed up front. A first dagre run is
// planned (which node side every edge uses), and nodes with many edge ends on one side grow so the
// ports sit PORT_PITCH apart, while the rank gap grows with the busiest flow-facing side so its
// rails fit (route.ts portDemand). The second run is the one that is routed.

import { Graph, layout as dagreRun } from "@dagrejs/dagre";
import type { Direction, Graph as Ast, Node as AstNode, ShapeKind } from "../dsl/ast.js";
import type {
  Box,
  LayoutEngine,
  LayoutInput,
  LayoutResult,
  Point,
  PositionedEdge,
  PositionedGroup,
  PositionedNode,
  TextMetrics,
} from "./engine.js";
import { Budget } from "./budget.js";
import { attempt, routeStage } from "./edges-stage.js";
import { GROUP_PAD, buildGroups, groupBoxes, groupsPreorder, memberSets, separate, union, type GroupGeometry, type GroupInfo } from "./groups.js";
import { measure, measureWrapped } from "./measure.js";
import { headsOf, type Side } from "./route-util.js";
import { T, useProfile } from "./tune.js";
import { portDemand, type RouteEdge, type RouteNode } from "./route.js";

const NODE_FONT = 20;
const LABEL_FONT = 16;
/** Edge labels wider than this are wrapped (a very wide label cannot sit between two ranks without hiding other arrows). */
const LABEL_MAX_W = 200;
/** Round 5: labels along a vertical flow may be wider (fewer lines, a shorter stretch of the edge hidden); along a horizontal flow the old width stays (the rank gap grows with it instead). */
const LABEL_MAX_W_Y = 260;
const LABEL_MAX_W_X = 200;
/** How far a group box may stick out past the inflated dagre bounds (kept below nodesep/2). */
const INFLATE_SLACK = 10;
const MARGIN = 20;
const BASE_RANKSEP = 60;
const RANKDIR: Record<Direction, string> = { DOWN: "TB", RIGHT: "LR", UP: "BT", LEFT: "RL" };

const gid = (id: string) => `g:${id}`;
const nid = (id: string) => `n:${id}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Box size for a node of `shape` whose label measures `text`. */
export function nodeSize(shape: ShapeKind, text: TextMetrics): { w: number; h: number } {
  const w = Math.max(120, text.width + 32);
  const h = Math.max(60, text.height + 24);
  switch (shape) {
    case "diamond":
      return { w: Math.ceil(w * 1.6), h: Math.ceil(h * 1.4) };
    case "ellipse":
      return { w: Math.ceil(w * 1.3), h: Math.ceil(h * 1.3) };
    case "cylinder":
      return { w: Math.ceil(w), h: Math.ceil(h * 1.25) };
    default:
      return { w: Math.ceil(w), h: Math.ceil(h) };
  }
}

type Size = { w: number; h: number };

interface Ctx {
  direction: Direction;
  nodeById: Map<string, AstNode>;
  infos: Map<string, GroupInfo>;
  ordered: GroupInfo[];
  emptyGroups: Set<string>;
  nodeParent: Map<string, string>;
  inflationFor: (parent: string | undefined) => { h: number; v: number };
  emptySize: (g: GroupInfo) => Size;
  nodesep: number;
  /** Graph edges that are laid out: [index, from, to, label metrics]. */
  edges: Array<{ index: number; from: string; to: string; text?: TextMetrics }>;
}

/** What the layout needs back from a placement run. */
interface Run {
  realBox: Map<string, Box>;
  /** Center of an empty group's leaf. */
  groupCenter: (id: string) => Point;
  /** Dagre's own path and label center for an edge (empty when dagre did not place it). */
  edgeInfo: (index: number) => { points: Point[]; x?: number; y?: number };
}

/**
 * Build and run dagre once. `variant` degrades the input in steps when dagre throws (it cannot find the
 * intersection of an edge with a node when a label dummy lands on the node's center, which multi-edges and
 * reciprocal pairs with labels can cause): 0 as is, 1 without label sizes, 2 nudged gaps, 3 one unlabelled
 * edge per node pair.
 */
function runDagreOnce(ctx: Ctx, sizes: Map<string, Size>, ranksep: number, variant: number): Run {
  const dg = new Graph({ compound: true, multigraph: true });
  dg.setGraph({ rankdir: RANKDIR[ctx.direction], nodesep: ctx.nodesep + (variant === 2 ? 3 : 0), ranksep: ranksep + (variant === 2 ? 3 : 0), edgesep: 20, marginx: MARGIN, marginy: MARGIN });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const g of ctx.ordered) {
    if (ctx.emptyGroups.has(g.id)) {
      const s = ctx.emptySize(g);
      const inf = ctx.inflationFor(g.parent);
      dg.setNode(gid(g.id), { width: s.w + 2 * inf.h, height: s.h + 2 * inf.v });
    } else {
      dg.setNode(gid(g.id), {});
    }
  }
  for (const n of ctx.nodeById.values()) {
    const s = sizes.get(n.id)!;
    const inf = ctx.inflationFor(ctx.nodeParent.get(n.id));
    dg.setNode(nid(n.id), { width: s.w + 2 * inf.h, height: s.h + 2 * inf.v });
  }
  for (const g of ctx.ordered) if (g.parent) dg.setParent(gid(g.id), gid(g.parent));
  for (const [id, parent] of ctx.nodeParent) if (ctx.nodeById.has(id)) dg.setParent(nid(id), gid(parent));
  const pairs = new Set<string>();
  for (const e of ctx.edges) {
    const lab: Record<string, unknown> = { labelpos: "c", width: 0, height: 0 };
    if (e.text && variant !== 1 && variant !== 3) {
      lab.width = Math.ceil(e.text.width + 8);
      lab.height = Math.ceil(e.text.height + 4);
    }
    if (variant === 3) {
      const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
      if (e.from === e.to || pairs.has(key)) continue;
      pairs.add(key);
    }
    dg.setEdge(nid(e.from), nid(e.to), lab, String(e.index));
  }
  dagreRun(dg);
  const realBox = new Map<string, Box>();
  for (const n of ctx.nodeById.values()) {
    const d = dg.node(nid(n.id));
    const s = sizes.get(n.id)!;
    realBox.set(n.id, { x: Math.round(d.x - s.w / 2), y: Math.round(d.y - s.h / 2), w: s.w, h: s.h });
  }
  return {
    realBox,
    groupCenter: (id) => {
      const d = dg.node(gid(id));
      return { x: d.x, y: d.y };
    },
    edgeInfo: (index) => {
      const e = ctx.edges.find((x) => x.index === index)!;
      const de = dg.edge(nid(e.from), nid(e.to), String(index));
      if (!de) return { points: [] };
      return { points: (de.points ?? []).map((p: Point) => ({ x: p.x, y: p.y })), x: de.x, y: de.y };
    },
  };
}

/** Last resort when dagre keeps throwing: nodes on a plain grid (rows of the flow axis), no dagre paths. */
function gridRun(ctx: Ctx, sizes: Map<string, Size>, ranksep: number): Run {
  const realBox = new Map<string, Box>();
  const list = [...ctx.nodeById.values()];
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const flowX = ctx.direction === "LEFT" || ctx.direction === "RIGHT";
  const cell = { w: 0, h: 0 };
  for (const n of list) {
    const s = sizes.get(n.id)!;
    const inf = ctx.inflationFor(ctx.nodeParent.get(n.id));
    cell.w = Math.max(cell.w, s.w + 2 * inf.h);
    cell.h = Math.max(cell.h, s.h + 2 * inf.v);
  }
  list.forEach((n, i) => {
    const s = sizes.get(n.id)!;
    const a = Math.floor(i / cols);
    const b = i % cols;
    const [col, row] = flowX ? [a, b] : [b, a];
    realBox.set(n.id, {
      x: MARGIN + col * (cell.w + (flowX ? ranksep : 40)) + Math.round((cell.w - s.w) / 2),
      y: MARGIN + row * (cell.h + (flowX ? 40 : ranksep)) + Math.round((cell.h - s.h) / 2),
      w: s.w,
      h: s.h,
    });
  });
  const empties = ctx.ordered.filter((g) => ctx.emptyGroups.has(g.id));
  const offsetY = MARGIN + Math.ceil(list.length / cols) * (cell.h + ranksep);
  return {
    realBox,
    groupCenter: (id) => {
      const k = empties.findIndex((g) => g.id === id);
      const s = ctx.emptySize(empties[k]!);
      return { x: MARGIN + s.w / 2 + k * (s.w + 40), y: offsetY + s.h / 2 };
    },
    edgeInfo: () => ({ points: [] }),
  };
}

/** One placement run; never throws (dagre failures degrade the input, then fall back to a grid). */
function runDagre(ctx: Ctx, sizes: Map<string, Size>, ranksep: number): Run {
  for (let variant = 0; variant < 4; variant++) {
    try {
      return runDagreOnce(ctx, sizes, ranksep, variant);
    } catch {
      // try the next, simpler input
    }
  }
  return gridRun(ctx, sizes, ranksep);
}

function layoutWith(input: LayoutInput, spread: number, budget: Budget): { result: LayoutResult; hard: number } {
  const { graph, direction } = input;
  const axis = direction === "LEFT" || direction === "RIGHT" ? "x" : "y";
  const reverse = direction === "UP" || direction === "LEFT";
  const nodeById = new Map<string, AstNode>();
  for (const n of graph.nodes) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  const infos = buildGroups(graph, nodeById);

  // Membership (first group wins when malformed input lists a child twice).
  const nodeParent = new Map<string, string>();
  for (const g of infos.values()) {
    for (const id of g.nodes) if (!nodeParent.has(id)) nodeParent.set(id, g.id);
  }

  /** Inflation per side that the enclosing group chain of `parent` will need. */
  const inflationFor = (parent: string | undefined) => {
    let h = 0;
    let v = 0;
    for (let g = parent ? infos.get(parent) : undefined; g; g = g.parent ? infos.get(g.parent) : undefined) {
      h += GROUP_PAD;
      v += g.topPad;
    }
    return { h: Math.max(0, h - INFLATE_SLACK), v: Math.max(0, v - INFLATE_SLACK) };
  };

  // Empty groups become plain leaves sized as a small zone.
  const ordered = groupsPreorder(infos);
  const emptyGroups = new Set<string>();
  for (const g of ordered) if (g.nodes.length === 0 && g.groups.length === 0) emptyGroups.add(g.id);
  const emptySize = (g: GroupInfo) => ({
    w: Math.ceil(Math.max(160, (g.title?.text.width ?? 0) + 32)),
    h: Math.ceil(80 + (g.title ? g.topPad - GROUP_PAD : 0)),
  });

  const texts = new Map<string, TextMetrics>();
  const base = new Map<string, Size>();
  for (const n of nodeById.values()) {
    const text = measure(n.label, NODE_FONT);
    texts.set(n.id, text);
    base.set(n.id, nodeSize(n.shape, text));
  }
  const labelText = new Map<number, TextMetrics>();
  const laid: Ctx["edges"] = [];
  graph.edges.forEach((e, i) => {
    if (!nodeById.has(e.from) || !nodeById.has(e.to)) return;
    const text = e.label ? measureWrapped(e.label, LABEL_FONT, T.labelSep ? (axis === "y" ? LABEL_MAX_W_Y : LABEL_MAX_W_X) : LABEL_MAX_W) : undefined;
    if (text) labelText.set(i, text);
    laid.push({ index: i, from: e.from, to: e.to, text });
  });
  const ctx: Ctx = { nodesep: 40 * spread, direction, nodeById, infos, ordered, emptyGroups, nodeParent, inflationFor, emptySize, edges: laid };

  const labelDims = (i: number) => {
    const t = labelText.get(i);
    return { labelW: t ? Math.ceil(t.width + 8) : 0, labelH: t ? Math.ceil(t.height + 4) : 0 };
  };
  const routeNodesOf = (boxes: Map<string, Box>) => {
    const m = new Map<string, RouteNode>();
    for (const n of nodeById.values()) m.set(n.id, { id: n.id, shape: n.shape, box: boxes.get(n.id)! });
    return m;
  };

  // Plan the edges on a first run and make room for them (node sizes, rank gap); the last run is kept.
  let sizes = new Map(base);
  let ranksep = BASE_RANKSEP * spread;
  let run = runDagre(ctx, sizes, ranksep);
  for (let pass = 0; pass < 2; pass++) {
    const plan = attempt(
      () => portDemand(laid.map((e) => ({ index: e.index, from: e.from, to: e.to, fallback: [], ...labelDims(e.index) })), routeNodesOf(run.realBox), axis, reverse),
      { grow: new Map<string, Size>(), fan: 0, labelSep: 0 },
    );
    let changed = false;
    const next = new Map<string, Size>();
    for (const [id, s] of sizes) {
      const need = plan.grow.get(id);
      const w = Math.max(s.w, need?.w ?? 0);
      const h = Math.max(s.h, need?.h ?? 0);
      if (w !== s.w || h !== s.h) changed = true;
      next.set(id, { w, h });
    }
    // fan rails RAIL_PITCH apart, centered in the gap, each end keeping its FINAL_STUB (plus a little slack)
    const gap = plan.fan > 0 ? (T.fanStubs ? 2 * T.finalStub + 8 + T.railPitch * (plan.fan - 1) : 36 + T.railPitch * (plan.fan + 1)) : 0;
    if (gap > ranksep) {
      ranksep = gap;
      changed = true;
    }
    if (plan.labelSep > ranksep) {
      ranksep = plan.labelSep;
      changed = true;
    }
    if (!changed) break;
    sizes = next;
    run = runDagre(ctx, sizes, ranksep);
  }
  const { realBox } = run;

  const nodes: PositionedNode[] = [];
  for (const n of nodeById.values()) nodes.push({ id: n.id, ...realBox.get(n.id)!, text: texts.get(n.id)! });

  // Group boxes bottom-up from the real child boxes; zones that overlap something foreign are pulled apart.
  const emptyBox = new Map<string, Box>();
  for (const id of emptyGroups) {
    const s = emptySize(infos.get(id)!);
    const d = run.groupCenter(id);
    emptyBox.set(id, { x: Math.round(d.x - s.w / 2), y: Math.round(d.y - s.h / 2), w: s.w, h: s.h });
  }
  const geo: GroupGeometry = { infos, ordered, nodeBox: realBox, emptyBox, halo: new Map() };
  const members = memberSets(geo);
  /** Zones, titles and node positions from the current geometry (zones are pulled apart first). */
  const settle = (): PositionedGroup[] => {
    separate(geo);
    for (const n of nodes) Object.assign(n, realBox.get(n.id)!);
    const boxes = groupBoxes(geo);
    return ordered.map((g) => {
      const box = boxes.get(g.id)!;
      const out: PositionedGroup = { id: g.id, ...box };
      if (g.title) out.titleBox = { x: box.x + 16, y: box.y + 8, w: Math.ceil(g.title.text.width), h: g.title.text.height };
      return out;
    });
  };
  let groups = settle();

  // Edges: routed afresh between the real node outlines (route.ts). Dagre's own paths are
  // computed on the inflated boxes, so they only serve as a last-resort detour; self-loops are drawn by loops.ts.
  const routeNodes = routeNodesOf(realBox);
  const dagreEdges: RouteEdge[] = laid.map((l) => ({ index: l.index, from: l.from, to: l.to, fallback: run.edgeInfo(l.index).points, heads: headsOf(graph.edges[l.index]!.arrow), ...labelDims(l.index) }));
  const stageOf = (loopSides?: Map<number, Side>) =>
    routeStage({
      graph,
      nodes: routeNodes,
      nodeBoxes: nodes,
      groups,
      zones: groups.map((g) => ({ box: g, members: members.get(g.id)! })),
      axis,
      reverse,
      edges: dagreEdges,
      edgeInfo: run.edgeInfo,
      labelText,
      loopSides,
      budget,
    });
  let stage = stageOf();
  // A self-loop on a node inside a zone needs room (with its label) inside that zone, and so does the
  // label of an edge whose ends share a zone: the zone grows around what was routed, neighbours are
  // pulled apart, and the edges are routed again (a few rounds, as the labels may move).
  const halo = new Map<string, Box[]>();
  const grew = new Set<string>();
  const addHalo = (id: string, spots: Box[]) => {
    const at = realBox.get(id)!;
    const u = union(spots);
    const rel = { x: u.x - at.x, y: u.y - at.y, w: u.w, h: u.h };
    const key = `${id}|${Math.round(rel.x)},${Math.round(rel.y)},${Math.round(rel.w)},${Math.round(rel.h)}`;
    if (grew.has(key)) return false;
    grew.add(key);
    halo.set(id, [...(halo.get(id) ?? []), rel]);
    return true;
  };
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const pe of stage.edges) {
      if (!nodeParent.has(pe.from)) continue;
      if (pe.from === pe.to) {
        const spots: Box[] = pe.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }));
        if (pe.label) spots.push(pe.label);
        if (addHalo(pe.from, spots)) changed = true;
      } else if (pe.label && nodeParent.has(pe.to)) {
        const label = pe.label;
        const outside = groups.some((z) => {
          const m = members.get(z.id)!;
          return m.has(pe.from) && m.has(pe.to) && !(label.x >= z.x && label.y >= z.y && label.x + label.w <= z.x + z.w && label.y + label.h <= z.y + z.h);
        });
        if (outside && addHalo(pe.from, [label])) changed = true;
      }
    }
    if (!changed) break;
    geo.halo = halo;
    const sides = stage.loopSides;
    groups = settle();
    for (const [id, bx] of realBox) routeNodes.get(id)!.box = bx;
    stage = stageOf(sides);
  }
  stage.polish();
  const { edges } = stage;

  // Bounds, then shift so the top-left sits at the margin.
  const all: Box[] = [...nodes, ...groups];
  for (const e of edges) {
    if (e.label) all.push(e.label);
    for (const p of e.points) all.push({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  const raw = union(all);
  const dx = Math.round(MARGIN - raw.x);
  const dy = Math.round(MARGIN - raw.y);
  for (const n of nodes) shift(n, dx, dy);
  for (const g of groups) {
    shift(g, dx, dy);
    if (g.titleBox) shift(g.titleBox, dx, dy);
  }
  for (const e of edges) {
    for (const p of e.points) {
      p.x = round1(p.x + dx);
      p.y = round1(p.y + dy);
    }
    if (e.label) shift(e.label, dx, dy);
  }
  const bounds = union([
    ...nodes,
    ...groups,
    ...edges.flatMap((e) => [...(e.label ? [e.label] : []), ...e.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))]),
  ]);
  return { result: { nodes, edges, groups, bounds }, hard: stage.hard };
}

function shift(b: Box, dx: number, dy: number): void {
  b.x += dx;
  b.y += dy;
}

/** Extra room tried, in turn, when the edges of a layout still collide after repair. */
const SPREADS = [1, 1.35, 1.8, 2.4];

/**
 * Work units (budget.ts) one layout may spend over all its attempts: A* expansions, repair candidates, label
 * slot scans and the dagre/route cost of retries. 3e8 is about 1.5 s on a dev box. The count is deterministic,
 * so a layout that runs out of budget stops at the same point (with the same output) on every machine.
 */
export const LAYOUT_BUDGET = 3e8;
/** Tuning profiles tried at each spread, in order (tune.ts). */
const PROFILES: Array<"strict" | "legacy"> = ["strict", "legacy"];
/** A strict attempt may use this share of what its turn allows, so that a legacy attempt still fits when it leaves a HARD defect. */
const STRICT_SHARE = 0.7;
/** Wall time per work unit of the strict profile relative to the legacy one (measured on the stress-60 profile). */
const STRICT_WEIGHT = 1.2;
/** Share of what is left of the budget each attempt may use: the first may use it all, later ones leave room for the next. */
const SHARES = [1, 0.4, 0.8, 1];
/** Charge per node and edge for an attempt's dagre run and first routing (not counted by the searches themselves). */
const ATTEMPT_COST = 120_000;

/**
 * The layout, with more room between nodes and ranks (SPREADS) whenever defects remain after the
 * repair pass; the first defect-free one wins, otherwise the one with the fewest defects. The whole
 * ladder shares one work budget: when it runs out the repair stops where it is and the best layout
 * found so far (fewest defects) is returned.
 */
function layout(input: LayoutInput): LayoutResult {
  const total = input.budget ?? LAYOUT_BUDGET;
  const budget = new Budget(total);
  let best: { result: LayoutResult; hard: number } | undefined;
  try {
    outer: for (const [i, spread] of SPREADS.entries()) {
      // At each spread the strict profile (tune.ts) goes first; the legacy one only when a HARD defect is left.
      for (const profile of PROFILES) {
        budget.limit = budget.spent + (total - budget.spent) * SHARES[i]! * (profile === "strict" && PROFILES.length > 1 ? STRICT_SHARE : 1);
        budget.weight = profile === "strict" ? STRICT_WEIGHT : 1;
        useProfile(profile);
        const run = layoutWith(input, spread, budget);
        budget.weight = 1;
        budget.spend(ATTEMPT_COST * (input.graph.nodes.length + input.graph.edges.length));
        if (!best || run.hard < best.hard) best = run;
        if (best.hard === 0 || budget.spent >= total) break outer;
      }
    }
  } finally {
    useProfile("strict");
  }
  return best!.result;
}

export const dagreLayout: LayoutEngine = { layout };
export { layout };
export type { Ast };
