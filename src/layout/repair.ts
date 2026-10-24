// Repair pass: after the first routing and label placement, every edge that takes part in a defect
// (see board.ts) is offered alternative routes (A* between other sides / ports / clearances) and
// label spots. A change is kept only when it lowers the number of defects involving that edge, so the
// pass terminates and never makes the diagram worse. Deterministic: edges in index order, candidates
// in a fixed order, the first change that removes every defect without new crossings wins.

import type { Box, Point } from "./engine.js";
import { SHORT_STUB, astarRoute } from "./astar.js";
import { Board, type BoardEdge } from "./board.js";
import { pointAt } from "./labels.js";
import { len, pathLength, segmentHits, sub } from "./geom.js";
import { loopOn } from "./loops.js";
import { zoneBorders } from "./zones.js";
import { NORMAL, OPPOSITE, headFootprints, headWindows, overlapArea, portOnSide, sideOfPoint, type Side } from "./route-util.js";
import type { RouteNode } from "./route.js";
import { T } from "./tune.js";

const SIDES: Side[] = ["right", "bottom", "left", "top"];
const MAX_ROUNDS = 40;
const BEND_WEIGHT = 30;
/** A candidate route may have at most this many points and be at most this much longer than the Manhattan distance. */
const MAX_POINTS = 8;
const MAX_DETOUR = 2.2;
/** When no port satisfies the full pitch and stub (a small node under a zone title, a crowded side) the old, tighter ones are used. */
const RELAXED_PORT_CLEAR = 20;
const RELAXED_OFFSETS = [0, 22, -22, 44, -44, 66, -66];
const STUB_PAD = 9;
/** Label spots scanned along a route and the pads that prefer clear space over merely legal space. */
const SLOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88, 0.05, 0.95];
const SCAN_STEP = 5;
const NEAR_NODE = 4;
/** Price of a label box lying on the stretch of its own route behind an arrowhead, and of a foreign arrow within NEAR_ARROW of it. */

