// Quality rows for `draw`, `inspect` and `check`: the layout checker's findings (src/quality/analyze.ts)
// turned into fixes the agent can apply to its DSL input. Pure: scene (+ optional graph) in, rows out.
// Fix text follows docs/plans/2026-10-23-authoring-rules-plan.md section 2; thresholds mirror src/lint/rules.ts.

import type { Direction, Graph } from "../dsl/ast.js";
import { analyzeScene, type Finding } from "./analyze.js";
import type { SceneElement } from "./geom.js";

export interface QualityRow {
  code: string;
  detail: string;
  fix: string;
  severity: "hard" | "soft";
}

export interface HintOptions {
  /** Source graph: gives exact node ids, shapes and edge endpoints. Without it the scene's bindings are used. */
  graph?: Graph;
  /** Rank direction the scene was laid out in, when known. */
  direction?: Direction;
  /** Aspect ratio (long side : short side) of the same diagram laid out in `dir`; undefined when unknown. */
  probe?: (dir: Direction) => number | undefined;
}

export const HINT_DEGREE = 8; // busy-node threshold (same as lint)
export const HINT_DIAMOND = 4; // diamond-hub threshold (same as lint)
export const HINT_WORDS = 3; // edge label words
const CROSSINGS_MIN = 20; // arrow-crossings is reported above this count or above 2 x edges
const ROUTE_MIN = 3; // route-ratio is reported when at least this many arrows hit it
const HEAD_MIN = 3; // hidden / crowded arrowheads are reported when at least this many are found
const DETAIL_MAX = 150;
const PORT_GAP = 28; // px the router keeps between an arrowhead and the next arrow end on one node side (layout PORT_PITCH)
const STUB_LEN = 24; // px of straight run every arrow keeps before its arrowhead (layout FINAL_STUB)
const MERGE_LABELS = 4; // labels shown in a merge fix; more would not read as one label

interface EdgeInfo {
  from: string;
  to: string;
  label?: string;
}
interface Model {
  nodes: Map<string, { shape: string; label: string }>;
  edges: Array<EdgeInfo | undefined>;
  groups: Set<string>;
}

// ---- ids: element ids -> DSL ids ----

