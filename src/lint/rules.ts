// Semantic lint for `check`: rules that need the whole parsed Graph (no layout). Every
// warning carries a literal, paste-able DSL suggestion that parses and clears its own lint.
// Thresholds come from the fuzz evidence in docs/plans/2026-10-23-authoring-rules-plan.md.

import type { ArrowKind, Diagnostic, DiagnosticCode, Edge, Graph, Node } from "../dsl/ast.js";
import { makeWarning } from "../dsl/diagnostics.js";
import { ARROWS } from "../dsl/tokens.js";

export const MAX_NODES = 60; // too-many-nodes above this
export const MAX_DEPTH = 2; // deep-nesting above this
export const MAX_LINE = 40; // long-label: chars per label line
export const MANY_NODES = 25; // many-nodes above this (up to MAX_NODES)
export const MAX_PARALLEL = 2; // parallel-edges above this many edges per node pair
export const MAX_DEGREE = 8; // busy-node above this many incident edges
export const MAX_CROSS_GROUP = 6; // cross-group-edges above this many edges between different direct groups
export const MAX_DIAMOND_DEGREE = 4; // diamond-hub above this many incident edges
export const DENSE_MIN_NODES = 6; // dense-graph needs at least this many nodes ...
export const DENSE_RATIO = 2; // ... and more than this many edges per node
export const MAX_EDGE_WORDS = 3; // wordy-edge-label: words per edge label line
export const MAX_EDGE_LINE = 30; // wordy-edge-label: chars per edge label line
export const BREAK_MAX_WORDS = 6; // 4..6 words: break the label; more: shorten it

/** Warnings that `check --strict` does not count (stylistic only: `<->` drops directionality). */
export const STRICT_EXEMPT: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>(["reciprocal-pair"]);

const ARROW_TOKEN = new Map<ArrowKind, string>(ARROWS.map(([text, kind]) => [kind, text]));
const arrowText = (kind: ArrowKind): string => ARROW_TOKEN.get(kind) ?? "->";

const lines = (label: string): string[] => label.split("\n");
const longest = (label: string): number => Math.max(0, ...lines(label).map((l) => l.length));
const wordsOf = (line: string): string[] => line.split(/\s+/).filter((w) => w !== "");
const mostWords = (label: string): number => Math.max(0, ...lines(label).map((l) => wordsOf(l).length));

/** Edge label text as it must be typed after `:`; quoted when `#`, `"` or a trailing `;` would be eaten. */
function edgeLabelSrc(label: string): string {
  const body = lines(label).join("\\n");
  return /[#"]|;\s*$/.test(body) ? `"${body.replace(/"/g, '\\"')}"` : body;
}

const edgeSrc = (from: string, arrow: string, to: string, label?: string): string =>
  label === undefined || label === "" ? `${from} ${arrow} ${to}` : `${from} ${arrow} ${to} : ${edgeLabelSrc(label)}`;

/** First words of a line that fit the edge-label limits; cuts a lone over-long word. */
function shortenLine(line: string): string {
  const out: string[] = [];
  for (const w of wordsOf(line).slice(0, MAX_EDGE_WORDS)) {
    if ([...out, w].join(" ").length > MAX_EDGE_LINE) break;
    out.push(w);
  }
  return out.length > 0 ? out.join(" ") : line.trim().slice(0, MAX_EDGE_LINE - 2);
}

/** Splits a line in two so the longer half is as short as possible; undefined for a lone word. */
function balancedSplit(words: string[]): string[] | undefined {
  let best: string[] | undefined;
  let bestLen = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    if (Math.max(a.length, b.length) < bestLen) {
      bestLen = Math.max(a.length, b.length);
      best = [a, b];
    }
  }
  return best;
}

const fits = (parts: string[]): boolean => parts.every((p) => p.length <= MAX_EDGE_LINE && wordsOf(p).length <= MAX_EDGE_WORDS);

/** Rewrites an over-limit label line; `broke` tells whether it was split (else it was shortened). */
function fixLine(line: string): { parts: string[]; broke: boolean } {
  const words = wordsOf(line);
  let split: string[] | undefined;
  if (words.length > MAX_EDGE_WORDS && words.length <= BREAK_MAX_WORDS) {
    split = [words.slice(0, MAX_EDGE_WORDS).join(" "), words.slice(MAX_EDGE_WORDS).join(" ")];
  } else if (words.length >= 2 && words.length <= MAX_EDGE_WORDS) {
    split = balancedSplit(words);
  }
  if (split && fits(split)) return { parts: split, broke: true };
  return { parts: [shortenLine(line)], broke: false };
}

