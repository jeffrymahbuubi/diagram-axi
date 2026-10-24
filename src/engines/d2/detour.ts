// Post-layout repair of arrows that run through a node (the checker's HARD `arrow-through-node`). ELK's layered router
// sometimes puts the long vertical run of a labelled edge straight across the full height of a node that sits in the same
// column (measured in scripts/qa/d2-sweep.mjs: every such hit is a vertical run through a node, on an edge with a label);
// D2 hands ELK no options to prevent it, and spreadLanes only accepts moves that lower its own crowding score, so some
// intrusions survive it. Here a segment through a foreign node is moved or bypassed: the whole segment slides clear of the
// node, or the arrow jogs around the node and returns to its line (an orthogonal detour with four new corners).
// A candidate is kept only when the checker's own verdict on the whole diagram gets better: fewer arrow-through-node hits
// and no rule with more HARD findings than before. Deterministic; candidates are tried cheapest first.
//
// Also here: `reorderEdgeBlocks`, the one fixed alternative edge order that render.ts retries with when a detour fails.

import { analyzeScene } from "../../quality/analyze.js";
import { segInsideLength } from "../../quality/geom.js";
import { curveToPolyline, toScene, type NeutralScene } from "../neutral.js";
import { diagramToNeutral, rulesSkippedFor, titlesOutsideZones } from "./geometry.js";
import { placeLabels } from "./label-place.js";
import { outlineOf, type Outline, type Pt } from "./lane-shapes.js";
import { orthogonal, shiftSegment } from "./lane-spread.js";
import type { D2Connection, D2Diagram } from "./wasm.js";

/** Box of a node: what a detour goes around. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clearances (px) kept between the detour's lane and the node, tried in this order. */
const CLEAR = [12, 8, 18, 5];
/** Distance (px) before and after the node at which the arrow turns aside, tried in this order. */
const JOGS = [12, 8, 4];
/** Shortest piece kept at an arrow end (room for the arrowhead) and in the middle of a route. */
const MIN_END = 12;
const MIN_SEG = 6;
/** An arrow counts as running through a node when it is this far (px) inside the node's outline. */
const INSIDE = 0.5;
/** Candidates evaluated per hit, and hits repaired per diagram. */
const MAX_TRIES = 16;
const MAX_REPAIRS = 24;

const vertical = (a: Pt, b: Pt): boolean => Math.abs(a[0] - b[0]) < 1e-4;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const length = (pts: Pt[]): number => pts.reduce((n, p, i) => (i === 0 ? 0 : n + Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1])), 0);

/** The segment of `pts` that runs deepest inside `o` (index of its first point) and how deep (px); -1 when none does. */
export function deepestSegment(pts: Pt[], o: Outline): { k: number; inside: number } {
  let best = { k: -1, inside: INSIDE };
  for (let k = 0; k + 1 < pts.length; k++) {
    const inside = segInsideLength(pts[k]!, pts[k + 1]!, o.poly);
    if (inside > best.inside) best = { k, inside };
  }
  return best;
}

/**
 * Segment `k` of the orthogonal route `pts` goes round `box`: it turns aside `jog` px before the node, runs `clear` px beside
 * it and turns back `jog` px after it, so the route keeps its ends and gains four corners. `side` picks the left/top (`lo`)
 * or right/bottom (`hi`) of the node. Undefined when the segment has no room for the jogs (an arrow end needs
 * MIN_END px, a middle corner MIN_SEG).
 */
export function bypass(pts: Pt[], k: number, box: Box, side: "lo" | "hi", clear: number, jog: number): Pt[] | undefined {
  const a = pts[k]!;
  const b = pts[k + 1]!;
  const v = vertical(a, b);
  const ai = v ? 1 : 0; // coordinate along the segment
  const ci = v ? 0 : 1; // coordinate across it
  const dir = Math.sign(b[ai] - a[ai]);
  if (dir === 0) return undefined;
  const lo = v ? box.y : box.x;
  const hi = lo + (v ? box.h : box.w);
  const before = dir > 0 ? lo - jog : hi + jog;
  const after = dir > 0 ? hi + jog : lo - jog;
  const lane = side === "lo" ? (v ? box.x : box.y) - clear : (v ? box.x + box.w : box.y + box.h) + clear;
  const minA = k === 0 ? MIN_END : MIN_SEG;
  const minB = k + 2 === pts.length ? MIN_END : MIN_SEG;
  if ((before - a[ai]) * dir < minA || (b[ai] - after) * dir < minB) return undefined;
  if ((after - before) * dir <= 0) return undefined;
  const at = (along: number, across: number): Pt => (v ? [across, along] : [along, across]);
  const line = a[ci];
  const out = [...pts.slice(0, k + 1), at(before, line), at(before, lane), at(after, lane), at(after, line), ...pts.slice(k + 1)];
  return out.map((p): Pt => [r2(p[0]), r2(p[1])]);
}

