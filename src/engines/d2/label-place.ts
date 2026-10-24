// Post-layout label placement. ELK reserves room for labels but D2 then draws every edge label at the middle of the
// finished route and every container title at one fixed corner, so labels land on neighbouring edges, nodes and titles.
// The compiled diagram is data (D2 renders whatever `labelPosition` / `labelPercentage` say), so after layout each label
// moves to the nearest spot that collides with nothing: along its own edge. Zone titles pick
// among the corners and sides of their zone. Deterministic; only polyline routes are touched (dagre's beziers keep D2's spot).

import { rectInside, rectOf, rectOverlapDepth, segHitsRect, shrink, type Rect } from "../../quality/geom.js";
import { curveToPolyline } from "../neutral.js";
import { labelBox, routeLabelBox } from "./label-box.js";
import type { D2Connection, D2Diagram } from "./wasm.js";

type Pt = [number, number];

/** Our diagram title shape (`d2_title`, `d2_title_`, ...) is placed by `near`, outside the layout. */
const TITLE_ID = /^d2_title_*$/;
const LIFELINE_ID = /^\(.* -- \)\[\d+\]$/;

/** Penalty for a collision the checker reports as HARD; soft preferences stay far below it. */
const HARD = 100;
/** Overlap depth (px) the checker tolerates between two boxes. */
const TOLERATED = 1;
/** Margin (px) kept around an edge label when testing it against other edges (the checker probes 1 px inside the box). */
const SAFE = 2;
/** Distance (px) from an arrowhead inside which a label reads as sitting on it. */
const NEAR_HEAD = 14;

/** Positions along the edge, nearest the middle first. */
const FRACTIONS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9];
/** The same positions in 1 % steps, nearest the middle first: the fallback when no coarse position is clear. */
const FINE_FRACTIONS = Array.from({ length: 80 }, (_, i) => 0.5 + (i % 2 === 0 ? 1 : -1) * Math.ceil((i + 1) / 2) * 0.01).filter((f) => f >= 0.1 && f <= 0.9).map((f) => Math.round(f * 100) / 100);
/**
 * Labels stay on their edge's line. D2 can also draw a label beside the line (UNLOCKED_TOP / _BOTTOM), but the checker
 * derives an arrow label's drawn spot from its position along the arrow (as Excalidraw does), so a label beside the line
 * would be measured at the wrong place; on the line, what is checked is what is drawn.
 */
const SIDES = ["MIDDLE"] as const;
/** A self-loop's label beside its far side: on the line it would replace the cap and leave two open stubs. */
const LOOP_SIDES = ["MIDDLE", "TOP", "BOTTOM"] as const;
/** Fractions of a self-loop's route where a label on the line hides the cap. */
const LOOP_CAP = [0.3, 0.7];
/** Clearance (px) kept between two edge labels. */
const LABEL_GAP = 4;
/**
 * Two labels of different edges within CROWD_X px horizontally and CROWD_Y px vertically of each other (the checker's
 * labels-side-by-side line, with a hair of margin) cannot be told apart: a reader does not know which arrow each belongs to.
 * That costs CROWD, soft: well above a spot's position preference and near-head cost (<= 8), far below a HARD collision.
 */
const CROWD_X = 24.5;
const CROWD_Y = 40.5;
const CROWD = 12;
const SOFT_DEFECT = 14;
/** Distance (px) from an arrowhead tip inside which a label hides part of the 24 px of route behind its own head / of a foreign head's footprint. */
const HEAD_COVER_OWN = 19;
const HEAD_COVER_FOREIGN = 16;
/** Margin (px) the checker grows a label by before counting the foreign arrows that touch it. */
const FOREIGN_TOUCH = 8.5;

/** Zone title positions, most conventional first. */
const ZONE_POSITIONS = ["INSIDE_TOP_LEFT", "INSIDE_TOP_RIGHT", "INSIDE_TOP_CENTER", "INSIDE_BOTTOM_LEFT", "INSIDE_BOTTOM_RIGHT", "INSIDE_BOTTOM_CENTER", "OUTSIDE_TOP_LEFT", "OUTSIDE_TOP_RIGHT", "OUTSIDE_TOP_CENTER", "OUTSIDE_BOTTOM_LEFT", "OUTSIDE_BOTTOM_RIGHT", "OUTSIDE_BOTTOM_CENTER"];

const rectOfBox = (b: { x: number; y: number; w: number; h: number }): Rect => rectOf(b.x, b.y, b.w, b.h);
const overlaps = (a: Rect, b: Rect): boolean => rectOverlapDepth(a, b) > TOLERATED;

/** How many segments of `route` cross `r`. */
function crosses(route: Pt[], r: Rect): number {
  let hits = 0;
  for (let i = 1; i < route.length; i++) if (segHitsRect(route[i - 1]!, route[i]!, r)) hits++;
  return hits;
}

interface Edge {
  c: D2Connection;
  route: Pt[];
  box?: Rect;
}

