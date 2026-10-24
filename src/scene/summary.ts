// Scene statistics for `inspect`. Works from the scene alone (no graph needed), so it
// also accepts .excalidraw files made elsewhere: for those every non-zone shape counts
// as a node and groups is 0, because zones are recognized by this builder's id scheme
// (`zone-*`) and cylinders by their `cap-*` ellipse.

import type { ShapeKind } from "../dsl/ast.js";
import type { SceneData } from "../render/outputs.js";

export interface SceneSummary {
  nodes: number;
  edges: number;
  groups: number;
  /** DSL shape kinds; every kind is present, zero when unused. */
  shapes: Record<ShapeKind, number>;
  /** Bounding box of all live elements, rounded to integers. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Font name -> number of text elements using it. */
  fonts: Record<string, number>;
  /** Fill color -> number of node shapes using it (transparent excluded). */
  colors: Record<string, number>;
  /** Number of text elements (labels, zone titles, title). */
  texts: number;
  /** Diagram title text when the scene has the builder's title element. */
  title?: string;
}

const FONT_NAMES: Record<number, string> = {
  1: "Virgil",
  2: "Helvetica",
  3: "Cascadia",
  4: "Assistant",
  5: "Excalifont",
  6: "Nunito",
  7: "Lilita One",
  8: "Comic Shanns",
  9: "Liberation Sans",
};

interface Loose {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isDeleted?: boolean;
  backgroundColor?: string;
  fontFamily?: number;
  text?: string;
  points?: [number, number][];
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function summarize(scene: SceneData): SceneSummary {
  const live = (scene.elements as Loose[]).filter((e) => e && !e.isDeleted);
  const idOf = (e: Loose) => e.id ?? "";
  const caps = new Set(live.filter((e) => idOf(e).startsWith("cap-")).map((e) => idOf(e).slice(4)));

  const shapes: Record<ShapeKind, number> = { rect: 0, ellipse: 0, diamond: 0, cylinder: 0 };
  const colors: Record<string, number> = {};
  const fonts: Record<string, number> = {};
  let nodes = 0;
  let edges = 0;
  let groups = 0;
  let texts = 0;
  let title: string | undefined;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const grow = (x: number, y: number) => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  };

  for (const e of live) {
    const id = idOf(e);
    const x = e.x ?? 0;
    const y = e.y ?? 0;
    if (e.type === "arrow" || e.type === "line") {
      if (e.type === "arrow") edges++;
      for (const p of e.points ?? [[0, 0]]) grow(x + p[0], y + p[1]);
      continue;
    }
    grow(x, y);
    grow(x + (e.width ?? 0), y + (e.height ?? 0));
    if (e.type === "text") {
      texts++;
      const name = FONT_NAMES[e.fontFamily ?? 0] ?? `font-${e.fontFamily}`;
      fonts[name] = (fonts[name] ?? 0) + 1;
      if (id === "title") title = e.text;
    } else if (e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond") {
      if (id.startsWith("zone-")) {
        groups++;
      } else if (id.startsWith("cap-")) {
        // cylinder cap: counted with its body
      } else {
        nodes++;
        const kind: ShapeKind =
          e.type === "rectangle" ? (caps.has(id.replace(/^node-/, "")) ? "cylinder" : "rect") : e.type;
        shapes[kind]++;
        const fill = e.backgroundColor;
        if (fill && fill !== "transparent") colors[fill] = (colors[fill] ?? 0) + 1;
      }
    }
  }

  const empty = !Number.isFinite(x1);
  const out: SceneSummary = {
    nodes,
    edges,
    groups,
    shapes,
    bounds: empty
      ? { x: 0, y: 0, width: 0, height: 0 }
      : { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) },
    fonts: sortKeys(fonts),
    colors: sortKeys(colors),
    texts,
  };
  if (title !== undefined) out.title = title;
  return out;
}