/**
 * Candidate routes for segment `k` of `pts`, which runs through `box`, cheapest first: the segment slides clear of the node
 * (no new corners; needs the outlines of the arrow's own nodes to re-attach the ends), then detours round it.
 */
export function detourCandidates(pts: Pt[], k: number, box: Box, ends: { src?: Outline | undefined; dst?: Outline | undefined } = {}): Pt[][] {
  const v = vertical(pts[k]!, pts[k + 1]!);
  const here = pts[k]![v ? 0 : 1];
  const lo = v ? box.x : box.y;
  const hi = lo + (v ? box.w : box.h);
  const found: Pt[][] = [];
  for (const gap of [12, 8, 5]) {
    for (const delta of [hi + gap - here, lo - gap - here]) {
      const next = shiftSegment(pts, k, r2(delta), ends.src, ends.dst);
      if (next) found.push(next);
    }
  }
  const detours: Pt[][] = [];
  for (const clear of CLEAR) {
    for (const jog of JOGS) {
      for (const side of ["lo", "hi"] as const) {
        const next = bypass(pts, k, box, side, clear, jog);
        if (next) detours.push(next);
      }
    }
  }
  detours.sort((p, q) => length(p) - length(q));
  const seen = new Set<string>();
  return [...found, ...detours].filter((c) => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- the checker's verdict on a diagram ----

export interface ThroughHit {
  /** Id of the connection and of the node it runs through. */
  edge: string;
  node: string;
  /** px of the arrow inside the node. */
  inside: number;
}

export interface Verdict {
  hits: ThroughHit[];
  /** HARD findings per rule. */
  hard: Map<string, number>;
}

/** The checker's HARD findings on a neutral graph scene (the rules a graph diagram is measured on, as the engine reports them). */
export function judge(neutral: NeutralScene): Verdict {
  const skipped = new Set(rulesSkippedFor("graph"));
  if (titlesOutsideZones(neutral)) skipped.add("group-containment");
  const { findings } = analyzeScene({ elements: toScene(neutral) });
  const hard = new Map<string, number>();
  const hits: ThroughHit[] = [];
  for (const f of findings) {
    if (f.severity !== "hard" || skipped.has(f.code)) continue;
    hard.set(f.code, (hard.get(f.code) ?? 0) + 1);
    if (f.code !== "arrow-through-node") continue;
    const edge = neutral.edges[Number(/^edge-(\d+)$/.exec(f.elements[0] ?? "")?.[1])];
    const node = (f.elements[1] ?? "").replace(/^(?:node|cap)-/, "");
    if (edge) hits.push({ edge: edge.id, node, inside: Number(/runs ([\d.]+) px/.exec(f.detail)?.[1] ?? 0) });
  }
  return { hits, hard };
}

const TITLE_ID = /^d2_title_*$/;

/**
 * Cheap pre-test before the checker runs: false when no route goes further than INSIDE px into a node it does not end on
 * (a superset of the checker's hits for polyline routes; bezier routes are sampled).
 */
export function mayRunThrough(diagram: D2Diagram): boolean {
  const shapes = diagram.shapes.filter((s) => !TITLE_ID.test(s.id) || s.type !== "text");
  const zones = new Set(shapes.filter((s) => shapes.some((o) => o.id.startsWith(`${s.id}.`))).map((s) => s.id));
  const nodes = shapes.filter((s) => !zones.has(s.id)).map((s) => outlineOf(s, false));
  for (const c of diagram.connections) {
    const route = curveToPolyline(c.route, c.isCurve === true).map((p): Pt => [p.x, p.y]);
    for (const o of nodes) {
      if (o.id === c.src || o.id === c.dst) continue;
      for (let i = 1; i < route.length; i++) if (segInsideLength(route[i - 1]!, route[i]!, o.poly) > INSIDE) return true;
    }
  }
  return false;
}

const judgeDiagram =(d: D2Diagram): Verdict => judge(diagramToNeutral(d).neutral);

/** Arrows of a graph diagram that run through a node: the checker's `arrow-through-node` hits on its neutral geometry. */
export const throughHits = (neutral: NeutralScene): ThroughHit[] => judge(neutral).hits;

/** `next` is acceptable against `base`: fewer through-node hits and no rule with more HARD findings. */
function better(next: Verdict, base: Verdict): boolean {
  if (next.hits.length >= base.hits.length) return false;
  for (const [code, n] of next.hard) if (n > (base.hard.get(code) ?? 0) && code !== "arrow-through-node") return false;
  return true;
}

export interface DetourStats {
  found: number;
  repaired: number;
}

function withRoute(d: D2Diagram, c: D2Connection, pts: Pt[]): D2Diagram {
  const copy = structuredClone(d);
  copy.connections.find((o) => o.id === c.id)!.route = pts.map(([x, y]) => ({ x, y }));
  placeLabels(copy); // labels follow the new route, as in the normal pass
  return copy;
}

/** One repair of `hit`: the first candidate the checker likes better than `base`, as the new diagram. */
function repairOne(d: D2Diagram, base: Verdict, hit: ThroughHit): D2Diagram | undefined {
  const c = d.connections.find((o) => o.id === hit.edge);
  const shape = d.shapes.find((s) => s.id === hit.node);
  if (!c || !shape || c.isCurve === true || c.src === c.dst) return undefined;
  const pts = orthogonal(c.route);
  if (!pts) return undefined;
  const zones = new Set(d.shapes.filter((s) => d.shapes.some((o) => o.id.startsWith(`${s.id}.`))).map((s) => s.id));
  const outline = (id: string): Outline | undefined => {
    const s = d.shapes.find((o) => o.id === id);
    return s ? outlineOf(s, zones.has(id)) : undefined;
  };
  const target = outlineOf(shape, false);
  const seg = deepestSegment(pts, target);
  if (seg.k < 0) return undefined;
  const box: Box = { x: target.x, y: target.y, w: target.w, h: target.h };
  const candidates = detourCandidates(pts, seg.k, box, { src: outline(c.src), dst: outline(c.dst) });
  for (const cand of candidates.slice(0, MAX_TRIES)) {
    const next = withRoute(d, c, cand);
    if (better(judgeDiagram(next), base)) return next;
  }
  return undefined;
}

/**
 * Repairs the arrows of a graph diagram that run through a node (in place), one hit at a time; a hit no candidate fixes
 * without a new HARD finding is left as laid out. Routes that are curves or not orthogonal are never touched.
 */
export function repairThroughNodes(diagram: D2Diagram): DetourStats {
  const stats: DetourStats = { found: 0, repaired: 0 };
  let cur = diagram;
  const given = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < MAX_REPAIRS; i++) {
    const base = judgeDiagram(cur);
    const hit = base.hits.find((h) => !given.has(`${h.edge}|${h.node}`));
    if (!hit) break;
    const key = `${hit.edge}|${hit.node}`;
    if (!seen.has(key)) {
      seen.add(key);
      stats.found++;
    }
    const next = repairOne(cur, base, hit);
    if (next) {
      cur = next;
      stats.repaired++;
    } else given.add(key);
  }
  if (cur !== diagram) {
    diagram.shapes = cur.shapes;
    diagram.connections = cur.connections;
  }
  return stats;
}

// ---- the fixed alternative edge order ----

/** `a.b -> c: "x" {` / `a -- b {` / `a <-> b:`: a qualified path, then an arrow operator (node and container lines have `:` after the path). */
const EDGE_START = /^(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*))* (?:->|<->|--) /;

/**
 * The same D2 source with its edge blocks in the reverse order: the one alternative order render.ts retries with. Only the
 * shape translate.ts writes is touched (edges are `path -> path: label {` ... `}` blocks at the end, after every node and
 * container); undefined for any other source, where edge statements can carry meaning in their position.
 */
export function reorderEdgeBlocks(source: string): string | undefined {
  const lines = source.split("\n");
  const blocks: string[][] = [];
  let head: string[] | undefined;
  let cur: string[] | undefined;
  for (const line of lines) {
    if (cur) {
      cur.push(line);
      if (line === "}") cur = undefined;
    } else if (EDGE_START.test(line) && line.endsWith("{")) {
      head ??= lines.slice(0, lines.indexOf(line));
      cur = [line];
      blocks.push(cur);
    } else if (blocks.length > 0 && line !== "") return undefined; // something else after the first edge
  }
  if (cur || !head || blocks.length < 2) return undefined;
  // `head` was cut at the first occurrence of the first edge line; a duplicate line earlier would cut too soon
  const first = blocks[0]![0]!;
  if (lines.indexOf(first) !== head.length) return undefined;
  return [...head, ...blocks.reverse().flat(), ""].join("\n");
}
