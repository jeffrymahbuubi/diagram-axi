// Graph + LayoutResult -> Excalidraw scene (KTD4-KTD6).
//
// z-order: zones, zone titles, nodes, node labels, arrows, arrow labels (the diagram
// title text goes first, below everything). Each phase appends to one array and
// fractional indices are assigned from the final order.

import type { ArrowKind, Graph, Node } from "../dsl/ast.js";
import type { Box, LayoutResult, PositionedNode } from "../layout/engine.js";
import { fractionAt, pointAt } from "../layout/labels.js";
import { measure } from "../layout/measure.js";
import type { SceneData } from "../render/outputs.js";
import {
  arrow,
  bind,
  binding,
  centeredText,
  flagStyle,
  r2,
  shape,
  text,
  type ArrowElement,
  type ElementBase,
  type SceneElement,
  type ShapeElement,
  type Style,
} from "./elements.js";
import { ids, indexSequence } from "./ids.js";
import {
  CANVAS_BACKGROUND,
  DEFAULT_CYLINDER_FILL,
  DEFAULT_NODE_FILL,
  DEFAULT_ZONE_FILL,
  NODE_FILL,
  NODE_FONT_SIZE,
  SMALL_FONT_SIZE,
  SOURCE,
  TITLE_FONT_SIZE,
  TITLE_GAP,
  ZONE_FILL,
  ZONE_OPACITY,
  ZONE_STROKE,
} from "./palette.js";

export interface BuildOptions {
  /** Diagram title; overrides graph.title. */
  title?: string;
}

/** SceneData with typed elements. */
export interface Scene extends SceneData {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: SceneElement[];
  appState: { gridSize: number; viewBackgroundColor: string };
  files: Record<string, never>;
}

/** Arrowheads per arrow kind: [start, end]. */
const HEADS: Record<ArrowKind, ["arrow" | "triangle" | null, "arrow" | "triangle" | null]> = {
  solid: [null, "arrow"],
  // Excalidraw draws the open "arrow" head in the stroke's dash pattern, so on dashed and dotted lines it turns into a
  // few specks that merge with neighbours; the filled triangle stays solid and legible.
  dashed: [null, "triangle"],
  dotted: [null, "triangle"],
  both: ["arrow", "arrow"],
  line: [null, null],
};

/** Cap ellipse height for a cylinder of total height `h`. */
function capHeight(h: number): number {
  return Math.min(28, Math.max(14, Math.round(h * 0.22)));
}

