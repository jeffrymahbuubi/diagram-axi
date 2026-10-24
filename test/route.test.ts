// Router tests (U4 / KTD4): a 20+ graph threshold table, the rule precedence, the one-line
// wording budget, and agreement with the `check` lints over the curated and fuzz corpora.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Edge, Graph, Group, Node } from "../src/dsl/ast.js";
import { parse } from "../src/dsl/parser.js";
import { ROUTE_LIMITS, measureGraph, recommendationLine, route, type Kind } from "../src/engines/route.js";
import { lint } from "../src/lint/rules.js";

// ---- graph builders -------------------------------------------------------------------------

const node = (id: string): Node => ({ id, label: id, shape: "rect", flags: [], line: 1, col: 1 });
const edge = (from: string, to: string): Edge => ({ from, to, arrow: "solid", line: 1, col: 1 });
const group = (id: string, children: string[], groups: string[] = []): Group => ({ id, children, groups, flags: [], line: 1, col: 1 });
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `n${i + 1}`);

/** Graph with n nodes and the given edges (ids n1..nN). */
function graph(n: number, edges: [string, string][] = [], groups: Group[] = []): Graph {
  return { nodes: ids(n).map(node), edges: edges.map(([a, b]) => edge(a, b)), groups };
}
/** Chain n1 -> n2 -> ... (n-1 edges). */
const chain = (n: number): [string, string][] => ids(n).slice(1).map((id, i) => [`n${i + 1}`, id]);
/** The first `count` distinct unordered pairs of n nodes (no parallel edges, degree <= n-1). */
function pairs(n: number, count: number): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 1; i <= n && out.length < count; i++) for (let j = i + 1; j <= n && out.length < count; j++) out.push([`n${i}`, `n${j}`]);
  return out;
}
/** Circulant graph: n nodes, each joined to the next k (n*k distinct edges, degree 2k). */
const ring = (n: number, k: number): [string, string][] =>
  ids(n).flatMap((_, i) => Array.from({ length: k }, (_, d): [string, string] => [`n${i + 1}`, `n${((i + d + 1) % n) + 1}`]));
const star = (leaves: number): Graph => graph(leaves + 1, ids(leaves + 1).slice(1).map((l) => ["n1", l]));
/** Nested single-child groups of the given depth around n1 (group g1 holds g2 holds ...). */
function nested(depth: number): Graph {
  const gs = Array.from({ length: depth }, (_, i) => group(`g${i + 1}`, i === depth - 1 ? ["n1"] : [], i < depth - 1 ? [`g${i + 2}`] : []));
  return graph(2, [["n1", "n2"]], gs);
}
/** Two flat groups A (n1-n4) and B (n5-n8) joined by `cross` edges, nothing else. */
function twoGroups(cross: number): Graph {
  const e: [string, string][] = [];
  for (let i = 1; i <= 4 && e.length < cross; i++) for (let j = 5; j <= 8 && e.length < cross; j++) e.push([`n${i}`, `n${j}`]);
  return graph(8, e, [group("A", ids(4)), group("B", ["n5", "n6", "n7", "n8"])]);
}

/** `n1 -> n2` with the given edge label, plus node labels by id (n1.. ; others keep their id). */
function labelled(edgeLabel?: string, nodeLabels: Record<string, string> = {}): Graph {
  const g = graph(2, [["n1", "n2"]]);
  g.nodes = g.nodes.map((n) => ({ ...n, label: nodeLabels[n.id] ?? n.label }));
  if (edgeLabel !== undefined) g.edges = g.edges.map((e) => ({ ...e, label: edgeLabel }));
  return g;
}
const chars = (n: number): string => "x".repeat(n);
/** The same graph with every node label 41 chars long. */
const longNodes = (g: Graph): Graph => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, label: chars(41) })) });

const DEFAULT = { defaultEngine: "excalidraw" } as const;

// ---- threshold table ------------------------------------------------------------------------

interface Row {
  name: string;
  g: Graph;
  /** Undefined = fits excalidraw; otherwise the reason prefix and a fragment the reason must contain. */
  fail?: [prefix: string, fragment: string];
}