const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
const pairKey = (e: { from: string; to: string }) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`);

/** Put edge `e`'s label on the best spot of its current route; returns nothing, updates `e.box`. */
export function placeOne(board: Board, e: BoardEdge): void {
  if (!e.label) return;
  const { w, h } = e.label;
  const fractions = [...SLOTS.map((f, s) => ({ f, pref: s }))];
  const total = pathLength(e.route);
  const steps = Math.max(8, Math.ceil(total / SCAN_STEP));
  for (let i = 0; i <= steps; i++) fractions.push({ f: i / steps, pref: 12 + (20 * Math.abs(i / steps - 0.5)) });
  let best: { box: Box; score: number } | undefined;
  const wins = T.headCover ? headWindows(e.route, e.heads ?? [false, true]) : [];
  let feet: Box[] | undefined; // footprints of every arrowhead on the board, computed when a spot first needs them
  for (const { f, pref } of fractions) {
    const c = pointAt(e.route, f, total);
    const box = { x: c.x - w / 2, y: c.y - h / 2, w, h };
    const nodes = board.labelClashes(box, e.index);
    const arrows = board.labelArrowHits(box, e.index);
    let score = pref + nodes * 10000 + arrows * 400;
    if (wins.some((w) => w.some((p, i) => i > 0 && segmentHits(w[i - 1]!, p, box, 0)))) score += T.headCover;
    if (best && score >= best.score) continue;
    if (T.headFoot) {
      feet ??= [...board.edges.values()].flatMap((o) => headFootprints(o.route, o.heads ?? [false, true]));
      if (feet.some((ft) => overlapArea(box, ft) > 0.2 * ft.w * ft.h)) score += T.headFoot;
      if (best && score >= best.score) continue;
    }
    score += (board.labelClashes(grow(box, NEAR_NODE), e.index) - nodes) * 40 + (board.labelArrowHits(grow(box, T.nearArrowPad), e.index) - arrows) * T.nearArrowPrice;
    if (!best || score < best.score) best = { box, score };
  }
  e.box = best!.box;
}

/** Cost of a route as a tie-break between equally clean candidates: length plus a price per bend. */
function shape(route: Point[]): number {
  return pathLength(route) + BEND_WEIGHT * Math.max(0, route.length - 2);
}

/** Candidate ports on `side` of `node`: the current one first, then evenly spaced ones clear of other ports. */
function portsOn(node: RouteNode, side: Side, used: Point[], current: Point | undefined, blocks: Box[], relaxed = false): Point[] {
  const alongX = side === "top" || side === "bottom";
  const span = (alongX ? node.box.w : node.box.h) * 0.4;
  const out: Point[] = [];
  const stubLen = relaxed ? SHORT_STUB : T.finalStub;
  const clear = relaxed ? RELAXED_PORT_CLEAR : T.portPitch;
  // A port whose first stub runs into a fixed box (a zone title) is of no use.
  const stubOk = (p: Point) => {
    const n = NORMAL[side];
    const q = { x: p.x + n.x * stubLen, y: p.y + n.y * stubLen };
    return blocks.every((b) => !segmentHits(p, q, b, STUB_PAD));
  };
  const free = (p: Point) => stubOk(p) && used.every((u) => len(sub(u, p)) >= clear);
  if (current && sideOfPoint(node.box, current) === side && free(current)) out.push(current);
  for (const off of relaxed ? RELAXED_OFFSETS : T.portOffsets) {
    if (Math.abs(off) > span) continue;
    const p = portOnSide(node.shape, node.box, side, off);
    if (free(p) && out.every((q) => len(sub(q, p)) > 2)) out.push(p);
  }
  return out;
}

/** Lazily generated alternative routes for edge `e`. */
function* candidates(board: Board, e: BoardEdge): Generator<{ route: Point[]; level: number }> {
  const a = board.nodes.get(e.from)!;
  const b = board.nodes.get(e.to)!;
  if (e.from === e.to) {
    for (const side of SIDES) yield { route: loopOn(a, side, e.label).pts, level: 0 };
    return;
  }
  const others = [...board.edges.values()].filter((o) => o.index !== e.index);
  const usedOn = (id: string) =>
    others.flatMap((o) => [...(o.from === id ? [o.route[0]!] : []), ...(o.to === id ? [o.route[o.route.length - 1]!] : [])]);
  const usedA = usedOn(a.id);
  const usedB = usedOn(b.id);
  const key = pairKey(e);
  const placed = others.map((o) => o.route);
  const samePair = others.filter((o) => o.from !== o.to && pairKey(o) === key).map((o) => o.route);
  const obstacles = [...[...board.nodes.values()].filter((n) => n !== a && n !== b).map((n) => n.box), ...board.fixed];
  const ends = [a.box, b.box];
  const borders = zoneBorders(board.zones);
  const heads = T.headCross ? others.flatMap((o) => headWindows(o.route, o.heads ?? [false, true])) : [];

  let any = false;
  for (const relaxed of T.relaxedTier ? [false, true] : [false]) {
    if (relaxed && any) return;
    yield* tier(relaxed);
  }

  function* tier(relaxed: boolean): Generator<{ route: Point[]; level: number }> {
    const combos: Array<{ pa: Point; sa: Side; pb: Point; sb: Side; est: number }> = [];
    for (const sa of SIDES) {
      for (const sb of SIDES) {
        const pas = portsOn(a, sa, usedA, e.route[0], board.fixed, relaxed);
        const pbs = portsOn(b, sb, usedB, e.route[e.route.length - 1], board.fixed, relaxed);
        const n = Math.min(2, pas.length, pbs.length);
        for (let k = 0; k < n; k++) {
          const pa = pas[k]!;
          const pb = pbs[k]!;
          let est = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) + k * 8;
          if (NORMAL[sa].x * (pb.x - pa.x) + NORMAL[sa].y * (pb.y - pa.y) < 0) est += 60;
          if (NORMAL[sb].x * (pa.x - pb.x) + NORMAL[sb].y * (pa.y - pb.y) < 0) est += 60;
          if (sa === sb) est += 30;
          if (OPPOSITE[sa] === sb) est -= 10;
          combos.push({ pa, sa, pb, sb, est });
        }
      }
    }
    board.budget?.spend(combos.length * 4 + others.length * 4);
    combos.sort((p, q) => p.est - q.est);
    const top = combos.slice(0, 10);
    for (const [level, margin] of T.margins.entries()) {
      // The full stub first; a tight level that offers no such route is searched again with the short one.
      let found = false;
      for (const stub of relaxed ? [SHORT_STUB] : T.finalStub > SHORT_STUB ? [undefined, SHORT_STUB] : [undefined]) {
        if (stub !== undefined && found) break;
        for (const c of top) {
          for (const window of [160, 1e6]) {
            if (board.budget?.exhausted) return;
            const route = astarRoute({ ...c, obstacles, ends, margin, placed, samePair, borders, heads, window, budget: board.budget, stub, hug: polishing });
            if (route) {
              found = true;
              any = true;
              yield { route, level };
              break;
            }
          }
        }
      }
    }
  }
}

type Candidate = { route: Point[]; level: number };

/** Candidate routes already generated for an edge on a board state (the generator resumes when a search wants more). */
const generated = new WeakMap<Board, Map<string, { items: Candidate[]; rest: Generator<Candidate> | undefined }>>();

/** `candidates(board, e)`, computed once per board state: strict and loose searches, and repeated group orders, share it. */
function* candidatesCached(board: Board, e: BoardEdge): Generator<Candidate> {
  let byKey = generated.get(board);
  if (!byKey) generated.set(board, (byKey = new Map()));
  const key = `${e.index}#${polishing ? "p" : "r"}#${stateKey(board)}`;
  let entry = byKey.get(key);
  if (!entry) {
    if (byKey.size > 300) byKey.clear();
    byKey.set(key, (entry = { items: [], rest: candidates(board, e) }));
  }
  for (let i = 0; ; i++) {
    if (i < entry.items.length) {
      yield entry.items[i]!;
      continue;
    }
    const next = entry.rest?.next();
    if (!next || next.done) {
      entry.rest = undefined;
      return;
    }
    entry.items.push(next.value);
    yield next.value;
  }
}

