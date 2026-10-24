// Colors and style constants for the scene builder (KTD5, with the resolved open
// questions: uncolored nodes default to light blue, cylinders to teal).

import type { ColorName } from "../dsl/ast.js";

/** Pastel node fills (Excalidraw palette from the MCP cheat sheet). */
export const NODE_FILL: Record<ColorName, string> = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  orange: "#ffd8a8",
  purple: "#d0bfff",
  red: "#ffc9c9",
  yellow: "#fff3bf",
  teal: "#c3fae8",
  pink: "#eebefa",
};

/**
 * Zone (group) fills, used at opacity 30. blue/purple/green come from the cheat
 * sheet; the rest follow the same open-color "tier 1" shade.
 */
export const ZONE_FILL: Record<ColorName, string> = {
  blue: "#dbe4ff",
  purple: "#e5dbff",
  green: "#d3f9d8",
  orange: "#ffe8cc",
  red: "#ffe3e3",
  yellow: "#fff3bf",
  teal: "#c3fae8",
  pink: "#ffdeeb",
};

export const DEFAULT_NODE_FILL = NODE_FILL.blue;
export const DEFAULT_CYLINDER_FILL = NODE_FILL.teal;
export const DEFAULT_ZONE_FILL = ZONE_FILL.blue;

export const STROKE = "#1e1e1e";
export const ZONE_STROKE = "#868e96";
export const ZONE_OPACITY = 30;
export const CANVAS_BACKGROUND = "#ffffff";

/** Excalifont. */
export const FONT_FAMILY = 5;
export const NODE_FONT_SIZE = 20;
export const SMALL_FONT_SIZE = 16;
export const TITLE_FONT_SIZE = 28;
export const LINE_HEIGHT = 1.25;

/** Gap between the diagram title text and the content bounds. */
export const TITLE_GAP = 20;

export const SOURCE = "https://github.com/jeffrymahbuubi/diagram-axi";
