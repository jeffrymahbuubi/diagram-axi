// Neutral geometry model (KTD5): what any engine's layout is reduced to so the one geometric checker
// (src/quality/analyze.ts) can run on D2, Mermaid and Excalidraw output alike. Engines produce a
// NeutralScene from their own geometry (D2 diagram JSON, the Mermaid DOM); toScene() turns it into
// analysis-grade scene elements that use the id conventions of src/scene/ids.ts, so analyzeScene runs
// unmodified. The elements are not complete Excalidraw elements: they carry what the checker reads.

import { fractionAt } from "../layout/labels.js";
import type { SceneElement } from "../quality/geom.js";
import { ids, indexSequence } from "../scene/ids.js";

export interface NeutralBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shapes the checker knows (rectangle, ellipse, diamond) plus engine shapes it approximates by their box. */
export type NeutralShape = "rectangle" | "ellipse" | "diamond" | "hexagon" | "cylinder" | "parallelogram" | "table" | "other";

export interface NeutralNode {
  /** Engine-side id, unique within the scene (D2 dotted path, Mermaid node id). */
  id: string;
  /** `zone` = a container (D2 container, Mermaid cluster/subgraph): drawn as a zone rectangle. */
  kind: "node" | "zone";
  box: NeutralBox;
  shape: NeutralShape;
  /** Id of the enclosing zone. */
  parent?: string;
}

export interface NeutralEdge {
  id: string;
  /** Node or zone ids. */
  src: string;
  dst: string;
  /** Route from source to target as [x, y] points; curves are already sampled (sampleCubic). */
  poly: [number, number][];
  /** Box of the edge's label, when it has one. */
  label?: NeutralBox;
  /** Text of the edge label. */
  text?: string;
  /** Arrowhead at the start / end of the route; default start false, end true. */
  startArrow?: boolean;
  endArrow?: boolean;
  /** Breadth in px of this edge's arrowheads (perpendicular to the route); defaults to the scene's `headWidth`. */
  headWidth?: number;
}

/** Label of a node (centered text) or of a zone (its title). Edge labels live on the edge. */
export interface NeutralLabel {
  ownerId: string;
  box: NeutralBox;
  text?: string;
}

export interface NeutralScene {
  nodes: NeutralNode[];
  edges: NeutralEdge[];
  labels: NeutralLabel[];
  /**
   * Breadth in px of the engine's arrowheads, e.g. HEAD_WIDTH.d2 / HEAD_WIDTH.mermaid. The checker derives
   * when two arrowheads on one node touch (arrowheads-crowded) from it. Omitted = Excalidraw-sized heads (~16 px).
   */
  headWidth?: number;
}

/** Arrowhead breadth in px as drawn by each engine (D2: polygon 0,0 10,6 0,12; Mermaid: 8 px marker). */
export const HEAD_WIDTH = { d2: 12, mermaid: 8 } as const;

export interface ToSceneOptions {
  /** Distance of the top-left content corner from the origin after translation (default 20). */
  margin?: number;
}

export const DEFAULT_MARGIN = 20;

/** Px each side a shape is shrunk by, for shapes whose real outline is smaller than their bounding box. */
export const SHAPE_INSET: Record<NeutralShape, number> = {
  rectangle: 0,
  ellipse: 0,
  diamond: 0,
  cylinder: 0,
  table: 0,
  hexagon: 4,
  parallelogram: 4,
  other: 2,
};

const SHAPE_TYPE: Partial<Record<NeutralShape, "ellipse" | "diamond">> = { ellipse: "ellipse", diamond: "diamond" };

export interface XY {
  x: number;
  y: number;
}

