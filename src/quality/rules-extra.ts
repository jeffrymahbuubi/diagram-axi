// Quality stage 2 rules (docs/plans/2026-10-23-qa-edge-cases-fuzz-plan.md section 6). Typed port of
// scripts/qa/rules-extra.mjs, shipped in dist/quality. Split from analyze.ts to keep
// both files small. analyzeScene() builds a context and calls runExtraRules(ctx); this module only reads it.
//
// SHIPPING POLICY: every rule here ships SOFT in this iteration and records the severity it will get after
// the false-positive review in plannedSeverity (third tuple entry). To promote: change a rule's `fresh(...)`
// entry to a plain ["hard", definition, "hard"], or flip NEW_RULES_SOFT to false to promote them all at once.

import {
  arrivalDirection,
  arrowPoints,
  insideDepth,
  outwardNormalsAt,
  parallelRun,
  polyBoundaryDist,
  polylineDist,
  polylineRectDist,
  rectInside,
  rectOf,
  rectOverlapDepth,
  rectPointDist,
  segHitsRect,
  segLength,
  shapePoly,
  shrink,
  type Pt,
  type Rect,
  type SceneElement,
} from "./geom.js";

export type Severity = "hard" | "soft";
/** [severity, definition, plannedSeverity?] */
export type RuleDef = [Severity, string, Severity?];

/** An edge/node/zone/title text with the box Excalidraw actually draws (built by analyzeScene). */
export interface Label {
  id: string;
  kind: string;
  owner: SceneElement | undefined;
  center: Pt | null;
  el: SceneElement;
  rect: Rect;
  stored: Rect;
}

export interface RuleCtx {
  els: SceneElement[];
  byId: Map<string, SceneElement>;
  arrows: SceneElement[];
  labels: Label[];
  zones: SceneElement[];
  partsByNode: Map<string, SceneElement[]>;
  nodeKey: (id: string) => string;
  add: (code: string, elements: string[], detail: string) => void;
}

export interface ArrowInfo {
  a: SceneElement;
  pts: Pt[];
  ends: ArrowEnd[];
  loop: boolean;
  pair: string;
}

export interface ArrowEnd {
  end: "start" | "end";
  pt: Pt;
  head: boolean;
  key: string | null;
  atEnd: boolean;
}

export const NEW_RULES_SOFT = false;
const fresh = (planned: Severity, definition: string): RuleDef => [NEW_RULES_SOFT ? "soft" : planned, definition, planned];

export const TOL_EXTRA = {
  arrowheadInside: 3, // px an arrowhead tip may sink into its node
  wrongSideCos: 0.2, // cos of the angle between the node's outward normal and the arrival direction
  labelFar: 2, // px between a label's drawn center and its own arrow
  labelFarExact: 16, // px between an exactly placed label's BOX and its own route (ELK/D2 put labels beside the route)
  labelZone: 1,
  titleCrossed: 1, // zone-title box is shrunk by this before the segment test
  collinearSin: 0.05, // segments are "parallel" below this sine
  collinearDist: 10, // px between the two tracks (plan: 4; the layout lane pitch is ~8.4, so 4 or 8 would miss every hugging fan-in)
  collinearRun: 24, // px they must overlap along their direction
  nearArrowhead: 6, // px between an edge label box and its own arrowhead tip
  loopInside: 2, // px a self-loop point may sink into its node
  loopMinPoints: 3,
  loopReach: 20, // a loop must stick out at least this far from its node
  loopChord: 16, // start and arrowhead tip of a loop must be at least this far apart
  degenerate: 2, // shortest acceptable arrow segment
  crowded: 18, // one arrowhead is ~16 px wide, so ends closer than this overlap (proposal was 12)
  crowdedMargin: 6, // neutral-geometry engines: limit = the engine's arrowhead breadth (arrow.arrowheadWidth) + this
};