type Mode = "slide" | "strict" | "loose" | "group";

/** 1 when the route is far longer than the straight line between its ends (a soft quality signal). */
function roundabout(route: Point[]): number {
  const straight = len(sub(route[route.length - 1]!, route[0]!));
  return straight >= 30 && pathLength(route) / straight > 3 ? 1 : 0;
}

interface Pick {
  route: Point[];
  box: Box | undefined;
  hard: number;
  /** Visual defects (board.visual); only counted by the polish pass, 0 otherwise. */
  vis: number;
  soft: number;
  cost: number;
}

/** The polish pass may add this many crossings (cost units) to an edge to clear a visual defect. */
const VIS_CROSS_SLACK = 2;

/** A route that is too winding to be a sensible candidate. */
function unreasonable(route: Point[]): boolean {
  const first = route[0]!;
  const last = route[route.length - 1]!;
  return route.length > MAX_POINTS || pathLength(route) > MAX_DETOUR * (Math.abs(first.x - last.x) + Math.abs(first.y - last.y)) + 120;
}

/**
 * Best (route, label spot) for edge `e` among its current route and the generated alternatives, by
 * defects, then crossings plus winding, then length. `strict` drops candidates that add crossings or
 * wind more than `limits`; the search stops at the first candidate with no defect within `limits`.
 * The edge is left as it was found.
 */
function search(board: Board, e: BoardEdge, limits: { cross: number; bad: number }, strict: boolean, slideOnly: boolean, vis = false): Pick | undefined {
  const keep = { route: e.route, box: e.box };
  let best: Pick | undefined;
  const consider = (route: Point[]): boolean => {
    if (route !== keep.route && unreasonable(route)) return false;
    e.route = route;
    placeOne(board, e);
    const s = board.score(e.index);
    const bad = roundabout(route);
    if (strict && (s.cross > limits.cross || bad > limits.bad)) return false;
    if (vis && route !== keep.route && (s.cross > limits.cross + VIS_CROSS_SLACK || bad > limits.bad)) return false;
    const v = vis ? board.visual(e.index).n : 0;
    const soft = s.cross + bad;
    const cost = shape(route);
    const cur = best;
    if (!cur || s.hard < cur.hard || (s.hard === cur.hard && (v < cur.vis || (v === cur.vis && (soft < cur.soft || (soft === cur.soft && cost < cur.cost)))))) {
      best = { route, box: e.box, hard: s.hard, vis: v, soft, cost };
    }
    return s.hard === 0 && s.cross <= limits.cross && bad <= limits.bad && v === 0;
  };
  const done = consider(keep.route); // just slide the label
  if (!done && !slideOnly) {
    // Candidates come in levels of growing clearance; once one is clean, finish its level (to take the
    // shortest clean route of that level) and stop.
    let cleanLevel = -1;
    for (const { route, level } of candidatesCached(board, e)) {
      if ((cleanLevel >= 0 && level > cleanLevel) || board.budget?.exhausted) break;
      if (consider(route) && cleanLevel < 0) cleanLevel = level;
    }
  }
  e.route = keep.route;
  e.box = keep.box;
  return best;
}

