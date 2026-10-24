// Plain 2D geometry for the quality checker. No dependencies, no I/O, deterministic.
// Points are [x, y] pairs; a rect is {x1, y1, x2, y2}; a polygon is a convex point list.
// Typed port of scripts/qa/geom.mjs (same algorithms and tolerances).

export type Pt = [number, number];
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export type Poly = Pt[];

/** The slice of an Excalidraw element the checker reads (scenes are untyped JSON). */
export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  groupIds?: string[];
  containerId?: string | null;
  text?: string;
  labelPosition?: number;
  /** Text bound to an arrow: its x/y/width/height is the box as drawn (neutral-geometry engines), not a point on the route. */
  exactPlacement?: boolean;
  /** Arrow: breadth in px of its arrowheads when the engine is not Excalidraw (absent = ~16 px Excalidraw heads). */
  arrowheadWidth?: number;
  points?: number[][];
  startArrowhead?: unknown;
  endArrowhead?: unknown;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  [key: string]: any;
}

export const rectOf = (x: number, y: number, w: number, h: number): Rect => ({ x1: x, y1: y, x2: x + w, y2: y + h });

export const rectPoly = (r: Rect): Poly => [
  [r.x1, r.y1],
  [r.x2, r.y1],
  [r.x2, r.y2],
  [r.x1, r.y2],
];

/** Axis-aligned overlap depth: min(overlap in x, overlap in y); <= 0 when the rects are apart. */
export function rectOverlapDepth(a: Rect, b: Rect): number {
  const dx = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const dy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  return Math.min(dx, dy);
}

/** True when rect `inner` lies inside `outer` with `tol` px of slack. */
export const rectInside = (inner: Rect, outer: Rect, tol = 0): boolean =>
  inner.x1 >= outer.x1 - tol && inner.y1 >= outer.y1 - tol && inner.x2 <= outer.x2 + tol && inner.y2 <= outer.y2 + tol;

/** Rect shrunk by `d` on every side (negative `d` grows it). */
export const shrink = (r: Rect, d: number): Rect => ({ x1: r.x1 + d, y1: r.y1 + d, x2: r.x2 - d, y2: r.y2 - d });

/** Convex polygon for a shape element, scaled about its center so it is `inset` px smaller per side. */
export function shapePoly(el: SceneElement, inset = 0): Poly {
  const w = Math.max(el.width, 0.0001);
  const h = Math.max(el.height, 0.0001);
  const cx = el.x + w / 2;
  const cy = el.y + h / 2;
  const sx = Math.max(0.01, (w - 2 * inset) / w);
  const sy = Math.max(0.01, (h - 2 * inset) / h);
  let base: Poly;
  if (el.type === "diamond") {
    base = [
      [0, -0.5],
      [0.5, 0],
      [0, 0.5],
      [-0.5, 0],
    ];
  } else if (el.type === "ellipse") {
    base = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      base.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
    }
  } else {
    base = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
  }
  return base.map(([ux, uy]) => [cx + ux * w * sx, cy + uy * h * sy]);
}

function project(poly: Poly, ax: number, ay: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of poly) {
    const d = x * ax + y * ay;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

/** Penetration depth of two convex polygons by SAT: > 0 when they overlap, <= 0 when apart. */
export function convexOverlapDepth(a: Poly, b: Poly): number {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]!;
      const [x2, y2] = poly[(i + 1) % poly.length]!;
      let ax = y1 - y2;
      let ay = x2 - x1;
      const len = Math.hypot(ax, ay);
      if (len === 0) continue;
      ax /= len;
      ay /= len;
      const [alo, ahi] = project(a, ax, ay);
      const [blo, bhi] = project(b, ax, ay);
      const d = Math.min(ahi, bhi) - Math.max(alo, blo);
      if (d <= 0) return d;
      if (d < depth) depth = d;
    }
  }
  return depth;
}

/** Length of segment p-q that lies inside a convex polygon (Cyrus-Beck clip); 0 when outside. */
export function segInsideLength(p: Pt, q: Pt, poly: Poly): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    area += x1 * y2 - x2 * y1;
  }
  const sign = area >= 0 ? 1 : -1; // normalise winding so "inside" is consistent
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    // inside when cross(edge, point - a) * sign >= 0
    const ex = x2 - x1;
    const ey = y2 - y1;
    const num = sign * (ex * (p[1] - y1) - ey * (p[0] - x1));
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

/** Does segment p-q touch rect r (inclusive)? */
export function segHitsRect(p: Pt, q: Pt, r: Rect): boolean {
  return segInsideLength(p, q, rectPoly(r)) > 0 || pointInRect(p, r) || pointInRect(q, r);
}

export const pointInRect = (p: Pt, r: Rect): boolean => p[0] >= r.x1 && p[0] <= r.x2 && p[1] >= r.y1 && p[1] <= r.y2;

/** Proper intersection of segments p1-p2 and p3-p4: {point, t, u} or null (parallel/disjoint). */
export function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): { point: Pt; t: number; u: number } | null {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: [p1[0] + t * d1x, p1[1] + t * d1y], t, u };
}

export const segLength = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);

export const pathLength = (pts: Pt[]): number => {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += segLength(pts[i - 1]!, pts[i]!);
  return n;
};

