// Shared AST contract for the exd DSL. Types only: the parser (src/dsl/parser.ts)
// produces a Graph, layout and scene builders consume it. Positions are
// 1-based (line, col) into the source text.

export type Direction = "DOWN" | "RIGHT" | "UP" | "LEFT";

/** `[text]` rect, `(text)` ellipse, `{text}` diamond, `[(text)]` cylinder. */
export type ShapeKind = "rect" | "ellipse" | "diamond" | "cylinder";

export type ColorName = "blue" | "green" | "orange" | "purple" | "red" | "yellow" | "teal" | "pink";

/** `dashed` and `dotted` set strokeStyle, `bold` = strokeWidth 4, `sketchy` = roughness 2. */
export type StyleFlag = "dashed" | "dotted" | "bold" | "sketchy";

/** `->` solid, `-->` dashed, `--` line (no heads), `<->` both heads, `-.->` dotted. */
export type ArrowKind = "solid" | "dashed" | "line" | "both" | "dotted";

export interface Node {
  id: string;
  /** Label text; `\n` in the source is already converted to a real newline. */
  label: string;
  shape: ShapeKind;
  /** Undefined when no color token was given (builder applies the default fill). */
  color?: ColorName;
  flags: StyleFlag[];
  /** True when created from an edge reference without a declaration (R4); label is the id. */
  implicit?: boolean;
  line: number;
  col: number;
}

export interface Edge {
  from: string;
  to: string;
  arrow: ArrowKind;
  label?: string;
  line: number;
  col: number;
}

/**
 * Groups are flat in Graph.groups and reference each other by id. A node or
 * group belongs to at most one group. Root groups are those not listed in any
 * other group's `groups`.
 */
export interface Group {
  id: string;
  title?: string;
  color?: ColorName;
  flags: StyleFlag[];
  /** Ids of nodes directly inside this group. */
  children: string[];
  /** Ids of groups directly nested inside this group. */
  groups: string[];
  line: number;
  col: number;
}

export interface Graph {
  /** Set only when the DSL contains a direction line (it overrides --direction). */
  direction?: Direction;
  title?: string;
  /** In declaration order. */
  nodes: Node[];
  /** In source order; a chain `a -> b -> c` yields two edges. */
  edges: Edge[];
  groups: Group[];
}

export type Severity = "error" | "warning";

/** Parser codes first, then semantic lint codes emitted by `check`. */
export type DiagnosticCode =
  | "expected-token"
  | "duplicate-node"
  | "unknown-color"
  | "unknown-flag"
  | "unknown-direction"
  | "implicit-node"
  | "empty-label"
  | "unclosed-group"
  | "too-many-nodes"
  | "deep-nesting"
  | "long-label"
  | "parallel-edges"
  | "busy-node"
  | "diamond-hub"
  | "dense-graph"
  | "wordy-edge-label"
  | "reciprocal-pair"
  | "many-nodes"
  | "cross-group-edges";

export interface Diagnostic {
  line: number;
  col: number;
  code: DiagnosticCode;
  message: string;
  suggestion?: string;
  severity: Severity;
}

export interface ParseOptions {
  /** Source name used in messages only. */
  file?: string;
}

export interface ParseResult {
  graph: Graph;
  diagnostics: Diagnostic[];
}