/**
 * Moves that already failed, per board state. Every search is a pure function of the state (all routes and
 * label spots), so once `improve(t, mode)` or a group re-route found nothing it will find nothing again until
 * some edge moves; the repair loops below would otherwise repeat those searches once per defective edge.
 */
const failed = new WeakMap<Board, Map<string, Set<string>>>();

/** All routes and label spots of the board in index order: equal strings mean equal states. */
function stateKey(board: Board): string {
  const parts: string[] = [];
  for (const i of [...board.edges.keys()].sort((p, q) => p - q)) {
    const e = board.edges.get(i)!;
    parts.push(`${i}:${e.route.map((p) => `${p.x},${p.y}`).join(" ")}${e.box ? `@${e.box.x},${e.box.y}` : ""}`);
  }
  return parts.join(";");
}

/** Remember (`true`) or ask (`undefined`) whether `move` already failed on the current state of `board`. */
function failedBefore(board: Board, move: string, remember?: true): boolean {
  let byState = failed.get(board);
  if (!byState) failed.set(board, (byState = new Map()));
  const state = stateKey(board);
  let moves = byState.get(state);
  if (remember) {
    if (byState.size > 200) byState.clear();
    if (!moves) byState.set(state, (moves = new Set()));
    moves.add(move);
    return true;
  }
  return moves?.has(move) ?? false;
}

/**
 * Try to lower the defect count of edge `t`. `slide` only moves its label along the current route;
 * `strict` also tries other routes but only keeps one that adds no crossing and is not more roundabout;
 * `loose` takes any route that removes defects, preferring fewer crossings.
 */
function improve(board: Board, t: number, mode: "slide" | "strict" | "loose"): boolean {
  const e = board.edges.get(t)!;
  const cur = board.score(t);
  if (cur.hard === 0) return false;
  const move = `${mode}|${t}`;
  if (failedBefore(board, move)) return false;
  const pick = search(board, e, { cross: cur.cross, bad: roundabout(e.route) }, mode === "strict", mode === "slide");
  if (!pick || pick.hard >= cur.hard) {
    if (!board.budget?.exhausted) failedBefore(board, move, true);
    return false;
  }
  e.route = pick.route;
  e.box = pick.box;
  return true;
}

/**
 * Re-route all edges of one node pair from scratch, one after the other, so that each takes a lane the
 * earlier ones left free. Kept only when the group ends up with fewer defects.
 */
function rerouteGroup(board: Board, group: number[], order: number[]): boolean {
  const objs = group.map((i) => board.edges.get(i)!);
  const sum = () => group.reduce((n, i) => n + board.score(i).hard, 0);
  const before = sum();
  const saved = objs.map((e) => ({ e, route: e.route, box: e.box }));
  for (const i of group) board.edges.delete(i);
  for (const i of order) {
    const e = objs[group.indexOf(i)]!;
    board.edges.set(i, e);
    const pick = search(board, e, { cross: 0, bad: 0 }, false, false);
    if (pick) {
      e.route = pick.route;
      e.box = pick.box;
    }
  }
  if (sum() < before) return true;
  for (const s of saved) {
    s.e.route = s.route;
    s.e.box = s.box;
  }
  return false;
}

/** Edges that join the same node pair as `t` (including `t`), ascending; empty for loops. */
function pairGroup(board: Board, t: number): number[] {
  const e = board.edges.get(t)!;
  if (e.from === e.to) return [];
  const key = pairKey(e);
  return [...board.edges.values()].filter((o) => o.from !== o.to && pairKey(o) === key).map((o) => o.index).sort((p, q) => p - q);
}

