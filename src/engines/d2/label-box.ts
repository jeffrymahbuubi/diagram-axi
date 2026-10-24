// Where D2 draws a label, as a box: shape labels (`labelPosition` on a shape) and edge labels (a point on the route,
// moved sideways for OUTSIDE_* positions). A port of D2's lib/label (v0.7+) checked against the SVGs this repo renders.

import type { NeutralBox } from "../neutral.js";
import type { D2Connection, D2Shape } from "./wasm.js";

type Pt = [number, number];

/** Padding D2 keeps between a shape border and an inside label, and between an edge and an outside label. */
const LABEL_PAD = 5;

/** A cylinder's centered label sits this far below the box middle (half the 24 px cap arc), in the body under the cap. */
const CYLINDER_LABEL_DROP = 12;

/** Stroke width D2 gives an edge unless the source says otherwise. */
const DEFAULT_STROKE = 2;

/** Box of a label placed by D2's `labelPosition` (`INSIDE_TOP_LEFT`, `OUTSIDE_BOTTOM_CENTER`, `BORDER_TOP_CENTER`, ...). */
export function labelBox(s: D2Shape): NeutralBox | undefined {
  const w = s.labelWidth ?? 0;
  const h = s.labelHeight ?? 0;
  if (!s.label || w <= 0 || h <= 0) return undefined;
  const [where = "INSIDE", v = "MIDDLE", hz = "CENTER"] = (s.labelPosition ?? "INSIDE_MIDDLE_CENTER").split("_");
  const { x, y } = s.pos;
  let bx = x + (s.width - w) / 2;
  if (hz === "LEFT") bx = where === "OUTSIDE" && v === "MIDDLE" ? x - w - LABEL_PAD : x + LABEL_PAD;
  else if (hz === "RIGHT") bx = where === "OUTSIDE" && v === "MIDDLE" ? x + s.width + LABEL_PAD : x + s.width - w - LABEL_PAD;
  let by = y + (s.height - h) / 2;
  if (v === "TOP") by = where === "OUTSIDE" ? y - h - LABEL_PAD : where === "BORDER" ? y - h / 2 : y + LABEL_PAD;
  else if (v === "BOTTOM") by = where === "OUTSIDE" ? y + s.height + LABEL_PAD : where === "BORDER" ? y + s.height - h / 2 : y + s.height - h - LABEL_PAD;
  if (s.type === "cylinder" && where === "INSIDE" && v === "MIDDLE") by += CYLINDER_LABEL_DROP;
  return { x: bx, y: by, w, h };
}

/** Edge label positions D2 renders: along the route at 1/4, 1/2, 3/4 or at `labelPercentage` (UNLOCKED), on the line or beside it. */
export type EdgeLabelPosition = "INSIDE_MIDDLE_CENTER" | "UNLOCKED_MIDDLE" | "UNLOCKED_TOP" | "UNLOCKED_BOTTOM";

const ALONG: Record<string, number> = { LEFT: 0.25, CENTER: 0.5, RIGHT: 0.75 };

/** The point `distance` along `route`, and the index of the segment it lies on (past the end: the last segment, extended). */
function pointAtDistance(route: Pt[], distance: number): { p: Pt; i: number } {
  let remaining = distance;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= len || i + 2 === route.length) {
      const t = len === 0 ? 0 : remaining / len;
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], i };
    }
    remaining -= len;
  }
  return { p: route[0] ?? [0, 0], i: 0 };
}

const routeLength = (route: Pt[]): number => route.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p[0] - route[i - 1]![0], p[1] - route[i - 1]![1])), 0);

/**
 * Box of an edge label of size `w` x `h` on a polyline route. `position` is D2's `labelPosition`: INSIDE_MIDDLE_* sits on the
 * route, OUTSIDE_TOP_* / OUTSIDE_BOTTOM_* beside it (TOP is the left of the travel direction), UNLOCKED_* use `percentage`.
 */
export function routeLabelBox(route: Pt[], w: number, h: number, position: string | undefined, percentage: number | undefined, strokeWidth = DEFAULT_STROKE): NeutralBox | undefined {
  if (route.length < 2 || w <= 0 || h <= 0) return undefined;
  const [where = "INSIDE", side = "MIDDLE", hz = "CENTER"] = (position ?? "INSIDE_MIDDLE_CENTER").split("_");
  const unlocked = where === "UNLOCKED";
  const f = unlocked ? Math.min(Math.max(percentage ?? 0.5, 0), 1) : (ALONG[hz] ?? 0.5);
  const kind = unlocked || where === "OUTSIDE" ? side : "MIDDLE";
  const { p, i } = pointAtDistance(route, f * routeLength(route));
  let [cx, cy] = p;
  if (kind === "TOP" || kind === "BOTTOM") {
    const a = route[i]!;
    const b = route[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const flip = kind === "TOP" ? -1 : 1;
    cx += flip * (-(b[1] - a[1]) / len) * (strokeWidth / 2 + LABEL_PAD + w / 2);
    cy += flip * ((b[0] - a[0]) / len) * (strokeWidth / 2 + LABEL_PAD + h / 2);
  }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Edge label box for a connection D2 routed with straight (polyline) segments. */
export function edgeLabelBoxOnRoute(c: D2Connection, route: Pt[]): NeutralBox | undefined {
  if (!c.label) return undefined;
  return routeLabelBox(route, c.labelWidth ?? 0, c.labelHeight ?? 0, c.labelPosition, c.labelPercentage, c.strokeWidth);
}