/** Point at fraction f (0..1) of the polyline's length. */
export function pointAtFraction(pts: Pt[], f: number): Pt {
  const total = pathLength(pts);
  let want = Math.min(1, Math.max(0, f)) * total;
  for (let i = 1; i < pts.length; i++) {
    const len = segLength(pts[i - 1]!, pts[i]!);
    if (want <= len || i === pts.length - 1) {
      const k = len === 0 ? 0 : Math.min(1, want / len);
      const a = pts[i - 1]!;
      const b = pts[i]!;
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    want -= len;
  }
  return pts[0]!;
}

/**
 * Closest approach of two near-parallel segments: when their directions differ by < `maxSin`
 * (sine of the angle) and their projections onto a's direction overlap by `minRun` px or more,
 * returns {dist, run}; otherwise null.
 */
export function parallelRun(a1: Pt, a2: Pt, b1: Pt, b2: Pt, maxSin = 0.12, minRun = 16): { dist: number; run: number } | null {
  const ax = a2[0] - a1[0];
  const ay = a2[1] - a1[1];
  const bx = b2[0] - b1[0];
  const by = b2[1] - b1[1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1 || lb < 1) return null;
  if (Math.abs(ax * by - ay * bx) / (la * lb) > maxSin) return null;
  const ux = ax / la;
  const uy = ay / la;
  const s1 = (b1[0] - a1[0]) * ux + (b1[1] - a1[1]) * uy;
  const s2 = (b2[0] - a1[0]) * ux + (b2[1] - a1[1]) * uy;
  const run = Math.min(la, Math.max(s1, s2)) - Math.max(0, Math.min(s1, s2));
  if (run < minRun) return null;
  const d1 = Math.abs((b1[0] - a1[0]) * uy - (b1[1] - a1[1]) * ux);
  const d2 = Math.abs((b2[0] - a1[0]) * uy - (b2[1] - a1[1]) * ux);
  return { dist: (d1 + d2) / 2, run };
}

// ---- helpers for the extra rules (src/quality/rules-extra.ts) ----

/** Absolute points of an arrow element. */
export const arrowPoints = (a: SceneElement): Pt[] => (a.points ?? []).map((p): Pt => [a.x + p[0]!, a.y + p[1]!]);

/** Distance from point p to segment a-b. */
export function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from p to a polyline (Infinity for fewer than 2 points). */
export function polylineDist(p: Pt, pts: Pt[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, pointSegDist(p, pts[i - 1]!, pts[i]!));
  return d;
}

/** Distance from p to the rect (0 when inside). */
export const rectPointDist = (r: Rect, p: Pt): number => Math.hypot(Math.max(r.x1 - p[0], 0, p[0] - r.x2), Math.max(r.y1 - p[1], 0, p[1] - r.y2));

/** Distance from a polyline to a rect: 0 when it touches or enters the rect. */
export function polylineRectDist(pts: Pt[], r: Rect): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return rectPointDist(r, pts[0]!);
  const corners = rectPoly(r);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (segHitsRect(a, b, r)) return 0;
    best = Math.min(best, rectPointDist(r, a), rectPointDist(r, b), ...corners.map((c) => pointSegDist(c, a, b)));
  }
  return best;
}

/** Is p inside (or on) the convex polygon, either winding? */
export function pointInConvex(p: Pt, poly: Poly): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    const c = (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
    if (c > 0) pos = true;
    else if (c < 0) neg = true;
  }
  return !(pos && neg);
}

/** Distance from p to the polygon outline. */
export function polyBoundaryDist(p: Pt, poly: Poly): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegDist(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return d;
}

/** How deep p lies inside a convex polygon (0 on or outside the outline). */
export const insideDepth = (p: Pt, poly: Poly): number => (pointInConvex(p, poly) ? polyBoundaryDist(p, poly) : 0);

/**
 * Outward unit normals of the polygon edges within `slack` px of the nearest edge to p
 * (more than one near a corner). `poly` is convex; each normal points away from the centroid.
 */
export function outwardNormalsAt(p: Pt, poly: Poly, slack = 1): Pt[] {
  const cx = poly.reduce((s, q) => s + q[0], 0) / poly.length;
  const cy = poly.reduce((s, q) => s + q[1], 0) / poly.length;
  const edges = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    let nx = b[1] - a[1];
    let ny = a[0] - b[0];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { d: pointSegDist(p, a, b), n: [nx, ny] as Pt };
  });
  const min = Math.min(...edges.map((e) => e.d));
  return edges.filter((e) => e.d <= min + slack).map((e) => e.n);
}

/**
 * Unit direction in which the path ARRIVES at its first (atEnd=false) or last (atEnd=true) point,
 * skipping zero-length segments; null for a fully degenerate path.
 */
export function arrivalDirection(pts: Pt[], atEnd: boolean): Pt | null {
  const n = pts.length;
  for (let k = 1; k < n; k++) {
    const from = (atEnd ? pts[n - 1 - k] : pts[k])!;
    const to = (atEnd ? pts[n - k] : pts[k - 1])!;
    const l = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (l >= 1e-6) return [(to[0] - from[0]) / l, (to[1] - from[1]) / l];
  }
  return null;
}
