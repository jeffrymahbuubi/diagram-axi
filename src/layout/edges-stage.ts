// The edge half of the layout: routes every edge between the placed nodes (route.ts), centers the labels
// on their routes and clears them (labels.ts), then repairs what still collides (repair.ts). A failure of
// any step degrades to simpler geometry instead of failing the drawing.

import type { Graph as Ast } from "../dsl/ast.js";
import type { Box, Point, PositionedEdge, PositionedGroup, TextMetrics } from "./engine.js";
import { Board } from "./board.js";
import type { Budget } from "./budget.js";
import { center } from "./geom.js";
import { polish, repair } from "./repair.js";
import { headsOf, portOnSide, sideOfPoint, sideToward, type Side } from "./route-util.js";
import { placeLabels, pointAt, routeEdges, type LabelRequest, type RouteEdge, type RouteNode } from "./route.js";
import type { Zone } from "./zones.js";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** `fn()`, or `fallback` when it throws: a geometry failure must never fail the whole drawing. */
export function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Straight two-point edge between the sides of two nodes that face each other. */
function straightBetween(a: RouteNode, b: RouteNode): Point[] {
  if (a === b) return [portOnSide(a.shape, a.box, "right", -10), portOnSide(a.shape, a.box, "right", 10)];
  return [portOnSide(a.shape, a.box, sideToward(a.box, center(b.box)), 0), portOnSide(b.shape, b.box, sideToward(b.box, center(a.box)), 0)];
}

export interface StageInput {
  graph: Ast;
  nodes: Map<string, RouteNode>;
  /** Placed node boxes as layout boxes (labels keep clear of them). */
  nodeBoxes: Box[];
  groups: PositionedGroup[];
  zones: Zone[];
  axis: "x" | "y";
  reverse: boolean;
  edges: RouteEdge[];
  edgeInfo: (index: number) => { points: Point[]; x?: number; y?: number };
  labelText: Map<number, TextMetrics>;
  /** Side each self-loop must use (decided by an earlier stage so its zone could be given room). */
  loopSides?: Map<number, Side>;
  /** Work budget shared by label placement and repair (budget.ts). */
  budget?: Budget;
}

export interface StageResult {
  edges: PositionedEdge[];
  /** Side of its node every self-loop ended up on. */
  loopSides: Map<number, Side>;
  /** Defects left after repair, as counted by the board (0 = clean). */
  hard: number;
  /** Clears the visual defects (arrowheads under labels or arrows, merged tracks) of a HARD-clean stage in place; updates `edges`, `loopSides` and `hard`. */
  polish: () => void;
}

export function routeStage(inp: StageInput): StageResult {
  const { graph, nodes, groups } = inp;
  const titleBoxes = groups.flatMap((g) => (g.titleBox ? [g.titleBox] : []));
  const routed = attempt(() => routeEdges(inp.edges, nodes, inp.axis, inp.reverse, titleBoxes, inp.loopSides, inp.budget, inp.zones), new Map<number, Point[]>());
  const edges: PositionedEdge[] = [];
  const requests: LabelRequest[] = [];
  for (const d of inp.edges) {
    const i = d.index;
    const e = graph.edges[i]!;
    const de = inp.edgeInfo(i);
    let points = routed.get(i) ?? d.fallback;
    if (points.length < 2) points = straightBetween(nodes.get(e.from)!, nodes.get(e.to)!);
    const pe: PositionedEdge = { index: i, from: e.from, to: e.to, points: points.map((p) => ({ x: round1(p.x), y: round1(p.y) })) };
    const text = inp.labelText.get(i);
    if (text) {
      const w = Math.ceil(text.width + 8);
      const h = Math.ceil(text.height + 4);
      if (routed.has(i)) {
        requests.push({ index: i, w, h, points: pe.points, from: e.from, to: e.to, heads: headsOf(e.arrow) });
      } else {
        const mid = typeof de.x === "number" && typeof de.y === "number" ? { x: de.x, y: de.y } : pointAt(pe.points, 0.5);
        pe.label = { x: Math.round(mid.x - w / 2), y: Math.round(mid.y - h / 2), w, h, text };
      }
    }
    edges.push(pe);
  }
  // Labels of routed edges: centered on their own route, slid clear of nodes, titles, zones and each other.
  const fixed: Box[] = [...inp.nodeBoxes, ...titleBoxes, ...edges.flatMap((e) => (e.label ? [e.label] : []))];
  const mid = (r: LabelRequest) => pointAt(r.points, 0.5);
  const boxes = attempt(
    () => placeLabels(requests, fixed, edges.map((e) => e.points), inp.zones, inp.budget, edges.map((e) => headsOf(graph.edges[e.index]!.arrow))),
    new Map(requests.map((r) => [r.index, { box: { x: mid(r).x - r.w / 2, y: mid(r).y - r.h / 2, w: r.w, h: r.h }, at: mid(r) }])),
  );
  // Repair: edges that still take part in a defect (label on a node / another arrow, arrow through a
  // node or title, close parallels) are re-routed and their labels re-placed.
  const board = new Board(
    nodes,
    titleBoxes,
    edges
      .filter((pe) => routed.has(pe.index))
      .map((pe) => {
        const req = requests.find((r) => r.index === pe.index);
        return { index: pe.index, from: pe.from, to: pe.to, route: pe.points, label: req && { w: req.w, h: req.h }, box: boxes.get(pe.index)?.box, heads: headsOf(graph.edges[pe.index]!.arrow) };
      }),
    inp.zones,
    inp.budget,
  );
  const left = attempt(() => repair(board), 0);
  const loopSides = new Map<number, Side>();
  /** Copy the board's routes and label spots into the result. */
  const extract = () => {
    for (const pe of edges) {
      const be = board.edges.get(pe.index);
      if (!be) continue;
      pe.points = be.route.map((p) => ({ x: round1(p.x), y: round1(p.y) }));
      if (be.box) pe.label = { ...be.box, text: inp.labelText.get(pe.index)! };
      if (pe.from === pe.to) loopSides.set(pe.index, sideOfPoint(nodes.get(pe.from)!.box, pe.points[0]!));
    }
  };
  extract();
  const result: StageResult = {
    edges,
    loopSides,
    hard: board.totalHard(),
    // Visual polish (repair.ts) is run once on the stage that is kept, and only on a layout that is HARD-clean.
    polish: () => {
      if (left !== 0 || result.hard !== 0) return;
      attempt(() => polish(board), undefined);
      extract();
      result.hard = board.totalHard();
    },
  };
  return result;
}