function wordyEdge(e: Edge, label: string): Diagnostic | undefined {
  const words = mostWords(label);
  const chars = longest(label);
  if (chars > MAX_LINE) return undefined; // long-label wins
  if (words <= MAX_EDGE_WORDS && chars <= MAX_EDGE_LINE) return undefined;

  const fixed = lines(label).map((l) =>
    wordsOf(l).length > MAX_EDGE_WORDS || l.length > MAX_EDGE_LINE ? fixLine(l) : { parts: [l], broke: false },
  );
  const broke = fixed.some((f) => f.broke);
  const next = fixed.flatMap((f) => f.parts).join("\n");
  const suggestion = `${broke ? "break it" : "shorten it"}: ${edgeSrc(e.from, arrowText(e.arrow), e.to, next)}`;
  const message =
    words > MAX_EDGE_WORDS
      ? `label of edge ${e.from} -> ${e.to} has ${words} words; keep edge labels to ${MAX_EDGE_WORDS} words`
      : `label of edge ${e.from} -> ${e.to} has a ${chars}-char line; keep edge label lines under ${MAX_EDGE_LINE} chars`;
  return makeWarning("wordy-edge-label", e.line, e.col, message, suggestion);
}

function parallelAndReciprocal(graph: Graph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const pairs = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}\0${e.to}` : `${e.to}\0${e.from}`;
    const list = pairs.get(key);
    if (list) list.push(e);
    else pairs.set(key, [e]);
  }
  for (const list of pairs.values()) {
    const first = list[0] as Edge;
    if (list.length > MAX_PARALLEL) {
      const labels = list.flatMap((e) => (e.label === undefined || e.label === "" ? [] : [e.label]));
      const both = list.some((e) => e.from !== first.from) || list.some((e) => e.arrow === "both");
      const arrow = both ? "<->" : arrowText(first.arrow);
      out.push(
        makeWarning(
          "parallel-edges",
          first.line,
          first.col,
          `${list.length} edges between '${first.from}' and '${first.to}'; parallel arrows crowd arrowheads and labels`,
          `merge them: ${edgeSrc(first.from, arrow, first.to, labels.length > 0 ? labels.join("\n") : undefined)}`,
        ),
      );
    } else if (list.length === 2) {
      const second = list[1] as Edge;
      const plain = (e: Edge) => e.arrow !== "both" && e.arrow !== "line";
      if (second.from === first.to && plain(first) && first.arrow === second.arrow && first.label === second.label) {
        out.push(
          makeWarning(
            "reciprocal-pair",
            first.line,
            first.col,
            `'${first.from} -> ${first.to}' and '${first.to} -> ${first.from}' carry the same label; two arrows where one two-headed arrow reads better`,
            edgeSrc(first.from, "<->", first.to, first.label),
          ),
        );
      }
    }
  }
  return out;
}

function degrees(graph: Graph): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    if (e.to !== e.from) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return deg;
}

function freeIds(graph: Graph, prefix: string, count: number): string[] {
  const taken = new Set<string>([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  const ids: string[] = [];
  for (let i = 1; ids.length < count; i++) if (!taken.has(`${prefix}${i}`)) ids.push(`${prefix}${i}`);
  return ids;
}

function rectSrc(n: Node): string {
  const style = [...(n.color ? [n.color] : []), ...n.flags];
  return `${n.id}[${lines(n.label).join("\\n")}]${style.length > 0 ? ` :${style.join(",")}` : ""}`;
}

function hubs(graph: Graph): Diagnostic[] {
  const out: Diagnostic[] = [];
  const deg = degrees(graph);
  for (const n of graph.nodes) {
    const d = deg.get(n.id) ?? 0;
    if (n.shape === "diamond" && d > MAX_DIAMOND_DEGREE) {
      out.push(makeWarning("diamond-hub", n.line, n.col, `diamond '${n.id}' has ${d} connections; diamonds route poorly past ${MAX_DIAMOND_DEGREE}`, `make it a rectangle: ${rectSrc(n)}`));
    }
    if (d > MAX_DEGREE) {
      const [g] = freeIds(graph, "g", 1) as [string];
      const [w1, w2] = freeIds(graph, "w", 2) as [string, string];
      out.push(
        makeWarning(
          "busy-node",
          n.line,
          n.col,
          `'${n.id}' has ${d} edges; ports get closer than an arrowhead`,
          `split '${n.id}' into two nodes or move its neighbours into a group: group ${g} "Workers" { ${w1}[...]; ${w2}[...] }`,
        ),
      );
    }
  }
  return out;
}

/** Edges whose endpoints have different direct parent groups (an ungrouped node counts as its own). */
export function crossGroupEdges(graph: Graph): Edge[] {
  const owner = new Map<string, string>();
  for (const g of graph.groups) for (const id of g.children) owner.set(id, g.id);
  return graph.edges.filter((e) => owner.get(e.from) !== owner.get(e.to));
}

/** Labels (nodes and edges) with a line over MAX_LINE: the population of the `long-label` lint. */
export function countLongLabels(graph: Graph): number {
  const nodes = graph.nodes.filter((n) => longest(n.label) > MAX_LINE).length;
  return nodes + graph.edges.filter((e) => e.label !== undefined && longest(e.label) > MAX_LINE).length;
}

/** Lint that needs the whole graph, so it only runs when the parse succeeded. */
export function lint(graph: Graph): Diagnostic[] {
  const out: Diagnostic[] = [];

  const extra = graph.nodes[MAX_NODES];
  if (extra) {
    out.push(
      makeWarning("too-many-nodes", extra.line, extra.col, `diagram has ${graph.nodes.length} nodes; layouts above ${MAX_NODES} get hard to read`, "split it into several diagrams"),
    );
  } else {
    const busy = graph.nodes[MANY_NODES];
    if (busy) {
      out.push(
        makeWarning(
          "many-nodes",
          busy.line,
          busy.col,
          `diagram has ${graph.nodes.length} nodes; readability drops past ${MANY_NODES} (crossings grow ~5x)`,
          'group related nodes (group id "Title" { ... }) or split into two .exd files',
        ),
      );
    }
  }

  const parent = new Map<string, string>();
  for (const g of graph.groups) for (const child of g.groups) parent.set(child, g.id);
  for (const g of graph.groups) {
    let depth = 1;
    for (let p = parent.get(g.id); p !== undefined && depth <= graph.groups.length; p = parent.get(p)) depth++;
    if (depth > MAX_DEPTH) {
      out.push(makeWarning("deep-nesting", g.line, g.col, `group '${g.id}' is nested ${depth} levels deep; edges between clusters route poorly past ${MAX_DEPTH}`, "flatten the groups"));
    }
  }

  for (const n of graph.nodes) {
    if (longest(n.label) > MAX_LINE) {
      out.push(makeWarning("long-label", n.line, n.col, `label of '${n.id}' has a ${longest(n.label)}-char line; keep lines under ${MAX_LINE}`, "break the label with \\n"));
    }
  }
  for (const e of graph.edges) {
    if (e.label !== undefined && longest(e.label) > MAX_LINE) {
      out.push(makeWarning("long-label", e.line, e.col, `label of edge ${e.from} -> ${e.to} has a ${longest(e.label)}-char line; keep lines under ${MAX_LINE}`, "shorten it or break it with \\n"));
    }
  }

  out.push(...parallelAndReciprocal(graph), ...hubs(graph));

  const cross = crossGroupEdges(graph);
  const past = cross[MAX_CROSS_GROUP];
  if (past) {
    out.push(
      makeWarning(
        "cross-group-edges",
        past.line,
        past.col,
        `${cross.length} edges cross group boundaries; cross-group routes tangle past ${MAX_CROSS_GROUP}`,
        "move linked nodes into one group or split the diagram",
      ),
    );
  }

  const first = graph.edges[0];
  if (first && graph.nodes.length >= DENSE_MIN_NODES && graph.edges.length > DENSE_RATIO * graph.nodes.length) {
    const per = (graph.edges.length / graph.nodes.length).toFixed(1);
    out.push(
      makeWarning(
        "dense-graph",
        first.line,
        first.col,
        `${graph.edges.length} edges on ${graph.nodes.length} nodes (${per} per node); expect many crossings`,
        `drop secondary edges or split into two diagrams; keep edges <= ${DENSE_RATIO} x nodes`,
      ),
    );
  }

  for (const e of graph.edges) {
    if (e.label === undefined) continue;
    const w = wordyEdge(e, e.label);
    if (w) out.push(w);
  }
  return out;
}