const TABLE: Row[] = [
  { name: "empty graph", g: graph(0) },
  { name: "single node", g: graph(1) },
  { name: "25 nodes (limit)", g: graph(25, chain(25)) },
  { name: "26 nodes", g: graph(26, chain(26)), fail: ["large", "26 nodes"] },
  { name: "6 nodes, 12 edges (2.0x, limit)", g: graph(6, ring(6, 2)) },
  { name: "6 nodes, 13 edges (>2.0x)", g: graph(6, [...ring(6, 2), ["n1", "n4"]]), fail: ["dense", "13 edges"] },
  { name: "5 nodes, 10 edges (below the 6-node floor)", g: graph(5, pairs(5, 10)) },
  { name: "20 nodes, 40 edges (limit)", g: graph(20, ring(20, 2)) },
  { name: "20 nodes, 41 edges", g: graph(20, [...ring(20, 2), ["n1", "n10"]]), fail: ["dense", "41 edges"] },
  { name: "2 parallel edges (limit)", g: graph(2, [["n1", "n2"], ["n1", "n2"]]) },
  { name: "2 edges, one each way", g: graph(2, [["n1", "n2"], ["n2", "n1"]]) },
  { name: "3 parallel edges", g: graph(2, [["n1", "n2"], ["n1", "n2"], ["n1", "n2"]]), fail: ["dense", "1 parallel pair"] },
  { name: "3 edges mixing directions", g: graph(2, [["n1", "n2"], ["n2", "n1"], ["n1", "n2"]]), fail: ["dense", "1 parallel pair"] },
  { name: "two triple pairs", g: graph(4, [["n1", "n2"], ["n1", "n2"], ["n1", "n2"], ["n3", "n4"], ["n3", "n4"], ["n3", "n4"]]), fail: ["dense", "2 parallel pairs"] },
  { name: "self-loops are not parallel pairs", g: graph(1, [["n1", "n1"], ["n1", "n1"], ["n1", "n1"]]) },
  { name: "degree 8 (limit)", g: star(8) },
  { name: "degree 9", g: star(9), fail: ["busy", "degree 9"] },
  { name: "group depth 2 (limit)", g: nested(2) },
  { name: "group depth 3", g: nested(3), fail: ["nested", "depth 3"] },
  { name: "6 cross-group edges (limit)", g: twoGroups(6) },
  { name: "7 cross-group edges", g: twoGroups(7), fail: ["cross-linked", "7 cross-group edges"] },
  { name: "10 cross-group edges", g: twoGroups(10), fail: ["cross-linked", "10 cross-group edges"] },
  { name: "node label line of 40 chars (limit)", g: labelled(undefined, { n1: chars(40) }) },
  { name: "node label line of 41 chars", g: labelled(undefined, { n1: chars(41) }), fail: ["text", "1 long label"] },
  { name: "edge label line of 40 chars (limit)", g: labelled(chars(40)) },
  { name: "edge label line of 41 chars", g: labelled(chars(41)), fail: ["text", "1 long label"] },
  { name: "long label total but every line within 40", g: labelled(undefined, { n1: `${chars(30)}\n${chars(30)}` }) },
  { name: "only the second label line is over 40", g: labelled(undefined, { n1: `short\n${chars(41)}` }), fail: ["text", "1 long label"] },
  { name: "node and edge long labels are counted together", g: labelled(chars(45), { n1: chars(50), n2: chars(41) }), fail: ["text", "3 long labels"] },
  { name: "ungrouped to grouped edge crosses a boundary", g: graph(3, [["n1", "n3"], ["n2", "n3"]], [group("A", ["n1", "n2"])]) },
  { name: "edges inside one group do not cross", g: graph(4, pairs(4, 6), [group("A", ids(4))]) },
  { name: "two failing measures list both, in order", g: graph(26, [...chain(26), ["n1", "n2"], ["n1", "n2"]]), fail: ["large", "26 nodes, 1 parallel pair"] },
  { name: "long labels come last: a large graph names size first", g: longNodes(graph(26, chain(26))), fail: ["large", "26 nodes, 26 long labels"] },
  { name: "three failing measures list the first two", g: graph(26, [...star(25).edges.map((e): [string, string] => [e.from, e.to]), ["n2", "n3"], ["n2", "n3"], ["n2", "n3"]]), fail: ["large", "26 nodes, 1 parallel pair"] },
];

