// Zones as seen by edge labels: a label of an edge whose ends are both in a zone must be drawn inside
// it, and a label must stay out of every zone neither of its ends belongs to (a label straddling a
// zone border reads as belonging to the wrong group).

import type { Box, Point } from "./engine.js";

export interface Zone {
  box: Box;
  /** Ids of every node inside the zone (nested groups included). */
  members: Set<string>;
}

const TOUCH = 0.5;

const inside = (b: Box, z: Box) => b.x >= z.x - TOUCH && b.y >= z.y - TOUCH && b.x + b.w <= z.x + z.w + TOUCH && b.y + b.h <= z.y + z.h + TOUCH;
const depth = (a: Box, b: Box) =>
  Math.min(Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Zone borders as closed polylines (the router keeps clear of running along them). */
export function zoneBorders(zones: readonly Zone[]): Point[][] {
  return zones.map(({ box: b }) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }, { x: b.x, y: b.y }]);
}

/** Number of zones whose rule the label box (of an edge from `from` to `to`) breaks. */
export function zoneViolations(zones: readonly Zone[], from: string, to: string, label: Box): number {
  let n = 0;
  for (const z of zones) {
    const a = z.members.has(from);
    const b = z.members.has(to);
    if (a && b) {
      if (!inside(label, z.box)) n++;
    } else if (!a && !b && depth(label, z.box) > TOUCH) n++;
  }
  return n;
}
