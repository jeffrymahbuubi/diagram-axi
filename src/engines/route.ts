// Engine router (KTD4): a pure function over a parsed Graph (or a diagram kind) that picks
// excalidraw, d2 or mermaid and words the one-line `engine:` recommendation. No layout, no IO.
// Thresholds mirror the `check` lints (src/lint/rules.ts) where one exists; see ROUTE_LIMITS.

import type { Graph } from "../dsl/ast.js";
import {
  DENSE_MIN_NODES,
  DENSE_RATIO,
  MANY_NODES,
  MAX_CROSS_GROUP,
  MAX_DEGREE,
  MAX_DEPTH,
  MAX_LINE,
  MAX_PARALLEL,
  countLongLabels,
  crossGroupEdges,
} from "../lint/rules.js";

import type { EngineId, Kind } from "./types.js";

export type { EngineId, Kind };

export type Target = "markdown" | "github" | "editable";

/**
 * Router thresholds. A graph "fits excalidraw" when every measure is at or below its limit.
 * Imported limits keep the router and `check` in lockstep.
 */
export const ROUTE_LIMITS = {
  /** = lint MANY_NODES (`many-nodes` warns above it). */
  nodes: MANY_NODES,
  /**
   * = lint DENSE_RATIO / DENSE_MIN_NODES (`dense-graph`): edges > ratio x nodes on >= minNodes nodes.
   * KTD4 estimated 1.5; that fires on graphs `check` accepts (5 nodes, 8 edges), so the lint wins.
   */
  edgeRatio: DENSE_RATIO,
  edgeMinNodes: DENSE_MIN_NODES,
  /** = lint MAX_PARALLEL: more than this many edges between a pair is a `parallel-edges` pair. */
  parallel: MAX_PARALLEL,
  /** = lint MAX_DEGREE (`busy-node`). */
  degree: MAX_DEGREE,
  /** = lint MAX_DEPTH (`deep-nesting`). */
  depth: MAX_DEPTH,
  /**
   * = lint MAX_CROSS_GROUP (`cross-group-edges`): edges whose endpoints sit in different direct groups.
   * Held-out vision rejected excalidraw groups-nested renders with 7 and 9 of them; d2 passed.
   */
  crossGroup: MAX_CROSS_GROUP,
  /** = lint MAX_LINE (`long-label`): a node or edge label line longer than this tangles in excalidraw. */
  labelLine: MAX_LINE,
} as const;

export interface GraphMeasures {
  nodes: number;
  edges: number;
  /** Unordered node pairs joined by more than ROUTE_LIMITS.parallel edges (self-loops ignored). */
  parallelPairs: number;
  /** Most incident edges on one node (a self-loop counts once, like the lint). */
  maxDegree: number;
  /** Deepest group nesting; 0 without groups, 1 for a flat group. */
  groupDepth: number;
  /** Edges whose endpoints have different direct parent groups (ungrouped counts as its own). */
  crossGroupEdges: number;
  /** Node and edge labels with a line longer than ROUTE_LIMITS.labelLine. */
  longLabels: number;
}

export interface RouteOptions {
  /** `--engine`: an engine id wins over everything; "auto" applies the suggestion. */
  engine?: EngineId | "auto";
  target?: Target;
  /** Engine used when nothing forces one and the recommendation differs (usually "excalidraw"). */
  defaultEngine: EngineId;
}

export interface RouteResult {
  /** The engine to use now. */
  engine: EngineId;
  /** True only when `--engine <id>` was given. */
  explicit: boolean;
  reason: string;
  /** A better engine than `engine`; present only when the caller should be told to opt in. */
  suggestion?: EngineId;
}

/** Group depth, as the `deep-nesting` lint computes it (src/lint/rules.ts). */
function groupDepth(graph: Graph): number {
  const parent = new Map<string, string>();
  for (const g of graph.groups) for (const child of g.groups) parent.set(child, g.id);
  let max = 0;
  for (const g of graph.groups) {
    let depth = 1;
    for (let p = parent.get(g.id); p !== undefined && depth <= graph.groups.length; p = parent.get(p)) depth++;
    max = Math.max(max, depth);
  }
  return max;
}

export function measureGraph(graph: Graph): GraphMeasures {
  const pairs = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    if (e.to !== e.from) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    if (e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}\0${e.to}` : `${e.to}\0${e.from}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    parallelPairs: [...pairs.values()].filter((n) => n > ROUTE_LIMITS.parallel).length,
    maxDegree: Math.max(0, ...degree.values()),
    groupDepth: groupDepth(graph),
    crossGroupEdges: crossGroupEdges(graph).length,
    longLabels: countLongLabels(graph),
  };
}

