// Mermaid geometry (KTD5): the raw boxes and routes measured in the page (inpage.ts) become a
// NeutralScene, which neutral.ts turns into scene elements for the one quality checker.

import { RULES } from "../../quality/analyze.js";
import type { SceneElement } from "../../quality/geom.js";
import { HEAD_WIDTH, toScene, type NeutralBox, type NeutralEdge, type NeutralLabel, type NeutralNode, type NeutralScene, type NeutralShape } from "../neutral.js";
import type { Geometry, Kind } from "../types.js";
import type { RawBox, RawGeometry, RawNode } from "./inpage.js";

/** Counts `inspect` reports (KTD7), from the same measurements the checker uses. */
export interface MermaidStats {
  /** `aria-roledescription` of the svg. */
  role: string;
  nodes: number;
  edges: number;
  clusters: number;
  /** Drawing size in svg user units. */
  width: number;
  height: number;
  /** Per-kind counts: participants/messages, classes/relations, tables/columns/relations, states/transitions, commits/branches, ... */
  extra: Record<string, number>;
}

/** Diagram kind from the svg's `aria-roledescription`. */
export function kindOfRole(role: string): Kind | undefined {
  if (role.startsWith("flowchart")) return "graph";
  if (role === "sequence") return "sequence";
  if (role.startsWith("class")) return "class";
  if (role === "er") return "erd";
  if (role.startsWith("stateDiagram")) return "state";
  if (role === "timeline") return "timeline";
  if (role === "gitGraph") return "gitgraph";
  if (role === "mindmap") return "mindmap";
  return undefined;
}

/** Kinds whose drawing is not a node-edge layout the checker can read; they report counts only. */
const AGGREGATE_ONLY = new Set<Kind>(["gitgraph", "mindmap", "timeline"]);

const SHAPES: Record<string, NeutralShape> = { rect: "rectangle", circle: "ellipse", ellipse: "ellipse", path: "other", g: "rectangle" };

function shapeOf(n: RawNode): NeutralShape {
  if (n.curve === "arc") return "cylinder";
  if (n.tag === "polygon") return n.sides === 4 ? "diamond" : n.sides === 6 ? "hexagon" : "other";
  return SHAPES[n.tag] ?? "rectangle";
}

const area = (b: RawBox): number => b.w * b.h;
const contains = (outer: RawBox, inner: RawBox, tol = 1): boolean =>
  outer.x - tol <= inner.x && outer.y - tol <= inner.y && outer.x + outer.w + tol >= inner.x + inner.w && outer.y + outer.h + tol >= inner.y + inner.h;

/** Distance from a point to a box (0 inside). */
function distance(b: RawBox, [x, y]: [number, number]): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/**
 * Source and target of an edge from its data-id: `L_<src>_<dst>_<n>` (flowchart), `id_<src>_<dst>_<n>`
 * (class, er); node ids may contain underscores, so every split is tried against the known names.
 */
export function endsOfEdge(dataId: string, known: ReadonlySet<string>): { src: string; dst: string } | undefined {
  const m = /^(?:L|id)_(.+?)(?:_\d+)?$/.exec(dataId);
  if (!m) return undefined;
  const rest = m[1] as string;
  for (let i = rest.indexOf("_"); i >= 0; i = rest.indexOf("_", i + 1)) {
    const src = rest.slice(0, i);
    const dst = rest.slice(i + 1);
    if (known.has(src) && known.has(dst)) return { src, dst };
  }
  return undefined;
}

/**
 * Mermaid cuts an edge where it meets the drawn outline, and a cylinder or stadium outline is curved: next to a
 * cap or a rounded end it lies up to a few px inside the bounding box (more on a tall stadium). The checker knows
 * boxes, not outlines, so it would read the arrowhead as sunk into the node. An end of a straight final segment
 * that runs across a curved node's box side is moved along the segment onto that side (at most `SNAP_MAX` px).
 */
export function snapToBox(poly: [number, number][], end: "start" | "end", box: RawBox): [number, number][] {
  const i = end === "start" ? 0 : poly.length - 1;
  const p = poly[i];
  const q = poly[end === "start" ? 1 : poly.length - 2];
  if (!p || !q) return poly;
  const [px, py] = p;
  const out = poly.slice();
  if (Math.abs(q[0] - px) < 0.5 && px > box.x + 1 && px < box.x + box.w - 1) {
    const side = q[1] < py ? box.y : box.y + box.h; // arriving from above meets the top side
    if (Math.abs(side - py) <= SNAP_MAX && (q[1] < py ? side < py : side > py)) out[i] = [px, side];
  } else if (Math.abs(q[1] - py) < 0.5 && py > box.y + 1 && py < box.y + box.h - 1) {
    const side = q[0] < px ? box.x : box.x + box.w;
    if (Math.abs(side - px) <= SNAP_MAX && (q[0] < px ? side < px : side > px)) out[i] = [side, py];
  }
  return out;
}
const SNAP_MAX = 30;

/** ELK repeats bend points and starts some routes a fraction of a px off the shape: segments under 2 px are not drawn, so they are dropped (the end point stays). */
export function dropTinySegments(poly: [number, number][], min = 2): [number, number][] {
  const out: [number, number][] = [];
  poly.forEach((p, i) => {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push(p);
    else if (i === poly.length - 1) out[out.length - 1] = p;
  });
  return out.length >= 2 ? out : poly;
}

export interface MermaidMeasure {
  neutral: NeutralScene;
  stats: MermaidStats;
  kind: Kind | undefined;
}

