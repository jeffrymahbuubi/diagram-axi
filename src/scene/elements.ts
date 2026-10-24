// Full Excalidraw element factories (KTD4). Field set follows @excalidraw/utils 0.1.7
// (element/src/types.d.ts). Key order is fixed so serialization is byte-stable.

import type { StyleFlag } from "../dsl/ast.js";
import type { Box, Point, TextMetrics } from "../layout/engine.js";
import { fnv31 } from "./ids.js";
import { FONT_FAMILY, LINE_HEIGHT, STROKE } from "./palette.js";

export type StrokeStyle = "solid" | "dashed" | "dotted";

export interface BoundRef {
  id: string;
  type: "text" | "arrow";
}

export interface ElementBase {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid";
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: null;
  index: string;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: BoundRef[] | null;
  updated: number;
  link: null;
  locked: boolean;
}

export interface ShapeElement extends ElementBase {
  type: "rectangle" | "ellipse" | "diamond";
}

export interface TextElement extends ElementBase {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: number;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  containerId: string | null;
  originalText: string;
  autoResize: boolean;
  lineHeight: number;
  /** Arrow labels only: 0..1 fraction of the arrow's path length where Excalidraw centers the text. */
  labelPosition?: number;
}

/**
 * Bindings carry both generations of the format: `focus`/`gap` (older editors, and
 * what `restore` migrates) and `fixedPoint`/`mode` (the 0.1.7 types). Extra keys are
 * ignored by whichever reader does not know them.
 */
export interface ArrowBinding {
  elementId: string;
  focus: number;
  gap: number;
  fixedPoint: [number, number];
  mode: "orbit";
}

export interface ArrowElement extends ElementBase {
  type: "arrow";
  points: [number, number][];
  startBinding: ArrowBinding | null;
  endBinding: ArrowBinding | null;
  startArrowhead: "arrow" | "triangle" | null;
  endArrowhead: "arrow" | "triangle" | null;
  elbowed: boolean;
}

export type SceneElement = ShapeElement | TextElement | ArrowElement;

export interface Style {
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  roughness?: number;
  opacity?: number;
  roundness?: { type: number } | null;
  groupIds?: string[];
}

/** Round to 2 decimals so float noise never leaks into the file. */
export const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Map DSL style flags to element properties (last of dashed/dotted wins). */
export function flagStyle(flags: StyleFlag[]): Pick<Style, "strokeWidth" | "strokeStyle" | "roughness"> {
  const out: Pick<Style, "strokeWidth" | "strokeStyle" | "roughness"> = {};
  for (const f of flags) {
    if (f === "bold") out.strokeWidth = 4;
    else if (f === "sketchy") out.roughness = 2;
    else if (f === "dashed") out.strokeStyle = "dashed";
    else if (f === "dotted") out.strokeStyle = "dotted";
  }
  return out;
}

function base(id: string, type: string, box: Box, s: Style): ElementBase {
  const seed = fnv31(id);
  return {
    id,
    type,
    x: r2(box.x),
    y: r2(box.y),
    width: r2(box.w),
    height: r2(box.h),
    angle: 0,
    strokeColor: s.strokeColor ?? STROKE,
    backgroundColor: s.backgroundColor ?? "transparent",
    fillStyle: "solid",
    strokeWidth: s.strokeWidth ?? 2,
    strokeStyle: s.strokeStyle ?? "solid",
    roughness: s.roughness ?? 1,
    opacity: s.opacity ?? 100,
    groupIds: s.groupIds ?? [],
    frameId: null,
    index: "",
    roundness: s.roundness ?? null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

export function shape(id: string, type: ShapeElement["type"], box: Box, s: Style): ShapeElement {
  return base(id, type, box, s) as ShapeElement;
}

export interface TextOptions {
  fontSize: number;
  textAlign?: TextElement["textAlign"];
  verticalAlign?: TextElement["verticalAlign"];
  containerId?: string | null;
  groupIds?: string[];
  strokeColor?: string;
}

/** Text element whose top-left is `at`; size comes from the measured metrics. */
export function text(id: string, at: Point, m: TextMetrics, o: TextOptions): TextElement {
  const content = m.lines.join("\n");
  const el = base(id, "text", { x: at.x, y: at.y, w: m.width, h: m.height }, {
    groupIds: o.groupIds,
    strokeColor: o.strokeColor,
  }) as TextElement;
  el.text = content;
  el.fontSize = o.fontSize;
  el.fontFamily = FONT_FAMILY;
  el.textAlign = o.textAlign ?? "center";
  el.verticalAlign = o.verticalAlign ?? "middle";
  el.containerId = o.containerId ?? null;
  el.originalText = content;
  el.autoResize = true;
  el.lineHeight = LINE_HEIGHT;
  return el;
}

/** Text centered inside `box`. */
export function centeredText(id: string, box: Box, m: TextMetrics, o: TextOptions): TextElement {
  return text(id, { x: box.x + (box.w - m.width) / 2, y: box.y + (box.h - m.height) / 2 }, m, o);
}

export interface ArrowOptions {
  style: Style;
  startArrowhead: "arrow" | "triangle" | null;
  endArrowhead: "arrow" | "triangle" | null;
}

/** Arrow from absolute waypoints: x,y is the first point, `points` are relative to it. */
export function arrow(id: string, waypoints: Point[], o: ArrowOptions): ArrowElement {
  const first = waypoints[0]!;
  const points: [number, number][] = waypoints.map((p) => [r2(p.x - first.x), r2(p.y - first.y)]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const box = {
    x: first.x,
    y: first.y,
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  const el = base(id, "arrow", box, o.style) as ArrowElement;
  el.points = points;
  el.startBinding = null;
  el.endBinding = null;
  el.startArrowhead = o.startArrowhead;
  el.endArrowhead = o.endArrowhead;
  el.elbowed = false;
  return el;
}

/** Binding of an arrow end at absolute `end` onto `target` (clamped ratio in the target's box). */
export function binding(targetId: string, target: Box, end: Point): ArrowBinding {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    elementId: targetId,
    focus: 0,
    gap: 4,
    fixedPoint: [
      Math.round(clamp((end.x - target.x) / (target.w || 1)) * 10000) / 10000,
      Math.round(clamp((end.y - target.y) / (target.h || 1)) * 10000) / 10000,
    ],
    mode: "orbit",
  };
}

/** Register `ref` in a container's boundElements. */
export function bind(container: ElementBase, ref: BoundRef): void {
  (container.boundElements ??= []).push(ref);
}