export const NEW_RULES: Record<string, RuleDef> = {
  "arrowhead-inside-node": fresh("hard", "an arrowhead tip lies more than 3 px inside its bound node's polygon (hidden by the fill; cylinders test body and cap)"),
  "arrow-end-on-wrong-side": fresh("soft", "an arrow end touches its bound node while travelling outward through that side (the path approaches the node from behind)"),
  "label-far-from-arrow": fresh("hard", "an edge label's drawn center is more than 2 px from its own arrow's polyline, or no center can be derived (arrow without a segment, labelPosition outside 0..1); a label placed exactly (D2, Mermaid) may sit beside its route and fails when its box is more than 16 px from it"),
  "label-outside-zone": fresh("hard", "an edge label whose arrow has both ends in zone Z is drawn outside Z, or an edge label overlaps a zone by more than 1 px that neither end of its arrow belongs to"),
  "zone-title-crossed": fresh("hard", "an arrow segment crosses a zone title text box (shrunk 1 px)"),
  "arrows-collinear-overlap": fresh("hard", "segments of arrows of different node pairs are parallel (sin < 0.05), less than 10 px apart and overlap by 24 px or more along their direction (drawn on top of each other)"),
  "label-outside-canvas": fresh("soft", "a text (title excepted) or arrow point has x < 0 or y < 0, or an edge label is drawn outside the bounds Excalidraw exports from the stored elements"),
  "label-near-arrowhead": fresh("soft", "an edge label box is within 6 px of the arrowhead tip of its own arrow"),
  "self-loop-shape": fresh("hard", "a self-loop has fewer than 3 points, a point deeper than 2 px inside its node, reaches less than 20 px out of the node, or its start and arrowhead tip are closer than 16 px"),
  "degenerate-segment": fresh("soft", "an arrow has a segment shorter than 2 px (stacked vertices)"),
  "checker-id-collision": fresh("hard", "two scene elements share the same id, so bindings and node keys are ambiguous"),
  "arrowheads-crowded": fresh("hard", "distinct arrow ends on the same node, at least one with an arrowhead, are closer than 18 px (neutral-geometry engines: closer than the engine's arrowhead breadth + 6 px, D2 12 -> 18, Mermaid 8 -> 14)"),
};

