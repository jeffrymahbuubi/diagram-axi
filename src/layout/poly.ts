// Convex-polygon helpers for node outlines (rect / ellipse / diamond): overlap depth by SAT and the
// length of a segment inside a polygon. Used to judge labels and routes against the real node shapes.

import type { ShapeKind } from "../dsl/ast.js";
import type { Box, Point } from "./engine.js";

export type Poly = Point[];

export function rectPoly(b: Box): Poly {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

/** Convex outline of a node, scaled about its center so it is `inset` px smaller per side. */
export function shapePoly(shape: ShapeKind, b: Box, inset = 0): Poly {
  const w = Math.max(b.w, 1e-4);
  const h = Math.max(b.h, 1e-4);
  const cx = b.x + w / 2;
  const cy = b.y + h / 2;
  const sx = Math.max(0.01, (w - 2 * inset) / w);
  const sy = Math.max(0.01, (h - 2 * inset) / h);
  let base: Array<[number, number]>;
  if (shape === "diamond") {
    base = [[0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]];
  } else if (shape === "ellipse") {
    base = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      base.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
    }
  } else {
    base = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  }
  return base.map(([ux, uy]) => ({ x: cx + ux * w * sx, y: cy + uy * h * sy }));
}

function project(poly: Poly, ax: number, ay: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const d = p.x * ax + p.y * ay;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** Penetration depth of two convex polygons (SAT): > 0 when they overlap, <= 0 when apart. */
export function overlapDepth(a: Poly, b: Poly): number {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      let ax = p.y - q.y;
      let ay = q.x - p.x;
      const l = Math.hypot(ax, ay);
      if (l === 0) continue;
      ax /= l;
      ay /= l;
      const [alo, ahi] = project(a, ax, ay);
      const [blo, bhi] = project(b, ax, ay);
      const d = Math.min(ahi, bhi) - Math.max(alo, blo);
      if (d <= 0) return d;
      if (d < depth) depth = d;
    }
  }
  return depth;
}

/** Length of segment p-q inside a convex polygon (Cyrus-Beck); 0 when outside. */
export function segInside(p: Point, q: Point, poly: Poly): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area >= 0 ? 1 : -1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const num = sign * (ex * (p.y - a.y) - ey * (p.x - a.x));
    const den = sign * (ex * dy - ey * dx);
    if (den === 0) {
      if (num < 0) return 0;
      continue;
    }
    const t = -num / den;
    if (den > 0) {
      if (t > t0) t0 = t;
    } else if (t < t1) t1 = t;
    if (t0 > t1) return 0;
  }
  return (t1 - t0) * Math.hypot(dx, dy);
}