describe("threshold table", () => {
  it("has at least 20 graphs", () => expect(TABLE.length).toBeGreaterThanOrEqual(20));

  for (const row of TABLE) {
    it(row.name, () => {
      const r = route(row.g, DEFAULT);
      expect(r.explicit).toBe(false);
      if (row.fail === undefined) {
        expect(r).toMatchObject({ engine: "excalidraw", reason: expect.stringMatching(/^fits: \d+ nodes, \d+ edges$/) });
        expect(r.suggestion).toBeUndefined();
      } else {
        const [prefix, fragment] = row.fail;
        expect(r.engine).toBe("excalidraw"); // never switches silently
        expect(r.suggestion).toBe("d2");
        expect(r.reason.startsWith(`${prefix}: `)).toBe(true);
        expect(r.reason).toContain(fragment);
      }
    });
  }

  it("limits that have a lint peer are the lint's own constants", () => {
    expect(ROUTE_LIMITS).toMatchObject({ nodes: 25, edgeRatio: 2, edgeMinNodes: 6, parallel: 2, degree: 8, depth: 2, crossGroup: 6, labelLine: 40 });
  });

  it("measures", () => {
    expect(measureGraph(star(9))).toEqual({ nodes: 10, edges: 9, parallelPairs: 0, maxDegree: 9, groupDepth: 0, crossGroupEdges: 0, longLabels: 0 });
    expect(measureGraph(nested(3)).groupDepth).toBe(3);
    expect(measureGraph(graph(0)).maxDegree).toBe(0);
  });
});

// ---- precedence and wording ------------------------------------------------------------------

describe("rule precedence", () => {
  const dense = graph(2, [["n1", "n2"], ["n1", "n2"], ["n1", "n2"]]);

  it("explicit --engine wins over target, kind and measures", () => {
    expect(route(dense, { ...DEFAULT, engine: "mermaid", target: "editable" })).toEqual({ engine: "mermaid", explicit: true, reason: "explicit" });
    expect(route("sequence", { ...DEFAULT, engine: "excalidraw" })).toMatchObject({ engine: "excalidraw", explicit: true });
  });

  it("target markdown and github force mermaid for every kind, editable forces excalidraw", () => {
    for (const target of ["markdown", "github"] as const) {
      expect(route(dense, { ...DEFAULT, target })).toEqual({ engine: "mermaid", explicit: false, reason: `target ${target}` });
      expect(route("erd", { ...DEFAULT, target }).engine).toBe("mermaid");
      expect(route("class", { ...DEFAULT, target }).engine).toBe("mermaid");
    }
    expect(route(dense, { ...DEFAULT, target: "editable" })).toEqual({ engine: "excalidraw", explicit: false, reason: "target editable" });
    expect(route("sequence", { ...DEFAULT, target: "editable" }).engine).toBe("excalidraw");
  });

  it("kinds map to engines", () => {
    const want: Record<string, string> = { sequence: "d2", class: "d2", erd: "d2", state: "mermaid", timeline: "mermaid", gitgraph: "mermaid", mindmap: "mermaid" };
    for (const [kind, engine] of Object.entries(want)) {
      expect(route(kind as Kind, DEFAULT)).toEqual({ engine, explicit: false, reason: `kind ${kind}` });
    }
  });

  it("graph kind without a graph keeps the default engine", () => {
    expect(route("graph", DEFAULT)).toEqual({ engine: "excalidraw", explicit: false, reason: "kind graph" });
  });

  it("--engine auto applies the suggestion without flagging it", () => {
    expect(route(dense, { ...DEFAULT, engine: "auto" })).toEqual({ engine: "d2", explicit: false, reason: "dense: 1 parallel pair" });
    expect(route(graph(3, chain(3)), { ...DEFAULT, engine: "auto" }).engine).toBe("excalidraw");
  });

  it("no suggestion when the recommendation is already the default engine", () => {
    expect(route(dense, { defaultEngine: "d2" })).toEqual({ engine: "d2", explicit: false, reason: "dense: 1 parallel pair" });
  });
});