const dslId = (id: string): string => id.replace(/^(zone-title-|zone-g-|zone-|node-|cap-|label-)/, "");
const edgeIndex = (id: string): number | undefined => {
  const m = /^edge-(?:label-)?(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

function modelOfGraph(graph: Graph): Model {
  return {
    nodes: new Map(graph.nodes.map((n) => [n.id, { shape: n.shape, label: n.label }])),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
    groups: new Set(graph.groups.map((g) => g.id)),
  };
}

/** Best-effort model of a scene without a graph (a foreign .excalidraw file): bindings give the edge ends. */
function modelOfScene(els: SceneElement[]): Model {
  const live = els.filter((e) => !e.isDeleted);
  const m: Model = { nodes: new Map(), edges: [], groups: new Set() };
  const text = new Map<string, string>();
  for (const e of live) if (e.type === "text" && e.containerId) text.set(e.containerId, e.text ?? "");
  for (const e of live) {
    if (e.type === "diamond" || e.type === "ellipse" || e.type === "rectangle") {
      if (e.id.startsWith("zone-g-")) m.groups.add(dslId(e.id));
      else if (!e.id.startsWith("cap-") && !e.id.startsWith("zone-")) m.nodes.set(dslId(e.id), { shape: e.type, label: text.get(e.id) ?? "" });
    }
  }
  for (const e of live) {
    const i = e.type === "arrow" ? edgeIndex(e.id) : undefined;
    const [from, to] = [e.startBinding?.elementId, e.endBinding?.elementId];
    if (i !== undefined && from && to) m.edges[i] = { from: dslId(from), to: dslId(to), label: text.get(e.id) || undefined };
  }
  return m;
}

// ---- model queries ----

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
const lines = (s: string): string[] => s.split("\n");
const wordsOf = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");
const mostWords = (label: string): number => Math.max(0, ...lines(label).map((l) => wordsOf(l).length));
const edgeName = (e: EdgeInfo): string => `${e.from} -> ${e.to}`;
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

function degreeOf(m: Model, id: string): number {
  return m.edges.reduce((n, e) => n + (e && (e.from === id || e.to === id) ? 1 : 0), 0);
}

function pairEdges(m: Model, a: string, b: string): EdgeInfo[] {
  return m.edges.filter((e): e is EdgeInfo => !!e && e.from !== e.to && pairKey(e.from, e.to) === pairKey(a, b));
}

/** Label text as typed after `:`; `\n` stays an escape so the fix is one line. */
function labelSrc(labels: string[]): string {
  const body = labels.map((l) => lines(l).join("\\n")).join("\\n");
  return /[#"]|;\s*$/.test(body) ? `"${body.replace(/"/g, '\\"')}"` : body;
}

function mergeFix(m: Model, a: string, b: string): string {
  const list = pairEdges(m, a, b);
  const first = list[0]!;
  const both = list.some((e) => e.from !== first.from);
  const labels = list.map((e) => e.label ?? "").filter((l) => l !== "");
  const arrow = both ? "<->" : "->";
  const kept = labels.slice(0, MERGE_LABELS);
  const src = `${first.from} ${arrow} ${first.to}${kept.length ? ` : ${labelSrc(kept)}` : ""}`;
  const rest = labels.length > kept.length ? ` (drop or fold the other ${labels.length - kept.length} labels)` : "";
  return `merge parallel edges ${first.from} -> ${first.to} (${list.length}) into one: ${src}${rest}`;
}

function shortenFix(e: EdgeInfo): string {
  const label = e.label ?? "";
  const first = lines(label).sort((x, y) => wordsOf(y).length - wordsOf(x).length)[0] ?? "";
  const short = wordsOf(first).slice(0, HINT_WORDS).join(" ");
  return `shorten label of ${edgeName(e)} to ${HINT_WORDS} words: ${edgeName(e)} : ${labelSrc([short])}`;
}

// ---- finding -> cause ----

interface Cause {
  key: string;
  fix: string;
}

const PARALLEL_CODES = new Set(["label-on-foreign-arrow", "label-label-overlap", "parallel-edges-close", "arrowheads-crowded"]);
const DEGREE_CODES = new Set(["arrowheads-crowded", "arrow-through-node"]);
const LABEL_CODES = new Set(["label-on-foreign-arrow", "label-label-overlap", "label-on-node"]);

function causeOf(f: Finding, m: Model): Cause {
  const edges = unique(f.elements.map(edgeIndex).filter((i): i is number => i !== undefined && !!m.edges[i]));
  const info = edges.map((i) => m.edges[i]!);
  const nodes = unique([...f.elements.filter((id) => /^(node|cap)-/.test(id)).map(dslId), ...info.flatMap((e) => [e.from, e.to])]).filter((id) => m.nodes.has(id));

  if (PARALLEL_CODES.has(f.code)) {
    for (const e of info) {
      if (e.from !== e.to && pairEdges(m, e.from, e.to).length >= 3) return { key: `pair:${pairKey(e.from, e.to)}`, fix: mergeFix(m, e.from, e.to) };
    }
  }
  if (DEGREE_CODES.has(f.code)) {
    const hub = nodes.find((id) => degreeOf(m, id) > HINT_DEGREE);
    if (hub) return { key: `busy:${hub}`, fix: `'${hub}' has ${degreeOf(m, hub)} edges and every arrowhead needs a ${PORT_GAP} px slot on a node side (plus ${STUB_LEN} px of straight run): split it into two nodes or group its neighbours` };
  }
  const diamond = nodes.find((id) => m.nodes.get(id)!.shape === "diamond" && degreeOf(m, id) > HINT_DIAMOND);
  if (diamond) {
    const label = lines(m.nodes.get(diamond)!.label).join("\\n");
    return { key: `diamond:${diamond}`, fix: `make '${diamond}' a rectangle: ${diamond}[${label}]` };
  }
  if (LABEL_CODES.has(f.code)) {
    const wordy = edges.find((i) => mostWords(m.edges[i]!.label ?? "") > HINT_WORDS);
    if (wordy !== undefined) return { key: `label:${wordy}`, fix: shortenFix(m.edges[wordy]!) };
  }
  if (f.code === "zone-title-crossed") {
    const group = f.elements.find((id) => id.startsWith("zone-title-"));
    if (group) {
      const g = dslId(group);
      const via = info[0] ? `, or move the nodes of ${edgeName(info[0])} out of it` : "";
      return { key: `zone:${g}`, fix: `shorten the title of group '${g}'${via}` };
    }
  }
  const near = unique(f.elements.flatMap((id) => (edgeIndex(id) !== undefined ? [] : [dslId(id)])).concat(info.flatMap((e) => [e.from, e.to]))).slice(0, 4);
  return { key: `near:${near.join(",")}`, fix: `layout defect; simplify the diagram near ${near.length ? near.join(", ") : "the reported elements"}` };
}

/** Element ids in prose -> DSL ids: `edge-3` -> `edge a -> b`, `node-x`/`zone-g-x` -> `x`. */
function prose(detail: string, m: Model): string {
  const out = detail
    .replace(/\bedge-(?:label-)?(\d+)\b/g, (all, i: string) => (m.edges[Number(i)] ? `edge ${edgeName(m.edges[Number(i)]!)}` : all))
    .replace(/\b(?:zone-title-|zone-g-|node-|cap-)([^\s,;"()]+)/g, "$1");
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX - 3)}...` : out;
}

// ---- soft rows ----

const ROTATE: Record<Direction, Direction> = { DOWN: "RIGHT", UP: "RIGHT", RIGHT: "DOWN", LEFT: "DOWN" };

function aspectFix(f: Finding, opts: HintOptions): string {
  const now = Number(/\(([\d.]+):1\)/.exec(f.detail)?.[1] ?? NaN);
  const dir = opts.direction ? ROTATE[opts.direction] : undefined;
  const alt = dir && opts.probe ? opts.probe(dir) : undefined;
  if (dir && alt !== undefined && Number.isFinite(now) && alt < now * 0.75) return `try dir ${dir} (aspect ${now}:1 becomes ${Math.round(alt * 10) / 10}:1)`;
  return "group nodes or split the diagram so it grows in both directions";
}

/** HARD findings plus the SOFT codes worth an agent's attention, one row per (code, cause). */
export function qualityHints(scene: { elements?: SceneElement[] } | null | undefined, opts: HintOptions = {}): QualityRow[] {
  const { findings, stats } = analyzeScene(scene);
  const m = opts.graph ? modelOfGraph(opts.graph) : modelOfScene(scene?.elements ?? []);
  const rows = new Map<string, QualityRow & { n: number }>();
  const add = (key: string, row: QualityRow): void => {
    const hit = rows.get(key);
    if (hit) hit.n++;
    else rows.set(key, { ...row, n: 1 });
  };

  const route = findings.filter((f) => f.code === "route-ratio");
  for (const f of findings) {
    if (f.severity === "hard") {
      const c = causeOf(f, m);
      add(`${f.code}\0${c.key}`, { code: f.code, severity: "hard", detail: prose(f.detail, m), fix: c.fix });
    } else if (f.code === "aspect-ratio") {
      add(f.code, { code: f.code, severity: "soft", detail: f.detail, fix: aspectFix(f, opts) });
    } else if (f.code === "arrow-crossings" && (stats.crossings > CROSSINGS_MIN || stats.crossings > 2 * stats.edges)) {
      const fix =
        stats.edges > 2 * stats.nodes
          ? `${stats.edges} edges on ${stats.nodes} nodes: drop secondary edges or split the diagram; keep edges <= 2 x nodes`
          : "group related nodes or split the diagram into two .exd files";
      add(f.code, { code: f.code, severity: "soft", detail: `${stats.crossings} crossings on ${stats.edges} edges`, fix });
    }
  }
  if (route.length >= ROUTE_MIN) {
    const near = unique(route.flatMap((f) => f.elements.map((id) => m.edges[edgeIndex(id) ?? -1]).flatMap((e) => (e ? [e.from, e.to] : [])))).slice(0, 4);
    const fix =
      opts.direction === "DOWN" || opts.direction === "UP"
        ? "try dir RIGHT (long routes shrink left-to-right)"
        : `layout defect; simplify the diagram near ${near.join(", ") || "the long arrows"}`;
    add("route-ratio", { code: "route-ratio", severity: "soft", detail: `${route.length} arrows are routed over 3x their straight-line length`, fix });
  }

  // Round 5: arrowheads that are hidden (label or arrow over them), or lie closer than a pitch, on a busy node.
  const hidden = findings.filter((f) => f.code === "arrowhead-covered" || f.code === "arrowheads-close");
  if (hidden.length >= HEAD_MIN) {
    const ends = unique(hidden.flatMap((f) => f.elements.map(edgeIndex)).filter((i): i is number => i !== undefined && !!m.edges[i])).flatMap((i) => [m.edges[i]!.from, m.edges[i]!.to]);
    const hub = unique(ends).sort((a, b) => degreeOf(m, b) - degreeOf(m, a) || (a < b ? -1 : 1))[0];
    const fix =
      hub !== undefined && degreeOf(m, hub) > HINT_DEGREE / 2
        ? `'${hub}' has ${degreeOf(m, hub)} edges and arrowheads need a ${PORT_GAP} px slot each (and clear space in front of them): split it into two nodes, or shorten the labels of its edges`
        : "shorten the labels of the edges involved (a label sits over the arrowhead on a short edge) or merge parallel edges";
    add("arrowhead-covered", { code: "arrowhead-covered", severity: "soft", detail: `${hidden.length} arrowheads are hidden by a label or arrow, or closer than ${PORT_GAP} px to another`, fix });
  }

  return [...rows.values()]
    .map(({ n, ...row }) => (n > 1 ? { ...row, detail: `${row.detail} (+${n - 1} more)` } : row))
    .sort((a, b) => Number(b.severity === "hard") - Number(a.severity === "hard") || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
