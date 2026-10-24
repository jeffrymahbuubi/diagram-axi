// D2 diagram JSON (compile().diagram) -> NeutralScene (KTD5), so the one checker runs on D2 output.
// Containers are shapes whose id prefixes other ids; sequence-diagram lifelines are dropped; dagre's
// bezier routes are sampled; label boxes come from D2's own label sizes and positions.

import { pointAtFraction } from "../../quality/geom.js";
import { HEAD_WIDTH, curveToPolyline, type NeutralBox, type NeutralEdge, type NeutralLabel, type NeutralNode, type NeutralScene, type NeutralShape } from "../neutral.js";
import type { Kind } from "../types.js";
import { edgeLabelBoxOnRoute, labelBox } from "./label-box.js";
import type { D2Connection, D2Diagram } from "./wasm.js";

export { labelBox };

const SHAPE_OF: Record<string, NeutralShape> = {
  rectangle: "rectangle",
  square: "rectangle",
  oval: "ellipse",
  circle: "ellipse",
  diamond: "diamond",
  hexagon: "hexagon",
  cylinder: "cylinder",
  parallelogram: "parallelogram",
  sql_table: "table",
  class: "table",
};

/** Shapes whose label is part of their own drawing (header rows), so no separate label box is emitted. */
const OWN_LABEL = new Set(["sql_table", "class", "code", "image", "sequence_diagram"]);

/** Our translator's title shape (`d2_title`, `d2_title_`, ...): placed by `near`, not part of the layout. */
const TITLE_ID = /^d2_title_*$/;
const LIFELINE_ID = /^\(.* -- \)\[\d+\]$/;

const isLifeline = (c: D2Connection): boolean => LIFELINE_ID.test(c.id) || c.dst.includes("-lifeline-end-");

/** Rule codes that do not apply to any D2 output (Excalidraw-specific label and shape bookkeeping). */
export const D2_RULES_SKIPPED = ["label-stored-offset", "text-exceeds-inscribed"];

/**
 * Sequence, class and ER diagrams are not graph-routed: edges end on lifelines, spans or table rows, and
 * crossings are part of the notation. Only overlap, overflow and bounds rules stay on for them.
 */
export const D2_NON_GRAPH_SKIPPED = [
  "arrow-crossings",
  "arrow-detached",
  "arrow-end-on-wrong-side",
  "arrow-through-node",
  "arrowhead-inside-node",
  "arrowhead-near-tail",
  "arrowheads-cross",
  "arrowheads-crowded",
  "arrows-collinear-overlap",
  "aspect-ratio",
  "degenerate-segment",
  "label-at-crossing",
  "label-covers-own-arrow",
  "label-far-from-arrow",
  "label-near-arrowhead",
  "label-on-foreign-arrow",
  "node-edge-graze",
  "parallel-edges-close",
  "route-ratio",
  "self-loop-shape",
  "short-final-segment",
  "track-spacing",
  "zone-title-crossed",
];

export function rulesSkippedFor(kind: Kind): string[] {
  return kind === "graph" ? [...D2_RULES_SKIPPED] : [...D2_RULES_SKIPPED, ...D2_NON_GRAPH_SKIPPED].sort();
}

/** Some zone's title box lies outside the zone's own box. */
export function titlesOutsideZones(neutral: NeutralScene): boolean {
  const zones = new Map(neutral.nodes.filter((n) => n.kind === "zone").map((z) => [z.id, z.box]));
  return neutral.labels.some((l) => {
    const z = zones.get(l.ownerId);
    return z !== undefined && (l.box.y < z.y - 0.5 || l.box.y + l.box.h > z.y + z.h + 0.5 || l.box.x < z.x - 0.5 || l.box.x + l.box.w > z.x + z.w + 0.5);
  });
}

/** Kind of a compiled diagram: lifelines mean sequence, tables ER, class shapes class, else a graph. */
export function diagramKind(diagram: D2Diagram): Kind {
  if (diagram.connections.some(isLifeline)) return "sequence";
  if (diagram.shapes.some((s) => s.type === "sql_table")) return "erd";
  if (diagram.shapes.some((s) => s.type === "class")) return "class";
  return "graph";
}

/**
 * D2 ends a route on the drawn outline, and a cylinder's cap is an arc: a route that meets the cap off-center ends up to
 * half the arc height below the top of the shape's box. The checker sees a cylinder as its box, so the end is clipped to
 * where the route enters that box; else every arrowhead on a cap would read as buried in the node.
 */