/** The `n` points after `p0` of the cubic Bezier p0..p3 (t = 1/n .. 1). */
export function sampleCubic(p0: XY, p1: XY, p2: XY, p3: XY, n = 12): XY[] {
  const out: XY[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/** D2 style route: when `isCurve`, p0 then groups of three control points per cubic segment; else as given. */
export function curveToPolyline(route: XY[], isCurve: boolean, steps = 12): XY[] {
  if (!isCurve || route.length < 4) return route;
  const out: XY[] = [route[0]!];
  for (let i = 1; i + 2 < route.length; i += 3) out.push(...sampleCubic(route[i - 1]!, route[i]!, route[i + 1]!, route[i + 2]!, steps));
  return out;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Zone ancestry of `id`: [id, parent, grandparent, ...] over zones only, cycle-safe. */
function zoneChain(start: string | undefined, zones: Map<string, NeutralNode>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let z = start; z !== undefined && zones.has(z) && !seen.has(z); z = zones.get(z)!.parent) {
    seen.add(z);
    out.push(z);
  }
  return out;
}

/**
 * Neutral model -> scene elements. Order is the builder's z-order: zones (parents first), zone titles,
 * nodes, node labels, arrows, arrow labels. Ids: `zone-g-<id>`, `zone-title-<id>`, `node-<id>`,
 * `label-<id>`, `edge-<i>`, `edge-label-<i>` (i = position in `edges`). The scene is translated so its
 * top-left content corner sits at (margin, margin): engines place content at negative coordinates freely.
 */
export function toScene(neutral: NeutralScene, opts: ToSceneOptions = {}): SceneElement[] {
  const margin = opts.margin ?? DEFAULT_MARGIN;

  // First occurrence of an id wins.
  const byId = new Map<string, NeutralNode>();
  for (const n of neutral.nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const zones = new Map([...byId].filter(([, n]) => n.kind === "zone"));

  // translation
  let minX = Infinity;
  let minY = Infinity;
  const see = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  };
  for (const n of byId.values()) see(n.box.x, n.box.y);
  for (const e of neutral.edges) {
    for (const [x, y] of e.poly) see(x, y);
    if (e.label) see(e.label.x, e.label.y);
  }
  for (const l of neutral.labels) see(l.box.x, l.box.y);
  if (!Number.isFinite(minX)) return [];
  const dx = margin - minX;
  const dy = margin - minY;
  const shift = (b: NeutralBox): NeutralBox => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });

  const els: SceneElement[] = [];
  const common = { angle: 0, isDeleted: false, boundElements: null as { id: string; type: string }[] | null };
  const bind = (el: SceneElement, ref: { id: string; type: string }) => {
    (el.boundElements ??= []).push(ref);
  };
  const elementId = (n: NeutralNode): string => (n.kind === "zone" ? ids.zone(n.id) : ids.node(n.id));
  const groupsOf = (n: NeutralNode): string[] => zoneChain(n.kind === "zone" ? n.id : n.parent, zones).map(ids.group);

  // one label per owner: the first
  const labelOf = new Map<string, { box: NeutralBox; text: string }>();
  for (const l of neutral.labels) if (!labelOf.has(l.ownerId)) labelOf.set(l.ownerId, { box: shift(l.box), text: l.text ?? "" });

  // zones, parents first
  const zoneList = [...zones.values()].map((z, i) => ({ z, i, depth: zoneChain(z.id, zones).length }));
  zoneList.sort((a, b) => a.depth - b.depth || a.i - b.i);
  const element = new Map<string, SceneElement>();
  for (const { z } of zoneList) {
    const b = shift(z.box);
    const el: SceneElement = { ...common, id: ids.zone(z.id), type: "rectangle", x: r2(b.x), y: r2(b.y), width: r2(b.w), height: r2(b.h), groupIds: groupsOf(z) };
    element.set(z.id, el);
    els.push(el);
  }
  // zone titles
  for (const { z } of zoneList) {
    const l = labelOf.get(z.id);
    if (!l) continue;
    els.push(textEl(ids.zoneTitle(z.id), l.box, l.text, { containerId: null, groupIds: groupsOf(z) }));
  }
  // nodes
  const nodeList = [...byId.values()].filter((n) => n.kind === "node");
  for (const n of nodeList) {
    const inset = SHAPE_INSET[n.shape] ?? 0;
    const b0 = shift(n.box);
    const b = { x: b0.x + inset, y: b0.y + inset, w: Math.max(1, b0.w - 2 * inset), h: Math.max(1, b0.h - 2 * inset) };
    const el: SceneElement = {
      ...common,
      id: ids.node(n.id),
      type: SHAPE_TYPE[n.shape] ?? "rectangle",
      x: r2(b.x),
      y: r2(b.y),
      width: r2(b.w),
      height: r2(b.h),
      groupIds: groupsOf(n),
    };
    element.set(n.id, el);
    els.push(el);
  }
  // node labels, bound to their node
  for (const n of nodeList) {
    const l = labelOf.get(n.id);
    if (!l) continue;
    const owner = element.get(n.id)!;
    const t = textEl(ids.nodeLabel(n.id), l.box, l.text, { containerId: owner.id, groupIds: owner.groupIds ?? [] });
    bind(owner, { id: t.id, type: "text" });
    els.push(t);
  }
  // arrows
  const arrows: { el: SceneElement; edge: NeutralEdge; index: number }[] = [];
  neutral.edges.forEach((edge, index) => {
    if (edge.poly.length < 2) return;
    const pts = edge.poly.map(([x, y]) => ({ x: x + dx, y: y + dy }));
    const first = pts[0]!;
    const rel = pts.map((p): [number, number] => [r2(p.x - first.x), r2(p.y - first.y)]);
    const xs = rel.map((p) => p[0]);
    const ys = rel.map((p) => p[1]);
    const el: SceneElement = {
      ...common,
      id: ids.edge(index),
      type: "arrow",
      x: r2(first.x),
      y: r2(first.y),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      groupIds: [],
      points: rel,
      startBinding: null,
      endBinding: null,
      startArrowhead: edge.startArrow ? "arrow" : null,
      endArrowhead: edge.endArrow === false ? null : "arrow",
    };
    const headWidth = edge.headWidth ?? neutral.headWidth;
    if (headWidth !== undefined) el.arrowheadWidth = headWidth;
    const from = byId.get(edge.src) && element.get(edge.src);
    const to = byId.get(edge.dst) && element.get(edge.dst);
    if (from) {
      el.startBinding = bindingTo(from.id);
      bind(from, { id: el.id, type: "arrow" });
    }
    if (to) {
      el.endBinding = bindingTo(to.id);
      bind(to, { id: el.id, type: "arrow" });
    }
    els.push(el);
    arrows.push({ el, edge, index });
  });
  // arrow labels: the box is drawn exactly where the engine put it (`exactPlacement`: the checker uses the stored
  // box, not a point on the route, because D2 and ELK place labels beside the route). `labelPosition` is the
  // nearest route fraction to the box center, kept for consumers that want a route anchor.
  for (const { el, edge, index } of arrows) {
    if (!edge.label) continue;
    const b = shift(edge.label);
    const route = el.points!.map(([px, py]) => ({ x: el.x + px!, y: el.y + py! }));
    const f = Math.round(fractionAt(route, { x: b.x + b.w / 2, y: b.y + b.h / 2 }) * 10000) / 10000;
    const t = textEl(ids.edgeLabel(index), b, edge.text ?? "", { containerId: el.id, groupIds: [] });
    t.labelPosition = f;
    t.exactPlacement = true;
    bind(el, { id: t.id, type: "text" });
    els.push(t);
  }

  const order = indexSequence(els.length);
  els.forEach((el, i) => {
    el.index = order[i]!;
  });
  return els;
}

/** Arrow end binding; focus/gap keep the older-editor shape of src/scene/elements.ts. */
const bindingTo = (elementId: string) => ({ elementId, focus: 0, gap: 4 });

function textEl(id: string, b: NeutralBox, text: string, o: { containerId: string | null; groupIds: string[] }): SceneElement {
  return {
    id,
    type: "text",
    angle: 0,
    isDeleted: false,
    boundElements: null,
    x: r2(b.x),
    y: r2(b.y),
    width: r2(b.w),
    height: r2(b.h),
    groupIds: o.groupIds,
    text,
    originalText: text,
    containerId: o.containerId,
  };
}
