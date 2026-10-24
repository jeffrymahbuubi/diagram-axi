// Node outlines for the lane-spreading pass (lane-spread.ts): where an arrow end may sit on a node's border, and the
// polygon an arrow must not cross. Only shapes whose outline has a closed form are movable targets; for the others the
// arrow ends stay where the layout put them.

import type { D2Shape } from "./wasm.js";

export type Pt = [number, number];
export type Kind = "rect" | "ellipse" | "diamond" | "cylinder" | "fixed";

export interface Outline {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** Closed polygon of the outline grown by a few px (rect: its box), what arrows must stay out of. */
  poly: Pt[];
}

/** Half the cap arc of a D2 cylinder. */
const CAP = 12;
/** Gap kept between an arrow end and the corner of a side. */
const CORNER = 7;

/** Clearance (px) the polygon of an obstacle keeps around its outline: an arrow grazing a node reads as touching it. */
const CLEARANCE = 2;

const KIND: Record<string, Kind> = { rectangle: "rect", square: "rect", oval: "ellipse", circle: "ellipse", diamond: "diamond", cylinder: "cylinder" };

export function outlineOf(s: D2Shape, isZone: boolean): Outline {
  const { x, y } = s.pos;
  const w = s.width;
  const h = s.height;
  const kind: Kind = isZone ? "rect" : (KIND[s.type] ?? "fixed");
  const cx = x + w / 2;
  const cy = y + h / 2;
  const g = CLEARANCE;
  let poly: Pt[] = [[x - g, y - g], [x + w + g, y - g], [x + w + g, y + h + g], [x - g, y + h + g]];
  if (kind === "ellipse") poly = Array.from({ length: 24 }, (_, i): Pt => [cx + (w / 2 + g) * Math.cos((i * Math.PI) / 12), cy + (h / 2 + g) * Math.sin((i * Math.PI) / 12)]);
  else if (kind === "diamond") poly = [[cx, y - 1.5 * g], [x + w + 1.5 * g, cy], [cx, y + h + 1.5 * g], [x - 1.5 * g, cy]];
  return { id: s.id, kind, x, y, w, h, cx, cy, poly };
}

/**
 * The point of `o`'s outline reached by an arrow that runs along `axis` ("v": a vertical segment, so the end sits on the top
 * or bottom; "h": on the left or right) at coordinate `c` across it. `towardsBottomOrRight` says which side: true when the
 * rest of the arrow lies below (right of) the end. Undefined when `c` is too near the corner or the shape cannot move.
 */
export function attach(o: Outline, axis: "v" | "h", c: number, towardsBottomOrRight: boolean): Pt | undefined {
  if (o.kind === "fixed") return undefined;
  const lo = axis === "v" ? o.x : o.y;
  const len = axis === "v" ? o.w : o.h;
  const mid = lo + len / 2;
  const t = (c - mid) / (len / 2); // -1 .. 1 across the side
  const limit = o.kind === "rect" ? 1 - CORNER / (len / 2) : o.kind === "cylinder" ? 0.85 : o.kind === "ellipse" ? 0.8 : 0.7;
  if (Math.abs(t) > limit) return undefined;
  // the end is on the side the rest of the arrow is NOT on: arrow below the end means the end is on the bottom edge
  const far = towardsBottomOrRight;
  const sign = far ? 1 : -1;
  const across = axis === "v" ? o.h : o.w;
  const centre = axis === "v" ? o.cy : o.cx;
  let d = across / 2; // distance from the centre to the outline along the arrow's direction
  if (o.kind === "ellipse") d = (across / 2) * Math.sqrt(1 - t * t);
  else if (o.kind === "diamond") d = (across / 2) * (1 - Math.abs(t));
  if (o.kind === "cylinder" && axis === "v") {
    // the caps are arcs: top outline y0 + CAP - CAP*sqrt(1-t^2), bottom y0 + h - CAP + CAP*sqrt(1-t^2)
    const root = Math.sqrt(1 - t * t);
    const y = far ? o.y + o.h - CAP + CAP * root : o.y + CAP - CAP * root;
    return [c, y];
  }
  if (o.kind === "cylinder" && axis === "h") {
    // sides are straight between the caps
    if (c < o.y + 2 * CAP || c > o.y + o.h - 2 * CAP) return undefined;
    return [far ? o.x + o.w : o.x, c];
  }
  const along = centre + sign * d;
  return axis === "v" ? [c, along] : [along, c];
}
