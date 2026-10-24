// Small 2D helpers shared by edge routing (route.ts) and label placement (labels.ts).

import type { Box, Point } from "./engine.js";

export const center = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const len = (a: Point) => Math.hypot(a.x, a.y);

/** Do two boxes overlap once `b` is grown by `pad` on every side? */
export const overlap = (a: Box, b: Box, pad: number) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/** Does segment p->q pass through `box` grown by `pad`? (Liang-Barsky.) */
export function segmentHits(p: Point, q: Point, box: Box, pad: number): boolean {
  const x1 = box.x - pad;
  const y1 = box.y - pad;
  const x2 = box.x + box.w + pad;
  const y2 = box.y + box.h + pad;
  // segments whose bounding box misses the box are the common case: reject them before clipping
  if ((p.x < x1 && q.x < x1) || (p.x > x2 && q.x > x2) || (p.y < y1 && q.y < y1) || (p.y > y2 && q.y > y2)) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  // Clip the parameter range against the four box sides (pp: direction towards the side, qq: distance to it).
  for (let side = 0; side < 4; side++) {
    const pp = side === 0 ? -dx : side === 1 ? dx : side === 2 ? -dy : dy;
    const qq = side === 0 ? p.x - x1 : side === 1 ? x2 - p.x : side === 2 ? p.y - y1 : y2 - p.y;
    if (pp === 0) {
      if (qq < 0) return false;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1;
}

/** Total length of a polyline. */
export function pathLength(pts: Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += len(sub(pts[i]!, pts[i - 1]!));
  return total;
}

/**
 * Smallest distance between two segments that run side by side (angle below `maxAngle` radians and
 * overlapping when projected on each other), or Infinity when they are not near-parallel.
 */
export function parallelGap(p: Point, q: Point, r: Point, s: Point, maxAngle = 0.35): number {
  const u = sub(q, p);
  const v = sub(s, r);
  const lu = len(u);
  const lv = len(v);
  if (lu < 1 || lv < 1) return Infinity;
  if (Math.abs(u.x * v.y - u.y * v.x) / (lu * lv) >= Math.sin(maxAngle)) return Infinity;
  let best = Infinity;
  for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const m = { x: p.x + u.x * f, y: p.y + u.y * f };
    const k = (dot(sub(m, r), v)) / (lv * lv);
    if (k <= 0 || k >= 1) continue; // beyond the other segment: not side by side
    best = Math.min(best, len(sub(m, { x: r.x + v.x * k, y: r.y + v.y * k })));
  }
  return best;
}