describe("recommendation line", () => {
  it("wording", () => {
    expect(recommendationLine(route(graph(12, chain(12)), DEFAULT))).toBe("engine: excalidraw (fits: 12 nodes, 11 edges)");
    expect(recommendationLine(route(graph(2, [["n1", "n2"], ["n1", "n2"], ["n1", "n2"]]), DEFAULT))).toBe(
      "engine: suggest d2 (dense: 1 parallel pair); add --engine d2",
    );
    expect(recommendationLine(route(labelled(chars(41), { n1: chars(41) }), DEFAULT))).toBe("engine: suggest d2 (text: 2 long labels); add --engine d2");
    expect(recommendationLine(route(labelled(chars(41)), DEFAULT))).toBe("engine: suggest d2 (text: 1 long label); add --engine d2");
    expect(recommendationLine(route("sequence", DEFAULT))).toBe("engine: d2 (kind sequence)");
    expect(recommendationLine(route("state", { ...DEFAULT, target: "markdown" }))).toBe("engine: mermaid (target markdown)");
    expect(recommendationLine(route("class", { ...DEFAULT, engine: "mermaid" }))).toBe("engine: mermaid (explicit)");
  });

  it("stays within 20 tokens even for extreme measures", () => {
    const g = graph(300, [...pairs(300, 700), ...Array.from({ length: 30 }, () => ["n1", "n2"] as [string, string])]);
    const line = recommendationLine(route(g, DEFAULT));
    expect(line.startsWith("engine: suggest d2 (large: 300 nodes")).toBe(true);
    expect(tokens(line)).toBeLessThanOrEqual(20);
    const cross = recommendationLine(route(twoGroups(16), { ...DEFAULT }));
    expect(tokens(cross)).toBeLessThanOrEqual(20);
  });
});

// ---- corpus -----------------------------------------------------------------------------------

/** Same estimate as scripts/token-compare.mjs: ceil(chars / 4). */
const tokens = (s: string): number => Math.ceil(s.length / 4);
const dirOf = (d: string): string => fileURLToPath(new URL(`./${d}/`, import.meta.url));
const exdFiles = (d: string): [string, string][] =>
  readdirSync(dirOf(d)).filter((f) => f.endsWith(".exd")).map((f) => [f, readFileSync(dirOf(d) + f, "utf8")]);

/** Lint codes that explain a `suggest d2`. `many-nodes` is the lint peer of the 25-node limit. */
const EXPLAINS = ["dense-graph", "parallel-edges", "busy-node", "too-many-nodes", "many-nodes", "deep-nesting", "long-label", "cross-group-edges"];

describe("corpus", () => {
  const curated = exdFiles("qa/corpus");
  const all = [...curated, ...exdFiles("qa/fuzz-corpus"), ...exdFiles("fixtures"), ...exdFiles("../docs/examples")];

  it("curated corpus has 68 files", () => expect(curated).toHaveLength(68));

  it("every .exd yields a recommendation line of at most 20 tokens", () => {
    for (const [file, src] of all) {
      const parsed = parse(src);
      if (parsed.diagnostics.some((d) => d.severity === "error")) continue; // error fixtures never reach routing
      const line = recommendationLine(route(parsed.graph, DEFAULT));
      expect(line.startsWith("engine: "), file).toBe(true);
      expect(line.includes("\n"), file).toBe(false);
      expect(tokens(line), `${file}: ${line}`).toBeLessThanOrEqual(20);
    }
  });

  it("routing and check lints agree on the curated files", () => {
    let suggested = 0;
    for (const [file, src] of curated) {
      const { graph } = parse(src);
      const codes = new Set(lint(graph).map((d) => d.code as string));
      const r = route(graph, DEFAULT);
      const explained = EXPLAINS.filter((c) => codes.has(c));
      if (r.suggestion) {
        suggested++;
        expect(explained.length, `${file}: suggest d2 without a lint (${r.reason})`).toBeGreaterThan(0);
      } else {
        // the reverse: a lint that mirrors a router limit never fires on a graph that "fits"
        expect(explained, `${file}: fits but check warns`).toEqual([]);
      }
    }
    expect(suggested).toBeGreaterThan(0);
  });

  it("the reverse holds on the fuzz corpus", () => {
    for (const [file, src] of exdFiles("qa/fuzz-corpus")) {
      const parsed = parse(src);
      if (parsed.diagnostics.some((d) => d.severity === "error")) continue;
      const codes = lint(parsed.graph).map((d) => d.code as string);
      if (EXPLAINS.some((c) => codes.includes(c))) expect(route(parsed.graph, DEFAULT).suggestion, file).toBe("d2");
    }
  });
});
