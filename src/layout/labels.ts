// Edge-label geometry: where layout puts arrow-bound text (placeLabels). Excalidraw draws arrow text
// at the text element's `labelPosition` (a 0..1 fraction of the path length; the polyline's middle
// when absent), so the scene builder stores the fraction of the chosen spot (fractionAt).

import type { Budget } from "./budget.js";
import type { Box, Point } from "./engine.js";
import { len, overlap, pathLength, segmentHits, sub } from "./geom.js";
import { headFootprints, headWindows, overlapArea } from "./route-util.js";
import { T } from "./tune.js";
import { zoneViolations, type Zone } from "./zones.js";

/** Point at fraction `f` (0..1) of the polyline's length (`total`: its length, when the caller already has it). */
function pointAt(pts: Point[], f: number, total: number = pathLength(pts)): Point {
  let rest = total * f;
  for (let i = 1; i < pts.length; i++) {
    const seg = len(sub(pts[i]!, pts[i - 1]!));
    if (rest <= seg && seg > 0) {
      const t = rest / seg;
      return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t };
    }
    rest -= seg;
  }
  return pts[pts.length - 1]!;
}

/** Fraction (0..1) of the polyline's length at the point of the polyline closest to `p`. */
export function fractionAt(pts: Point[], p: Point): number {
  const total = pathLength(pts);
  if (total === 0) return 0.5;
  let walked = 0;
  let bestD = Infinity;
  let bestAt = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = len(sub(b, a));
    const l2 = seg * seg;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
    const d = len(sub(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
    if (d < bestD - 1e-9) {
      bestD = d;
      bestAt = walked + seg * t;
    }
    walked += seg;
  }
  return bestAt / total;
}

export { pointAt };

export interface LabelRequest {
  index: number;
  w: number;
  h: number;
  points: Point[];
  /** Ends of the edge (for the zone rules); labels without them ignore zones. */
  from?: string;
  to?: string;
  /** Whether the start / end carries an arrowhead (default: end only); the label keeps off the route behind a head. */
  heads?: [boolean, boolean];
}

/** Breathing room kept between a label and nodes / other labels / other edges. */
const LABEL_NODE_PAD = 2;
const LABEL_LABEL_PAD = 6;
const LABEL_EDGE_PAD = 2;
/** A label on a node or on another label is never acceptable; another edge running through it is nearly as bad. */
const CLASH = 10000;
const FOREIGN_EDGE = 400;
/** A label box within T.nearArrowPad of a foreign route (the checker's label-at-crossing margin) costs NEAR_EDGE; on the stretch behind its own arrowhead T.headCover. */
const NEAR_EDGE = 60;
/** Preferred positions along a route, best first (fractions of its length); a dense scan follows as a fallback. */
const LABEL_SLOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88, 0.05, 0.95];
/**
 * Two labels of different edges within CROWD_X px horizontally and CROWD_Y px vertically of each other (the checker's
 * labels-side-by-side line) cannot be told apart: the reader does not know which arrow each belongs to. A final polishing
 * pass slides a crowded label along its own route to a spot with fewer neighbours, but only where every other penalty
 * (clashes, foreign edges, arrowheads) is no worse than at its current spot; a crowd costs more than sliding (pref <= ~32).
 */
const CROWD_X = 24.5;
const CROWD_Y = 40.5;
const CROWD = 40;
const POLISH_ROUNDS = 3;
const crowded = (a: Box, b: Box): boolean => a.x - CROWD_X < b.x + b.w && a.x + a.w + CROWD_X > b.x && a.y - CROWD_Y < b.y + b.h && a.y + a.h + CROWD_Y > b.y;
const SCAN_STEP = 5;
const SCAN_BASE = 12;
const REFINE_ROUNDS = 3;

export interface Candidate {
  at: Point;
  box: Box;
  /** Position preference: lower is closer to the route's middle. */
  pref: number;
}