export interface Failure {
  prefix: string;
  text: string;
}

/** Failing measures in fixed order: nodes, edges, parallel, degree, depth, cross-group, long labels. */
export function failures(m: GraphMeasures): Failure[] {
  const out: Failure[] = [];
  if (m.nodes > ROUTE_LIMITS.nodes) out.push({ prefix: "large", text: `${m.nodes} nodes` });
  if (m.nodes >= ROUTE_LIMITS.edgeMinNodes && m.edges > m.nodes * ROUTE_LIMITS.edgeRatio) out.push({ prefix: "dense", text: `${m.edges} edges` });
  if (m.parallelPairs > 0) out.push({ prefix: "dense", text: `${m.parallelPairs} parallel ${m.parallelPairs === 1 ? "pair" : "pairs"}` });
  if (m.maxDegree > ROUTE_LIMITS.degree) out.push({ prefix: "busy", text: `degree ${m.maxDegree}` });
  if (m.groupDepth > ROUTE_LIMITS.depth) out.push({ prefix: "nested", text: `depth ${m.groupDepth}` });
  if (m.crossGroupEdges > ROUTE_LIMITS.crossGroup) out.push({ prefix: "cross-linked", text: `${m.crossGroupEdges} cross-group edges` });
  if (m.longLabels > 0) out.push({ prefix: "text", text: `${m.longLabels} long ${m.longLabels === 1 ? "label" : "labels"}` });
  return out;
}

/** Longest reason that keeps the suggestion line within 20 tokens (est. chars / 4 = 80 chars). */
const MAX_REASON_CHARS = 42;

/** `prefix: first, second` from the first failing measures; drops the second if it busts the budget. */
function failReason(bad: Failure[]): string {
  const first = bad[0] as Failure;
  const two = `${first.prefix}: ${bad.slice(0, 2).map((f) => f.text).join(", ")}`;
  return two.length <= MAX_REASON_CHARS ? two : `${first.prefix}: ${first.text}`;
}

/** Engine implied by a non-graph kind, or undefined for graphs. */
function kindEngine(kind: Kind, target?: Target): EngineId | undefined {
  switch (kind) {
    case "graph":
      return undefined;
    case "sequence":
      return target === "markdown" || target === "github" ? "mermaid" : "d2";
    case "class":
    case "erd":
      return "d2";
    default:
      return "mermaid";
  }
}

const isKind = (x: Graph | Kind): x is Kind => typeof x === "string";

/**
 * KTD4: (1) explicit engine, (2) target, (3) kind, (4) graph measures.
 * `input` is a parsed Graph (kind "graph") or a Kind for native sources.
 */
export function route(input: Graph | Kind, opts: RouteOptions): RouteResult {
  const kind: Kind = isKind(input) ? input : "graph";
  if (opts.engine !== undefined && opts.engine !== "auto") return { engine: opts.engine, explicit: true, reason: "explicit" };
  const auto = opts.engine === "auto";

  let forced: { engine: EngineId; reason: string } | undefined;
  if (opts.target === "markdown" || opts.target === "github") forced = { engine: "mermaid", reason: `target ${opts.target}` };
  else if (opts.target === "editable") forced = { engine: "excalidraw", reason: "target editable" };
  else {
    const e = kindEngine(kind, opts.target);
    if (e) forced = { engine: e, reason: `kind ${kind}` };
  }
  if (forced) return { ...forced, explicit: false };

  // Graph kind with no forcing target: only a parsed Graph can be measured.
  if (isKind(input)) return { engine: opts.defaultEngine, explicit: false, reason: "kind graph" };
  const m = measureGraph(input);
  const bad = failures(m);
  const fits = bad.length === 0;
  const recommended: EngineId = fits ? "excalidraw" : "d2";
  const reason = fits ? `fits: ${m.nodes} nodes, ${m.edges} edges` : failReason(bad);
  if (auto || recommended === opts.defaultEngine) return { engine: recommended, explicit: false, reason };
  return { engine: opts.defaultEngine, explicit: false, reason, suggestion: recommended };
}

/** The single `engine:` line `check` and `draw` print. */
export function recommendationLine(r: RouteResult): string {
  if (r.suggestion) return `engine: suggest ${r.suggestion} (${r.reason}); add --engine ${r.suggestion}`;
  return `engine: ${r.engine} (${r.reason})`;
}