/**
 * Try to lower the visual defects (board.visual) of edge `t` without adding HARD defects: the label may slide, the
 * edge may take another route. Kept only when the defects involving `t` (HARD first, then visual) go down.
 */
function improveVisual(board: Board, t: number): boolean {
  const e = board.edges.get(t)!;
  const cur = board.score(t);
  const curV = board.visual(t).n;
  if (curV === 0) return false;
  const move = `vis|${t}`;
  if (failedBefore(board, move)) return false;
  const pick = search(board, e, { cross: cur.cross, bad: roundabout(e.route) }, false, false, true);
  if (!pick || pick.hard > cur.hard || (pick.hard === cur.hard && pick.vis >= curV)) {
    if (!board.budget?.exhausted) failedBefore(board, move, true);
    return false;
  }
  // The others involved must not be left worse off than the edge itself got better: compare the visual total of the neighbourhood.
  const hood = [t, ...board.visual(t).others];
  const total = () => hood.reduce((n, i) => n + board.visual(i).n, 0);
  const before = total();
  const keep = { route: e.route, box: e.box };
  e.route = pick.route;
  e.box = pick.box;
  if (total() >= before) {
    e.route = keep.route;
    e.box = keep.box;
    if (!board.budget?.exhausted) failedBefore(board, move, true);
    return false;
  }
  return true;
}

/** Set while the polish pass runs: its A* searches also price runs along the end nodes' own sides. */
let polishing = false;

/** Rounds of the polish pass. */
const POLISH_ROUNDS = 6;
/** Share of the attempt's work limit one polish pass may spend. */
const POLISH_SHARE = 0.04;

/** After repair: clear what a reviewer sees as hidden or merged arrowheads (board.visual), never at the price of a HARD defect. */
export function polish(board: Board): void {
  if (!T.polish) return;
  // The polish may use only a small share of the budget (the layout routes the edges again after a zone grew, and the
  // attempts that follow need their work units); the cap is enforced by lowering the limit while it runs.
  const budget = board.budget;
  const saved = budget?.limit ?? 0;
  if (budget) budget.limit = Math.min(saved, budget.spent + POLISH_SHARE * saved);
  polishing = true;
  try {
    polishRounds(board);
  } finally {
    polishing = false;
    if (budget) budget.limit = saved;
  }
}

function polishRounds(board: Board): void {
  for (let round = 0; round < POLISH_ROUNDS && !board.budget?.exhausted; round++) {
    let progress = false;
    for (const i of [...board.edges.keys()].sort((p, q) => p - q)) {
      if (board.budget?.exhausted) break;
      const v = board.visual(i);
      if (v.n === 0) continue;
      for (const t of [i, ...[...v.others].sort((p, q) => p - q)]) {
        if (board.budget?.exhausted) break;
        if (improveVisual(board, t)) {
          progress = true;
          break;
        }
      }
    }
    if (!progress) break;
  }
}

/** Repair defective edges in place; returns the number of defects left (as counted by the board). */
export function repair(board: Board): number {
  for (let round = 0; round < MAX_ROUNDS && !board.budget?.exhausted; round++) {
    let progress = false;
    for (const mode of ["slide", "strict", "loose", "group"] as Mode[]) {
      for (const i of board.defective()) {
        if (board.budget?.exhausted) break;
        const sc = board.score(i);
        if (sc.hard === 0) continue;
        for (const t of [i, ...[...sc.others].sort((p, q) => p - q)]) {
          if (board.budget?.exhausted) break;
          if (mode === "group") {
            const g = pairGroup(board, t);
            if (g.length < 2 || g.length > 6) continue;
            const rev = [...g].reverse();
            const bad = g.filter((x) => board.score(x).hard > 0);
            const rest = g.filter((x) => !bad.includes(x));
            const orders = [g, rev, [...bad, ...rest]];
            const tried = (order: number[]) => {
              const move = `group|${order.join(",")}`;
              if (failedBefore(board, move)) return false;
              if (rerouteGroup(board, g, order)) return true;
              if (!board.budget?.exhausted) failedBefore(board, move, true);
              return false;
            };
            if (orders.some(tried)) {
              progress = true;
              break;
            }
          } else if (improve(board, t, mode)) {
            progress = true;
            break;
          }
        }
      }
      if (progress) break;
    }
    if (!progress) break;
  }
  return board.totalHard();
}