/** One record per arrow: points, per-end {pt, head, bound node key}, self-loop flag, unordered node-pair token. */
export function buildArrowInfo(arrows: SceneElement[], nodeKey: (id: string) => string): ArrowInfo[] {
  const keyOf = (b: SceneElement["startBinding"]): string | null => (b?.elementId ? nodeKey(b.elementId) : null);
  return arrows.map((a) => {
    const pts = arrowPoints(a);
    const ends = [
      { end: "start", pt: pts[0], head: Boolean(a.startArrowhead), key: keyOf(a.startBinding), atEnd: false },
      { end: "end", pt: pts[pts.length - 1], head: Boolean(a.endArrowhead), key: keyOf(a.endBinding), atEnd: true },
    ].filter((e) => e.pt) as ArrowEnd[];
    const [s, e] = [keyOf(a.startBinding), keyOf(a.endBinding)];
    // unordered bound node pair; arrows with an unbound end get a unique token
    return { a, pts, ends, loop: Boolean(s) && s === e, pair: s && e ? [s, e].sort().join("") : `#${a.id}` };
  });
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** ctx as built by analyzeScene. */
export function runExtraRules(ctx: RuleCtx): void {
  const { els, byId, arrows, labels, zones, partsByNode, nodeKey, add } = ctx;
  const T = TOL_EXTRA;
  const polysOf = (key: string, inset = 0) => (partsByNode.get(key) ?? []).map((p) => shapePoly(p, inset));

  // One record per arrow end: where it is, whether it carries a head, which node it is bound to.
  const arrowInfo = buildArrowInfo(arrows, nodeKey);

  // checker-id-collision
  const seen = new Map();
  for (const e of els) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) add("checker-id-collision", [id], `${n} scene elements share the id ${id}`);

  for (const { a, pts, ends } of arrowInfo) {
    // arrowhead-inside-node and arrow-end-on-wrong-side
    for (const e of ends) {
      if (!e.key || !partsByNode.has(e.key)) continue;
      const polys = polysOf(e.key);
      if (e.head) {
        const depth = Math.max(...polys.map((p) => insideDepth(e.pt, p)));
        if (depth > T.arrowheadInside) add("arrowhead-inside-node", [a.id, `node-${e.key}`], `${a.id} ${e.end} arrowhead is ${r1(depth)} px inside node ${e.key}`);
      }
      const dir = arrivalDirection(pts, e.atEnd);
      if (!dir) continue;
      const nearest = polys.reduce((best, p) => (polyBoundaryDist(e.pt, p) < polyBoundaryDist(e.pt, best) ? p : best));
      if (polyBoundaryDist(e.pt, nearest) > 10) continue; // detached: reported by arrow-detached
      const normals = outwardNormalsAt(e.pt, nearest);
      if (normals.every((n) => n[0] * dir[0] + n[1] * dir[1] > T.wrongSideCos)) {
        add("arrow-end-on-wrong-side", [a.id, `node-${e.key}`], `${a.id} ${e.end} meets node ${e.key} while travelling outward through that side`);
      }
    }

    // degenerate-segment
    let tiny = 0;
    for (let i = 1; i < pts.length; i++) if (segLength(pts[i - 1]!, pts[i]!) < T.degenerate) tiny++;
    if (tiny) add("degenerate-segment", [a.id], `${a.id} has ${tiny} segment(s) shorter than ${T.degenerate} px`);
  }

  // self-loop-shape
  for (const { a, pts, ends } of arrowInfo) {
    const [s, e] = [ends[0], ends[ends.length - 1]];
    if (!s?.key || s.key !== e?.key || ends.length < 2 || !partsByNode.has(s.key)) continue;
    const inner = polysOf(s.key, T.loopInside);
    const outline = polysOf(s.key);
    const problems = [];
    if (pts.length < T.loopMinPoints) problems.push(`only ${pts.length} point(s)`);
    const sunk = Math.max(...pts.map((p) => Math.max(...inner.map((q) => insideDepth(p, q)))));
    if (sunk > 0) problems.push(`a point lies ${r1(sunk)} px inside the node`);
    const reach = Math.max(...pts.map((p) => (outline.some((q) => insideDepth(p, q) > 0) ? 0 : Math.min(...outline.map((q) => polyBoundaryDist(p, q))))));
    if (reach < T.loopReach) problems.push(`it reaches only ${r1(reach)} px out of the node`);
    const chord = segLength(pts[0]!, pts[pts.length - 1]!);
    if (chord < T.loopChord) problems.push(`start and end are ${r1(chord)} px apart`);
    if (problems.length) add("self-loop-shape", [a.id, `node-${s.key}`], `${a.id}: ${problems.join("; ")}`);
  }

  // arrows-collinear-overlap: different node pairs only (same pairs are parallel-edges-close)
  for (let i = 0; i < arrowInfo.length; i++) {
    for (let j = i + 1; j < arrowInfo.length; j++) {
      const A = arrowInfo[i]!;
      const B = arrowInfo[j]!;
      if (A.pair === B.pair && !A.loop) continue;
      let best: { dist: number; run: number } | null = null;
      for (let x = 1; x < A.pts.length; x++) {
        for (let y = 1; y < B.pts.length; y++) {
          const r = parallelRun(A.pts[x - 1]!, A.pts[x]!, B.pts[y - 1]!, B.pts[y]!, T.collinearSin, T.collinearRun);
          if (r && r.dist < T.collinearDist && (!best || r.dist < best.dist || (r.dist === best.dist && r.run > best.run))) best = r;
        }
      }
      if (best) add("arrows-collinear-overlap", [A.a.id, B.a.id], `${A.a.id} and ${B.a.id} (different node pairs) share a track ${r1(best.dist)} px apart over ${r1(best.run)} px`);
    }
  }

  // arrowheads-crowded: one finding per node
  const byNode = new Map();
  for (const { a, ends } of arrowInfo) {
    for (const e of ends) {
      if (!e.key) continue;
      if (!byNode.has(e.key)) byNode.set(e.key, []);
      byNode.get(e.key).push({ id: a.id, ...e });
    }
  }
  for (const [key, list] of byNode) {
    const hit = new Set<string>();
    let closest = Infinity;
    let limitUsed = T.crowded;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        if (p.id === q.id || !(p.head || q.head)) continue;
        const d = Math.hypot(p.pt[0] - q.pt[0], p.pt[1] - q.pt[1]);
        // the limit follows the heads actually drawn: Excalidraw ~16 px, a neutral-geometry engine its own breadth
        const widths = [p, q].filter((e) => e.head).map((e) => byId.get(e.id)?.arrowheadWidth);
        const limit = widths.every((w) => typeof w === "number") ? Math.max(...(widths as number[])) + T.crowdedMargin : T.crowded;
        if (d < limit) {
          hit.add(p.id).add(q.id);
          closest = Math.min(closest, d);
          limitUsed = limit;
        }
      }
    }
    if (hit.size) add("arrowheads-crowded", [...hit], `${hit.size} arrows end on node ${key} within ${limitUsed} px of each other (closest ${r1(closest)} px)`);
  }

  // ---- label rules ----
  const gidsOf = (key: string | null) => new Set((partsByNode.get(key!) ?? []).flatMap((p) => p.groupIds ?? []));
  const zoneTitles = labels.filter((l) => l.kind === "zone");
  const stored = els.filter((e) => e.type !== "arrow").map((e) => rectOf(e.x, e.y, e.width, e.height));
  for (const { pts } of arrowInfo) for (const p of pts) stored.push({ x1: p[0], y1: p[1], x2: p[0], y2: p[1] });
  const exportBox = stored.length
    ? { x1: Math.min(...stored.map((r) => r.x1)), y1: Math.min(...stored.map((r) => r.y1)), x2: Math.max(...stored.map((r) => r.x2)), y2: Math.max(...stored.map((r) => r.y2)) }
    : null;

  for (const l of labels.filter((x) => x.kind === "edge")) {
    const info = arrowInfo.find((i) => i.a.id === l.owner!.id)!;
    const { pts, ends } = info;

    // label-far-from-arrow
    const lp = l.el.labelPosition;
    const distinct = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) > 0);
    if (distinct.length < 2 || !l.center) {
      add("label-far-from-arrow", [l.id, l.owner!.id], `edge label "${l.el.text}" has no arrow segment to sit on`);
    } else if (l.el.exactPlacement) {
      const d = polylineRectDist(pts, l.rect);
      if (d > T.labelFarExact) add("label-far-from-arrow", [l.id, l.owner!.id], `edge label "${l.el.text}" is drawn ${r1(d)} px from its arrow`);
    } else if (Number.isFinite(lp) && (lp! < 0 || lp! > 1)) {
      add("label-far-from-arrow", [l.id, l.owner!.id], `edge label "${l.el.text}" has labelPosition ${lp} outside 0..1`);
    } else {
      const d = polylineDist(l.center, pts);
      if (d > T.labelFar) add("label-far-from-arrow", [l.id, l.owner!.id], `edge label "${l.el.text}" is drawn ${r1(d)} px from its arrow`);
    }

    // label-near-arrowhead
    for (const e of ends) {
      const d = e.head ? rectPointDist(l.rect, e.pt) : Infinity;
      if (d < T.nearArrowhead) add("label-near-arrowhead", [l.id, l.owner!.id], `edge label "${l.el.text}" is ${r1(d)} px from the ${e.end} arrowhead of ${l.owner!.id}`);
    }

    // label-outside-zone
    const keys = ends.map((e) => e.key);
    if (ends.length === 2 && keys.every(Boolean)) {
      const mine = keys.map(gidsOf);
      for (const z of zones) {
        const gid = z.groupIds?.[0];
        if (!gid) continue;
        const zr = rectOf(z.x, z.y, z.width, z.height);
        const both = mine.every((g) => g.has(gid));
        const either = mine.some((g) => g.has(gid));
        if (both && !rectInside(l.rect, zr, T.labelZone)) add("label-outside-zone", [l.id, z.id], `edge label "${l.el.text}" joins two members of ${z.id} but is drawn outside it`);
        else if (!either && rectOverlapDepth(l.rect, zr) > T.labelZone) add("label-outside-zone", [l.id, z.id], `edge label "${l.el.text}" sits inside ${z.id}, which neither end of ${l.owner!.id} belongs to`);
      }
    }

    // label-outside-canvas (export bounds)
    if (exportBox && !rectInside(l.rect, exportBox, 1)) add("label-outside-canvas", [l.id], `edge label "${l.el.text}" is drawn outside the exported canvas bounds`);
  }

  // zone-title-crossed
  for (const t of zoneTitles) {
    const probe = shrink(t.rect, T.titleCrossed);
    for (const { a, pts } of arrowInfo) {
      let hits = 0;
      for (let i = 1; i < pts.length; i++) if (segHitsRect(pts[i - 1]!, pts[i]!, probe)) hits++;
      if (hits) add("zone-title-crossed", [t.id, a.id], `${a.id} crosses the zone title "${t.el.text}" with ${hits} segment(s)`);
    }
  }

  // label-outside-canvas (negative coordinates; the diagram title legitimately sits above y = 0)
  for (const l of labels.filter((x) => x.kind !== "title")) {
    if (l.rect.x1 < 0 || l.rect.y1 < 0) add("label-outside-canvas", [l.id], `${l.kind} label "${l.el.text}" starts at ${r1(l.rect.x1)},${r1(l.rect.y1)}`);
  }
  for (const { a, pts } of arrowInfo) {
    const bad = pts.find((p) => p[0] < 0 || p[1] < 0);
    if (bad) add("label-outside-canvas", [a.id], `${a.id} has a point at ${r1(bad[0])},${r1(bad[1])}`);
  }
}
