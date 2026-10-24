// Layout engine contract. Implemented by src/layout/dagre-layout.ts; kept as an
// interface so another engine (elk) can be added later. All coordinates are
// absolute scene pixels with a top-left origin (dagre centers are converted).

import type { Direction, Graph } from "../dsl/ast.js";

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned box, top-left anchored. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Measured label text (static Excalifont metrics, no browser). */
export interface TextMetrics {
  lines: string[];
  width: number;
  height: number;
}

export interface LayoutInput {
  graph: Graph;
  /** Already resolved: graph.direction ?? --direction ?? "DOWN". */
  direction: Direction;
  /** Work units the layout may spend before it settles for the best result so far (default LAYOUT_BUDGET). */
  budget?: number;
}

export interface PositionedNode extends Box {
  id: string;
  text: TextMetrics;
}

export interface PositionedEdge {
  /** Index into graph.edges. */
  index: number;
  from: string;
  to: string;
  /** Waypoints source to target, at least 2, absolute coordinates. */
  points: Point[];
  /** Reserved label box (center-anchored text goes inside it) when the edge has a label. */
  label?: Box & { text: TextMetrics };
}

export interface PositionedGroup extends Box {
  id: string;
  /** Box reserved for the zone title when the group has one. */
  titleBox?: Box;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** Includes nested groups; ordered parents before children. */
  groups: PositionedGroup[];
  /** Bounds enclosing every node, edge point and group. */
  bounds: Box;
}

export interface LayoutEngine {
  layout(input: LayoutInput): LayoutResult;
}