export function clipEndToBox(poly: [number, number][], box: NeutralBox, at: "start" | "end"): [number, number][] {
  const inside = (p: [number, number]): boolean => p[0] > box.x + 0.5 && p[0] < box.x + box.w - 0.5 && p[1] > box.y + 0.5 && p[1] < box.y + box.h - 0.5;
  const pts = at === "start" ? [...poly].reverse() : [...poly];
  if (pts.length < 2 || !inside(pts[pts.length - 1]!)) return poly;
  let i = pts.length - 1;
  while (i > 0 && inside(pts[i - 1]!)) i--;
  if (i === 0) return poly; // the whole route lies inside the box: nothing to clip against
  const a = pts[i - 1]!;
  const b = pts[i]!;
  const entry = (from: number, d: number, lo: number, hi: number): number => (d === 0 ? 0 : ((d > 0 ? lo : hi) - from) / d);
  const t = Math.min(1, Math.max(0, entry(a[0], b[0] - a[0], box.x, box.x + box.w), entry(a[1], b[1] - a[1], box.y, box.y + box.h)));
  const cut: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const out = [...pts.slice(0, i), cut];
  return at === "start" ? out.reverse() : out;
}


/** Edge label box. D2 puts it on the route at `labelPosition`; a bezier route (dagre) is sampled, the label centered on its middle. */
function edgeLabelBox(c: D2Connection, drawn: [number, number][]): NeutralBox | undefined {
  if (c.isCurve !== true) return edgeLabelBoxOnRoute(c, drawn);
  const w = c.labelWidth ?? 0;
  const h = c.labelHeight ?? 0;
  if (!c.label || w <= 0 || h <= 0 || drawn.length < 2) return undefined;
  const f = c.labelPercentage && c.labelPercentage > 0 && c.labelPercentage <= 1 ? c.labelPercentage : 0.5;
  const [px, py] = pointAtFraction(drawn, f);
  return { x: px - w / 2, y: py - h / 2, w, h };
}

export interface D2Neutral {
  neutral: NeutralScene;
  kind: Kind;
}

export function diagramToNeutral(diagram: D2Diagram): D2Neutral {
  const kind = diagramKind(diagram);
  const sequence = kind === "sequence";
  const shapes = diagram.shapes.filter((s) => !TITLE_ID.test(s.id) || s.type !== "text");
  const ids = shapes.map((s) => s.id);

  const isZone = new Map<string, boolean>();
  for (const s of shapes) {
    // Sequence actors own their spans (`alice.a1`) without being containers; only groups (blend) are zones.
    isZone.set(s.id, sequence ? s.blend === true : ids.some((o) => o.startsWith(`${s.id}.`)));
  }
  const parentOf = (id: string): string | undefined => {
    for (let i = id.lastIndexOf("."); i > 0; i = id.lastIndexOf(".", i - 1)) {
      const p = id.slice(0, i);
      if (isZone.get(p)) return p;
    }
    return undefined;
  };

  const nodes: NeutralNode[] = [];
  const labels: NeutralLabel[] = [];
  for (const s of shapes) {
    const zone = isZone.get(s.id) === true;
    const parent = parentOf(s.id);
    nodes.push({
      id: s.id,
      kind: zone ? "zone" : "node",
      box: { x: s.pos.x, y: s.pos.y, w: s.width, h: s.height },
      shape: zone ? "rectangle" : (SHAPE_OF[s.type] ?? "other"),
      ...(parent ? { parent } : {}),
    });
    if (OWN_LABEL.has(s.type) && !zone) continue;
    const box = labelBox(s);
    if (box) labels.push({ ownerId: s.id, box, ...(s.label ? { text: s.label } : {}) });
  }

  const cylinders = new Map(shapes.filter((s) => s.type === "cylinder").map((s) => [s.id, { x: s.pos.x, y: s.pos.y, w: s.width, h: s.height }]));
  const edges: NeutralEdge[] = [];
  for (const c of diagram.connections) {
    if (isLifeline(c)) continue;
    const route = curveToPolyline(c.route, c.isCurve === true);
    // D2's route points carry float32 noise (424.3330078125); the SVG path has 3 decimals. Round, so two lanes ELK set exactly
    // 10 px apart are not measured as 9.9999.
    const drawn = route.map((p): [number, number] => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
    let poly = drawn;
    const srcBox = cylinders.get(c.src);
    const dstBox = cylinders.get(c.dst);
    if (srcBox) poly = clipEndToBox(poly, srcBox, "start");
    if (dstBox) poly = clipEndToBox(poly, dstBox, "end");
    const label = edgeLabelBox(c, drawn); // D2 places it on the drawn route, before any clipping
    edges.push({
      id: c.id,
      src: c.src,
      dst: c.dst,
      poly,
      ...(label ? { label, text: c.label } : {}),
      startArrow: !!c.srcArrow && c.srcArrow !== "none",
      endArrow: !!c.dstArrow && c.dstArrow !== "none",
    });
  }
  return { neutral: { nodes, edges, labels, headWidth: HEAD_WIDTH.d2 }, kind };
}