export function measure(raw: RawGeometry): MermaidMeasure {
  const kind = kindOfRole(raw.role);
  const [, , width, height] = raw.viewBox;
  const aggregateOnly = kind !== undefined && AGGREGATE_ONLY.has(kind);

  // Unique ids: the first key; a repeated one gets a suffix.
  const used = new Set<string>();
  const ids = raw.nodes.map((n) => {
    let id = n.keys[0] as string;
    for (let i = 2; used.has(id); i++) id = `${n.keys[0]}~${i}`;
    used.add(id);
    return id;
  });
  const idOfKey = new Map<string, string>();
  raw.nodes.forEach((n, i) => {
    for (const k of n.keys) if (!idOfKey.has(k)) idOfKey.set(k, ids[i] as string);
  });
  const known = new Set(idOfKey.keys());

  // Mermaid nests nothing in the DOM (clusters are siblings), so the zone of a node is the smallest cluster around it.
  const zones = raw.nodes.map((n, i) => ({ n, id: ids[i] as string })).filter((z) => z.n.zone);
  const parentOf = (n: RawNode, id: string): string | undefined => {
    let best: { id: string; a: number } | undefined;
    for (const z of zones) {
      if (z.id === id || !contains(z.n.box, n.box) || (n.zone && area(z.n.box) <= area(n.box))) continue;
      const a = area(z.n.box);
      if (!best || a < best.a) best = { id: z.id, a };
    }
    return best?.id;
  };

  const nodes: NeutralNode[] = [];
  const labels: NeutralLabel[] = [];
  raw.nodes.forEach((n, i) => {
    const id = ids[i] as string;
    const parent = parentOf(n, id);
    nodes.push({ id, kind: n.zone ? "zone" : "node", box: n.box as NeutralBox, shape: n.zone ? "rectangle" : shapeOf(n), ...(parent ? { parent } : {}) });
    if (n.label) labels.push({ ownerId: id, box: n.label, ...(n.text !== undefined ? { text: n.text } : {}) });
  });

  const boxes = new Map(nodes.map((n) => [n.id, n.box] as const));
  const nearestNode = (p: [number, number]): string => {
    let best = "";
    let bestD = 8; // px: an end farther than this from every node is unbound
    for (const n of nodes) {
      if (n.kind !== "node") continue;
      const d = distance(n.box as RawBox, p);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  };
  const edges: NeutralEdge[] = raw.edges.map((e) => {
    let src = e.src !== undefined ? (idOfKey.get(e.src) ?? e.src) : "";
    let dst = e.dst !== undefined ? (idOfKey.get(e.dst) ?? e.dst) : "";
    if (!src || !dst) {
      const ends = endsOfEdge(e.dataId, known);
      if (ends) {
        src = idOfKey.get(ends.src) as string;
        dst = idOfKey.get(ends.dst) as string;
      }
    }
    if (!src && e.poly.length > 0) src = nearestNode(e.poly[0] as [number, number]);
    if (!dst && e.poly.length > 0) dst = nearestNode(e.poly[e.poly.length - 1] as [number, number]);
    if (src && !boxes.has(src)) src = "";
    if (dst && !boxes.has(dst)) dst = "";
    let route = e.poly;
    for (const [end, id] of [["start", src], ["end", dst]] as const) {
      const curved = raw.nodes.findIndex((n, k) => ids[k] === id && n.curve !== undefined && !n.zone);
      if (curved >= 0) route = snapToBox(route, end, (raw.nodes[curved] as RawNode).box);
    }
    const poly = dropTinySegments(route);
    return { id: e.dataId, src, dst, poly, ...(e.label ? { label: e.label as NeutralBox } : {}), ...(e.text !== undefined ? { text: e.text } : {}), startArrow: e.startArrow, endArrow: e.endArrow };
  });

  const neutral: NeutralScene = aggregateOnly ? { nodes: [], edges: [], labels: [] } : { nodes, edges, labels, headWidth: HEAD_WIDTH.mermaid };
  const stats: MermaidStats = {
    role: raw.role,
    nodes: raw.nodes.filter((n) => !n.zone).length,
    edges: raw.edges.length,
    clusters: zones.length,
    width: Math.round(width),
    height: Math.round(height),
    extra: raw.stats,
  };
  return { neutral, stats, kind };
}

/** Rules that do not apply to Excalidraw-shaped labels, so they never fire on Mermaid output. */
const ALWAYS_SKIPPED = ["label-stored-offset", "text-exceeds-inscribed"];
/** Rules that assume a node-edge layout; non-graph kinds are checked for overlap, overflow and bounds only. */
const GRAPH_ONLY = ["arrow-crossings", "route-ratio", "arrow-detached", "arrow-through-node", "parallel-edges-close", "aspect-ratio"];

export function geometryOf(neutral: NeutralScene | undefined, kind: Kind | undefined): Geometry {
  if (!neutral || neutral.nodes.length === 0) return { elements: [], rulesSkipped: Object.keys(RULES) };
  const elements: SceneElement[] = toScene(neutral);
  const skipped = [...ALWAYS_SKIPPED];
  if (kind !== undefined && kind !== "graph") skipped.push(...GRAPH_ONLY);
  // text-overflow needs the label boxes of the nodes
  if (!neutral.labels.some((l) => neutral.nodes.some((n) => n.id === l.ownerId && n.kind === "node"))) skipped.push("text-overflow");
  return { elements, rulesSkipped: skipped };
}