export function buildScene(graph: Graph, layout: LayoutResult, opts: BuildOptions = {}): Scene {
  // Group membership: node -> group, group -> parent group.
  const nodeGroup = new Map<string, string>();
  const groupParent = new Map<string, string>();
  for (const g of graph.groups) {
    for (const id of g.children) if (!nodeGroup.has(id)) nodeGroup.set(id, g.id);
    for (const id of g.groups) if (!groupParent.has(id)) groupParent.set(id, g.id);
  }
  /** groupIds for something inside `groupId`: innermost first. */
  const chain = (groupId: string | undefined): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let g = groupId; g && !seen.has(g); g = groupParent.get(g)) {
      seen.add(g);
      out.push(ids.group(g));
    }
    return out;
  };

  const astNode = new Map<string, Node>();
  for (const n of graph.nodes) if (!astNode.has(n.id)) astNode.set(n.id, n);
  const astGroup = new Map(graph.groups.map((g) => [g.id, g]));

  const elements: SceneElement[] = [];
  const add = (el: SceneElement) => {
    elements.push(el);
  };

  // Free title text above the content.
  const title = opts.title ?? graph.title;
  if (title) {
    const m = measure(title, TITLE_FONT_SIZE);
    const b = layout.bounds;
    add(
      text(
        ids.title,
        { x: b.x + (b.w - m.width) / 2, y: b.y - TITLE_GAP - m.height },
        m,
        { fontSize: TITLE_FONT_SIZE, textAlign: "center", verticalAlign: "top" },
      ),
    );
  }

  // Zones (parents first, so nested zones draw on top) and their titles.
  const zoneTitles: SceneElement[] = [];
  for (const pg of layout.groups) {
    const g = astGroup.get(pg.id);
    const groupIds = chain(pg.id);
    const style: Style = {
      backgroundColor: g?.color ? ZONE_FILL[g.color] : DEFAULT_ZONE_FILL,
      strokeColor: ZONE_STROKE,
      strokeWidth: 1,
      opacity: ZONE_OPACITY,
      roundness: { type: 3 },
      groupIds,
      ...flagStyle(g?.flags ?? []),
    };
    add(shape(ids.zone(pg.id), "rectangle", pg, style));
    if (g?.title && pg.titleBox) {
      const m = measure(g.title, SMALL_FONT_SIZE);
      zoneTitles.push(
        text(ids.zoneTitle(pg.id), { x: pg.titleBox.x, y: pg.titleBox.y }, m, {
          fontSize: SMALL_FONT_SIZE,
          textAlign: "left",
          verticalAlign: "top",
          groupIds,
        }),
      );
    }
  }
  zoneTitles.forEach(add);

  // Nodes. `target` is the box arrows bind to (the cylinder body, else the node box).
  const target = new Map<string, { el: ShapeElement; box: Box }>();
  const labelFor: { node: PositionedNode; el: ShapeElement; box: Box }[] = [];
  for (const pn of layout.nodes) {
    const n = astNode.get(pn.id);
    if (!n) continue;
    const fill = n.color ? NODE_FILL[n.color] : n.shape === "cylinder" ? DEFAULT_CYLINDER_FILL : DEFAULT_NODE_FILL;
    const parentGroups = chain(nodeGroup.get(n.id));
    const style: Style = { backgroundColor: fill, groupIds: parentGroups, ...flagStyle(n.flags) };
    let box: Box = { x: pn.x, y: pn.y, w: pn.w, h: pn.h };
    let el: ShapeElement;
    if (n.shape === "cylinder") {
      const cap = capHeight(pn.h);
      const groupIds = [ids.cylinder(n.id), ...parentGroups];
      box = { x: pn.x, y: pn.y + cap / 2, w: pn.w, h: pn.h - cap / 2 };
      el = shape(ids.node(n.id), "rectangle", box, { ...style, groupIds });
      add(el);
      add(shape(ids.cap(n.id), "ellipse", { x: pn.x, y: pn.y, w: pn.w, h: cap }, { ...style, groupIds }));
    } else {
      const type = n.shape === "rect" ? "rectangle" : n.shape;
      el = shape(ids.node(n.id), type, box, {
        ...style,
        roundness: n.shape === "rect" ? { type: 3 } : null,
      });
      add(el);
    }
    target.set(n.id, { el, box });
    labelFor.push({ node: pn, el, box });
  }

  // Node labels, bound to their container.
  for (const { node: pn, el, box } of labelFor) {
    if (pn.text.lines.join("") === "") continue;
    const label = centeredText(ids.nodeLabel(pn.id), box, pn.text, {
      fontSize: NODE_FONT_SIZE,
      containerId: el.id,
      groupIds: el.groupIds,
    });
    add(label);
    bind(el, { id: label.id, type: "text" });
  }

  // Arrows, bound to their end shapes.
  const arrows: { edge: LayoutResult["edges"][number]; el: ArrowElement }[] = [];
  for (const pe of layout.edges) {
    const e = graph.edges[pe.index];
    if (!e || pe.points.length < 2) continue;
    const [startHead, endHead] = HEADS[e.arrow];
    const strokeStyle = e.arrow === "dashed" ? "dashed" : e.arrow === "dotted" ? "dotted" : "solid";
    const el = arrow(ids.edge(pe.index), pe.points, {
      // Sharp polyline through the layout waypoints (round arrows would curve off them).
      style: { strokeStyle, roundness: null },
      startArrowhead: startHead,
      endArrowhead: endHead,
    });
    const from = target.get(pe.from);
    const to = target.get(pe.to);
    if (from) {
      el.startBinding = binding(from.el.id, from.box, pe.points[0]!);
      bind(from.el, { id: el.id, type: "arrow" });
    }
    if (to) {
      el.endBinding = binding(to.el.id, to.box, pe.points[pe.points.length - 1]!);
      bind(to.el, { id: el.id, type: "arrow" });
    }
    add(el);
    arrows.push({ edge: pe, el });
  }

  // Arrow labels: text bound to the arrow, centered in the box layout reserved for it.
  for (const { edge: pe, el } of arrows) {
    const e = graph.edges[pe.index]!;
    if (!e.label || !pe.label) continue;
    // Excalidraw draws arrow text at `labelPosition` (fraction of the path); store the spot layout
    // chose, and keep the stored x/y equal to where it is drawn.
    const pts = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }));
    const f = Math.round(fractionAt(pts, { x: pe.label.x + pe.label.w / 2, y: pe.label.y + pe.label.h / 2 }) * 10000) / 10000;
    const at = pointAt(pts, f);
    const m = pe.label.text;
    const label = centeredText(ids.edgeLabel(pe.index), { x: at.x - pe.label.w / 2, y: at.y - pe.label.h / 2, w: pe.label.w, h: pe.label.h }, m, {
      fontSize: SMALL_FONT_SIZE,
      containerId: el.id,
    });
    label.x = r2(at.x - m.width / 2);
    label.y = r2(at.y - m.height / 2);
    label.labelPosition = f;
    add(label);
    bind(el, { id: label.id, type: "text" });
  }

  const order = indexSequence(elements.length);
  elements.forEach((el: ElementBase, i) => {
    el.index = order[i]!;
  });

  return {
    type: "excalidraw",
    version: 2,
    source: SOURCE,
    elements,
    appState: { gridSize: 20, viewBackgroundColor: CANVAS_BACKGROUND },
    files: {},
  };
}