export interface PlaceStats {
  edgeLabels: number;
  moved: number;
  zoneTitles: number;
  titlesMoved: number;
}

/** Moves labels of a graph diagram (in place) so they collide with nothing, where a free spot exists. */
export function placeLabels(diagram: D2Diagram): PlaceStats {
  const stats: PlaceStats = { edgeLabels: 0, moved: 0, zoneTitles: 0, titlesMoved: 0 };
  const shapes = diagram.shapes.filter((s) => !TITLE_ID.test(s.id) || s.type !== "text");
  const ids = new Set(shapes.map((s) => s.id));
  const zones = shapes.filter((s) => shapes.some((o) => o.id.startsWith(`${s.id}.`)));
  const zoneIds = new Set(zones.map((z) => z.id));
  const nodes = shapes.filter((s) => !zoneIds.has(s.id));
  const nodeRects = nodes.map((n) => rectOf(n.pos.x, n.pos.y, n.width, n.height));
  const zoneRect = new Map(zones.map((z) => [z.id, rectOf(z.pos.x, z.pos.y, z.width, z.height)]));

  const edges: Edge[] = diagram.connections
    .filter((c) => !LIFELINE_ID.test(c.id) && !c.dst.includes("-lifeline-end-") && ids.has(c.src) && ids.has(c.dst))
    .map((c) => ({ c, route: curveToPolyline(c.route, c.isCurve === true).map((p): Pt => [p.x, p.y]) }));
  if (edges.length === 0 && zones.length === 0) return stats;

  const inside = (id: string, z: string): boolean => id === z || id.startsWith(`${z}.`);

  // Zone titles first: against the edges and nodes, which do not move.
  const titleRects = new Map<string, Rect>();
  for (const z of zones) {
    if (!z.label) continue;
    stats.zoneTitles++;
    const own = rectOf(z.pos.x, z.pos.y, z.width, z.height);
    let best: { cost: number; pos: string; rect: Rect } | undefined;
    ZONE_POSITIONS.forEach((pos, rank) => {
      const box = labelBox({ ...z, labelPosition: pos });
      if (!box) return;
      const r = rectOfBox(box);
      const probe = shrink(r, 1);
      let cost = rank * 0.5;
      for (const e of edges) cost += HARD * crosses(e.route, probe);
      for (const nr of nodeRects) if (overlaps(r, nr)) cost += HARD;
      for (const [id, t] of titleRects) if (id !== z.id && overlaps(r, t)) cost += HARD;
      for (const o of zones) {
        if (o.id === z.id || inside(z.id, o.id)) continue; // itself and its ancestors
        const orect = zoneRect.get(o.id)!;
        if (!inside(o.id, z.id) && overlaps(r, orect)) cost += HARD / 2; // a title drawn in a foreign zone
        // a title drawn inside a zone that is a descendant sits on its own content, which the node test already counts
      }
      if (rectInside(r, own, 0)) cost -= 0.01;
      if (!best || cost < best.cost - 1e-9) best = { cost, pos, rect: r };
    });
    if (best) {
      titleRects.set(z.id, best.rect);
      if (best.pos !== (z.labelPosition ?? "INSIDE_TOP_CENTER")) {
        z.labelPosition = best.pos;
        stats.titlesMoved++;
      }
    }
  }

  // Edge labels: all start where D2 puts them; each is then moved to its cheapest spot along its edge, twice over, most contested first.
  const labeled = edges.filter((e) => e.c.label && (e.c.labelWidth ?? 0) > 0 && (e.c.labelHeight ?? 0) > 0 && e.c.isCurve !== true && e.route.length >= 2);
  stats.edgeLabels = labeled.length;
  const boxOf = (e: Edge, position: string, percentage: number): Rect | undefined => {
    const b = routeLabelBox(e.route, e.c.labelWidth!, e.c.labelHeight!, position, percentage, e.c.strokeWidth);
    return b ? rectOfBox(b) : undefined;
  };
  for (const e of labeled) e.box = boxOf(e, e.c.labelPosition ?? "INSIDE_MIDDLE_CENTER", e.c.labelPercentage ?? 0);
  // labels that are fixed because their route is curved still count as obstacles
  const fixed: Rect[] = edges.filter((e) => e.c.label && e.c.isCurve === true && (e.c.labelWidth ?? 0) > 0).flatMap((e) => {
    const mid = e.route[Math.floor(e.route.length / 2)];
    return mid ? [rectOf(mid[0] - e.c.labelWidth! / 2, mid[1] - e.c.labelHeight! / 2, e.c.labelWidth!, e.c.labelHeight!)] : [];
  });

  const costOf = (e: Edge, r: Rect, rank: number): number => {
    let cost = rank;
    const probe = shrink(r, 1 - SAFE);
    for (const o of edges) if (o !== e) cost += HARD * crosses(o.route, probe);
    for (const nr of nodeRects) if (overlaps(r, nr)) cost += HARD;
    const apart = shrink(r, -LABEL_GAP); // two labels a hair apart read as one word
    for (const o of labeled) if (o !== e && o.box && overlaps(apart, o.box)) cost += HARD;
    for (const f of fixed) if (overlaps(r, f)) cost += HARD;
    const cluster = { x1: r.x1 - CROWD_X, x2: r.x2 + CROWD_X, y1: r.y1 - CROWD_Y, y2: r.y2 + CROWD_Y };
    for (const o of labeled) if (o !== e && o.box && o.box.x1 < cluster.x2 && o.box.x2 > cluster.x1 && o.box.y1 < cluster.y2 && o.box.y2 > cluster.y1) cost += CROWD;
    for (const t of titleRects.values()) if (overlaps(r, t)) cost += HARD;
    for (const z of zones) {
      const zr = zoneRect.get(z.id)!;
      const a = inside(e.c.src, z.id);
      const b = inside(e.c.dst, z.id);
      if (a && b && !rectInside(r, zr, TOLERATED)) cost += HARD;
      else if (!a && !b && rectOverlapDepth(r, zr) > TOLERATED) cost += HARD;
    }
    const first = e.route[0]!;
    const last = e.route[e.route.length - 1]!;
    for (const end of [first, last]) {
      const d = Math.hypot(Math.max(r.x1 - end[0], 0, end[0] - r.x2), Math.max(r.y1 - end[1], 0, end[1] - r.y2));
      if (d < NEAR_HEAD) cost += 4;
    }
    // Soft defects the checker reports (label-covers-own-arrow, arrowhead-covered, label-at-crossing): moving a label away from
    // a crowd must not trade one reading problem for another, so each costs a little more than the crowd it would escape.
    for (const o of edges) {
      const heads: Array<[Pt, boolean]> = [[o.route[0]!, !!o.c.srcArrow && o.c.srcArrow !== "none"], [o.route[o.route.length - 1]!, !!o.c.dstArrow && o.c.dstArrow !== "none"]];
      for (const [end, head] of heads) {
        if (!head) continue;
        const d = Math.hypot(Math.max(r.x1 - end[0], 0, end[0] - r.x2), Math.max(r.y1 - end[1], 0, end[1] - r.y2));
        if (d < (o === e ? HEAD_COVER_OWN : HEAD_COVER_FOREIGN)) cost += SOFT_DEFECT;
      }
    }
    const grown = shrink(r, -FOREIGN_TOUCH);
    if (edges.filter((o) => o !== e && crosses(o.route, grown) > 0).length >= 2) cost += SOFT_DEFECT;
    return cost;
  };

  const isLoop = (e: Edge): boolean => e.c.src === e.c.dst;
  /** Soft preference of a spot: near the middle, on the line; a self-loop's cap is not a place for a label. */
  const rank = (e: Edge, side: string, f: number): number =>
    Math.abs(f - 0.5) * 4 + (side === "MIDDLE" ? 0 : 1.5) + (isLoop(e) && side === "MIDDLE" && f > LOOP_CAP[0]! && f < LOOP_CAP[1]! ? 20 : 0);
  const currentOf = (e: Edge): number => {
    const [where = "INSIDE", side = "MIDDLE"] = (e.c.labelPosition ?? "INSIDE_MIDDLE_CENTER").split("_");
    const f = where === "UNLOCKED" ? (e.c.labelPercentage ?? 0.5) : 0.5;
    return costOf(e, e.box!, isLoop(e) ? rank(e, side, f) : 0);
  };
  const contested = (e: Edge): number => currentOf(e);
  const order = [...labeled].sort((a, b) => contested(b) - contested(a));
  for (let pass = 0; pass < 3; pass++) {
    for (const e of order) {
      const current = currentOf(e);
      if (current < (isLoop(e) ? 20 : CROWD)) continue; // the spot D2 chose (or an earlier pass found) is clean
      let best: { cost: number; side: string; f: number; box: Rect } | undefined;
      const search = (fractions: number[]): void => {
        fractions.forEach((f, fi) => {
          (isLoop(e) ? LOOP_SIDES : SIDES).forEach((side, si) => {
            const box = boxOf(e, `UNLOCKED_${side}`, f);
            if (!box) return;
            const cost = costOf(e, box, rank(e, side, f) + (fi + si) * 0.001);
            if (!best || cost < best.cost) best = { cost, side, f, box };
          });
        });
      };
      search(FRACTIONS);
      // no coarse spot is clean (a label nearly as wide as the gap between two nodes): look in 1 % steps
      if (!best || best.cost >= CROWD) search(FINE_FRACTIONS);
      if (best && best.cost < current) {
        e.box = best.box;
        e.c.labelPosition = `UNLOCKED_${best.side}`;
        e.c.labelPercentage = best.f;
      }
    }
  }
  stats.moved = labeled.filter((e) => e.c.labelPosition?.startsWith("UNLOCKED")).length;
  return stats;
}