export function candidatesFor(r: LabelRequest): Candidate[] {
  const out: Candidate[] = [];
  const total = pathLength(r.points);
  const add = (f: number, pref: number) => {
    const c = pointAt(r.points, f, total);
    out.push({ at: c, box: { x: Math.round(c.x - r.w / 2), y: Math.round(c.y - r.h / 2), w: r.w, h: r.h }, pref });
  };
  LABEL_SLOTS.forEach((f, s) => add(f, s));
  const steps = Math.max(8, Math.ceil(total / SCAN_STEP));
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    add(f, SCAN_BASE + 20 * Math.abs(f - 0.5));
  }
  return out;
}

/**
 * Center each label on its own route, sliding it along the route to the spot with the fewest
 * clashes: nodes and other fixed boxes, other labels, and other edges' segments (in that order of
 * severity). Labels are placed one by one, then every label is re-placed against the final
 * positions of the others a few times, which resolves jams a single greedy pass leaves behind.
 * Deterministic: requests are handled in the order given and candidates in a fixed order.
 */
export function placeLabels(
  requests: LabelRequest[],
  obstacles: Box[],
  routes: Point[][],
  zones: readonly Zone[] = [],
  budget?: Budget,
  /** Arrowheads at [start, end] of every route in `routes` (default: end only); labels keep off their footprints. */
  heads?: Array<[boolean, boolean]>,
): Map<number, { box: Box; at: Point }> {
  const cands = requests.map(candidatesFor);
  const feet = T.headFoot ? routes.flatMap((r, k) => headFootprints(r, heads?.[k] ?? [false, true])) : [];
  const headWins = requests.map((r) => (T.headCover ? headWindows(r.points, r.heads ?? [false, true]) : []));
  const chosen: Array<Candidate & { score: number }> = [];
  const segments = routes.reduce((n, r) => n + Math.max(0, r.length - 1), 0);

  /** Score of candidate `c` for request `ri`; once it reaches `limit` the rest is skipped (the caller only wants scores below it). */
  const scoreOf = (ri: number, c: Candidate, limit = Infinity): number => {
    const own = requests[ri]!.points;
    const req = requests[ri]!;
    budget?.spend(obstacles.length + chosen.length + segments + 2);
    let score = c.pref;
    if (req.from !== undefined && req.to !== undefined) score += zoneViolations(zones, req.from, req.to, c.box) * CLASH;
    for (const o of obstacles) {
      if (overlap(c.box, o, LABEL_NODE_PAD)) {
        score += CLASH;
        if (score >= limit) return score;
      }
    }
    for (let j = 0; j < chosen.length; j++) {
      const p = chosen[j];
      if (j !== ri && p && overlap(c.box, p.box, LABEL_LABEL_PAD)) {
        score += CLASH;
        if (score >= limit) return score;
      }
    }
    for (const route of routes) {
      if (route === own) continue;
      if (score >= limit) return score;
      let near = false;
      for (let i = 1; i < route.length; i++) {
        if (segmentHits(route[i - 1]!, route[i]!, c.box, LABEL_EDGE_PAD)) {
          score += FOREIGN_EDGE;
          near = false;
          break;
        }
        if (T.headCover && segmentHits(route[i - 1]!, route[i]!, c.box, T.nearArrowPad)) near = true;
      }
      if (near) score += NEAR_EDGE;
    }
    // no arrowhead (own or foreign) sits under the label
    if (feet.length && score < limit) {
      budget?.spend(feet.length);
      for (const f of feet) {
        if (overlapArea(c.box, f) > 0.2 * f.w * f.h) {
          score += T.headFoot;
          break;
        }
      }
    }
    // the stretch of its own route behind an arrowhead stays visible
    for (const win of headWins[ri]!) {
      for (let i = 1; i < win.length; i++) {
        if (segmentHits(win[i - 1]!, win[i]!, c.box, 0)) {
          score += T.headCover;
          break;
        }
      }
    }
    return score;
  };
  /** Set once the first greedy pass is done: from then on the budget may cut the searches short. */
  let refining = false;
  const best = (ri: number) => {
    let top: (Candidate & { score: number }) | undefined;
    for (const c of cands[ri]!) {
      if (top && refining && budget?.exhausted) break; // the preferred slots come first
      if (top && c.pref >= top.score) continue; // every penalty is >= 0: this candidate cannot score below the best so far
      const score = scoreOf(ri, c, top ? top.score : Infinity);
      if (!top || score < top.score) top = { ...c, score };
    }
    return top!;
  };

  requests.forEach((_, ri) => {
    chosen[ri] = best(ri);
  });
  refining = true;
  for (let round = 0; round < REFINE_ROUNDS && !budget?.exhausted; round++) {
    let moved = false;
    requests.forEach((_, ri) => {
      const cur = chosen[ri]!;
      const now = scoreOf(ri, cur); // others may have moved since it was chosen
      const next = best(ri);
      if (next.score < now - 1e-9) {
        chosen[ri] = next;
        moved = true;
      } else {
        chosen[ri] = { ...cur, score: now };
      }
    });
    if (!moved) break;
  }

  // Two labels that jam each other (each only fits where the other sits) need a joint move.
  for (let round = 0; round < REFINE_ROUNDS && !budget?.exhausted; round++) {
    let moved = false;
    for (let i = 0; i < requests.length; i++) {
      for (let j = i + 1; j < requests.length; j++) {
        if (budget?.exhausted) break;
        if (!overlap(chosen[i]!.box, chosen[j]!.box, LABEL_LABEL_PAD)) continue;
        const curI = chosen[i]!;
        const curJ = chosen[j]!;
        const base = scoreOf(i, curI) + scoreOf(j, curJ);
        let top = base;
        let pick: [Candidate & { score: number }, Candidate & { score: number }] | undefined;
        for (const ci of cands[i]!) {
          if (budget?.exhausted) break;
          chosen[i] = { ...ci, score: 0 };
          const cj = best(j);
          chosen[j] = cj;
          const sum = scoreOf(i, ci) + cj.score;
          if (sum < top - 1e-9) {
            top = sum;
            pick = [{ ...ci, score: 0 }, cj];
          }
        }
        chosen[i] = curI;
        chosen[j] = curJ;
        if (pick) {
          chosen[i] = pick[0];
          chosen[j] = pick[1];
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  // Polish: labels of different edges that sit side by side are told apart by sliding one along its own route. A move is
  // taken only when it leaves fewer neighbours and no other penalty (clash, foreign edge, arrowhead) is higher than now.
  const crowdOf = (ri: number, box: Box): number => chosen.reduce((n, p, j) => (j !== ri && p && crowded(box, p.box) ? n + 1 : n), 0);
  for (let round = 0; round < POLISH_ROUNDS && !budget?.exhausted; round++) {
    let moved = false;
    const order = requests.map((_, ri) => ri).sort((a, b) => crowdOf(b, chosen[b]!.box) - crowdOf(a, chosen[a]!.box));
    for (const ri of order) {
      if (budget?.exhausted) break;
      const cur = chosen[ri]!;
      const crowdNow = crowdOf(ri, cur.box);
      if (crowdNow === 0) continue;
      const penNow = scoreOf(ri, cur) - cur.pref;
      let top = cur.pref + CROWD * crowdNow;
      let pick: Candidate | undefined;
      for (const c of cands[ri]!) {
        const crowd = crowdOf(ri, c.box);
        if (crowd >= crowdNow || c.pref + CROWD * crowd >= top - 1e-9) continue;
        if (scoreOf(ri, c, penNow + c.pref + 1e-6) - c.pref > penNow + 1e-9) continue;
        top = c.pref + CROWD * crowd;
        pick = c;
      }
      if (pick) {
        chosen[ri] = { ...pick, score: scoreOf(ri, pick) };
        moved = true;
      }
    }
    if (!moved) break;
  }

  const out = new Map<number, { box: Box; at: Point }>();
  requests.forEach((r, ri) => out.set(r.index, { box: chosen[ri]!.box, at: chosen[ri]!.at }));
  return out;
}
