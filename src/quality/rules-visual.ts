// Round 4 "visual" rules: defects a human reviewer sees in the PNG that the plain geometric rules miss
// (arrowheads piled on another arrow's start, labels on crossings, labels hiding their own arrow, stubby
// final segments, elbows grazing a node, tracks too close to tell apart). Pure like the other rule modules:
// analyzeScene() builds the context and calls runVisualRules(ctx); this module only reads it.
//
// SHIPPING POLICY (same as rules-extra.ts): every rule ships SOFT for one iteration and records the severity it
// is meant to get afterwards in plannedSeverity (third tuple entry). VISUAL_RULES_SOFT = false promotes them all
// to their planned severity at once; a rule that should stay SOFT is declared with `fresh("soft", ...)`.
//
// Thresholds in TOL_VISUAL were calibrated against 392 vision-reviewed renders (out/review/all-verdicts.json),
// calibration half = even-indexed cases, held-out half = odd-indexed cases; see the round-4 R1 report.
// Layout round 4 (R4) then raised them to the targets the router now aims for: a final stub of 24 px, 28 px
// between an arrowhead and another arrow's tail, 18 px track pitch, 12 px clearance from node sides and zone borders.

import { buildArrowInfo, type ArrowEnd, type ArrowInfo, type RuleCtx, type RuleDef, type Severity } from "./rules-extra.js";
import {
  pointInRect,
  rectPoly,
  segHitsRect,
  segInsideLength,
  segIntersect,
  segLength,
  shapePoly,
  shrink,
  parallelRun,
  pathLength,
  type Pt,
  type Rect,
} from "./geom.js";

export const VISUAL_RULES_SOFT = true;
const fresh = (planned: Severity, definition: string): RuleDef => [VISUAL_RULES_SOFT ? "soft" : planned, definition, planned];

export const TOL_VISUAL = {
  tailNear: 28, // px between an arrowhead tip and the start point of another arrow on the same node
  headCrossReach: 100, // px: two heads' final segments cross at most this far from both tips
  headCrossWindow: 20, // px of route behind an arrowhead tip that no other arrow may cross
  labelCrossMargin: 6, // px a label box is grown by before testing it for an arrow crossing inside it
  labelForeignMargin: 8, // px a label box is grown by before counting foreign arrows that touch it
  labelForeignMin: 2, // foreign arrows touching the grown label box
  labelCoverFrac: 0.8, // fraction of the label's own route hidden by the label box
  loopRunVisible: 24, // px of a self-loop's outer run that stay visible beside its label (the loop must still read as a loop)
  labelHeadWindow: 24, // px of route behind an arrowhead tip checked for label cover
  labelHeadCover: 0.2, // fraction of that window hidden by the label box
  slack: 0.5, // px: the layout rounds coordinates to 0.1 px, so a measured 27.6 px stands for the 28 px it aimed at
  finalMin: 24, // px: a final segment shorter than this leaves the ~16 px arrowhead no straight run to sit on (the layout's stub is 24)
  sharpAngle: 120, // deg: a last bend that turns by more than this is a hairpin
  sharpWithin: 32, // px: ... when the final segment is shorter than this
  grazeGap: 12, // px between a segment and a foreign node's side or a zone border
  grazeRun: 24, // px a segment runs parallel to that side
  trackGap: 18, // px between parallel segments of different arrows
  trackRun: 40, // px they overlap along their direction
  trackSin: 0.05, // segments are "parallel" below this sine
  // ---- round 5 (R5): what a reviewer sees as a hidden or merged arrowhead, or a label that swallows its edge ----
  headLen: 18, // px of route behind a tip that the arrowhead occupies
  headHalfWidth: 8, // px: half the width of the arrowhead's wings
  headCover: 0.2, // share of the head footprint another arrow's label box may hide
  headPitch: 28, // px between the tips of two arrowheads on one node
  labelDominates: 0.6, // share of its own (short) route a label box may hide
  endDist: 6, // px: collinear segments of two arrows this close (perpendicular) ...
  endGap: 10, // px: ... that touch, overlap or lie this close along their direction read as one line
  hugGap: 12, // px between an arrow's run and the side of one of its own nodes
  hugRun: 24, // px it runs along that side
  // ---- label stagger: two weight labels side by side cannot be told apart ----
  labelSideX: 24, // px: boxes of two edge labels closer than this horizontally ...
  labelSideY: 40, // px: ... and closer than this vertically (touching counts as 0) read as one cluster
};

export const VISUAL_RULES: Record<string, RuleDef> = {
  "arrowhead-near-tail": fresh("soft", "an arrowhead tip lies within 28 px of the start (tail) point of another arrow on the same node"),
  "arrowheads-cross": fresh("soft", "two arrowheads on one node have final segments that cross within 100 px of both tips (an X of heads), or another arrow crosses the 20 px of route behind an arrowhead tip"),
  "label-at-crossing": fresh("soft", "an edge label box (grown 6 px) contains a crossing of two arrows, or is touched (grown 8 px) by 2 or more foreign arrows"),
  "label-covers-own-arrow": fresh("soft", "an edge label box hides more than 80% of its own arrow's route, or more than 20% of the 24 px of route behind an arrowhead, or (self-loop) leaves less than 24 px of the loop's outer run visible"),
  "short-final-segment": fresh("soft", "an arrowhead's final segment is shorter than 24 px, or the last bend turns by more than 120 degrees within 32 px of the tip"),
  "node-edge-graze": fresh("soft", "an arrow segment runs parallel to, and within 8 px of, the side of a node that is not one of its ends for 24 px or more"),
  "track-spacing": fresh("soft", "parallel segments of different arrows are closer than 18 px over 40 px or more (tracks that cannot be told apart)"),
  "arrowhead-covered": fresh("soft", "an arrowhead's footprint (18 px behind the tip, 16 px wide) is more than 20% under an edge label box, or another arrow's segment runs through it"),
  "arrowheads-close": fresh("soft", "the tips of two arrowheads on one node are closer than 28 px (heads that overlap or touch)"),
  "arrows-end-to-end": fresh("soft", "segments of two different arrows are collinear (within 6 px) and touch, overlap or lie within 10 px of each other along their direction (they read as one line)"),
  "arrow-hugs-own-node": fresh("soft", "an arrow runs parallel to, and within 12 px of, the side of one of its own nodes for 24 px or more (it leaves one side and hugs the node to enter from another, like a self-loop)"),
  "label-dominates-edge": fresh("soft", "an edge label box hides more than 60% of its own arrow's route"),
  "labels-side-by-side": fresh("soft", "boxes of two labels of different arrows are within 24 px horizontally and within 40 px vertically of each other without overlapping (the reader cannot tell which arrow each belongs to)"),
};

const r1 = (n: number): number => Math.round(n * 10) / 10;
const dist = (p: Pt, q: Pt): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** The last non-degenerate segment of the path as [far, tip] (the tip is the end/start point being tested). */
function finalSegment(pts: Pt[], atEnd: boolean): [Pt, Pt] | null {
  const n = pts.length;
  for (let k = 1; k < n; k++) {
    const tip = atEnd ? pts[n - k]! : pts[k - 1]!;
    const far = atEnd ? pts[n - 1 - k]! : pts[k]!;
    if (segLength(tip, far) >= 1e-6) return [far, tip];
  }
  return null;
}

/** The route within `len` px of the tip, as a polyline starting at the tip. */
function routeNearTip(pts: Pt[], atEnd: boolean, len: number): Pt[] {
  const seq = atEnd ? [...pts].reverse() : pts;
  const out: Pt[] = [seq[0]!];
  let left = len;
  for (let i = 1; i < seq.length && left > 0; i++) {
    const a = seq[i - 1]!;
    const b = seq[i]!;
    const l = segLength(a, b);
    if (l <= left) {
      out.push(b);
      left -= l;
    } else {
      out.push([a[0] + ((b[0] - a[0]) * left) / l, a[1] + ((b[1] - a[1]) * left) / l]);
      left = 0;
    }
  }
  return out;
}

/** Proper crossing of a-b with c-d that is neither within 3 px of the tip nor at an end point of the other route. */
function segCrossAt(a: Pt, b: Pt, c: Pt, d: Pt, tip: Pt, other: Pt[]): boolean {
  const x = segIntersect(a, b, c, d);
  if (!x || dist(x.point, tip) < 3) return false;
  return dist(x.point, other[0]!) >= 3 && dist(x.point, other[other.length - 1]!) >= 3;
}

const insideRect = (pts: Pt[], r: Rect): number => {
  const poly = rectPoly(r);
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += segInsideLength(pts[i - 1]!, pts[i]!, poly);
  return n;
};

/** Angle in degrees by which the path turns at its last bend before the tip (0 = straight on), null without a bend. */
function lastTurn(pts: Pt[], atEnd: boolean): number | null {
  const seq = (atEnd ? [...pts].reverse() : pts).filter((p, i, a) => i === 0 || segLength(p, a[i - 1]!) >= 1e-6);
  if (seq.length < 3) return null;
  const [t, a, b] = [seq[0]!, seq[1]!, seq[2]!]; // tip, bend, the point before the bend
  const d1: Pt = [t[0] - a[0], t[1] - a[1]]; // final segment, travelling into the tip
  const d2: Pt = [a[0] - b[0], a[1] - b[1]]; // the segment before it
  const dot = (d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(...d1) * Math.hypot(...d2));
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

export function runVisualRules(ctx: RuleCtx): void {
  const { arrows, labels, partsByNode, nodeKey, add } = ctx;
  const T = TOL_VISUAL;
  const infos: ArrowInfo[] = buildArrowInfo(arrows, nodeKey);
  const infoById = new Map(infos.map((i) => [i.a.id, i]));

  // ---- arrowhead-near-tail ----
  const endsByNode = new Map<string, Array<{ info: ArrowInfo; e: ArrowEnd }>>();
  for (const info of infos) {
    for (const e of info.ends) {
      if (!e.key) continue;
      if (!endsByNode.has(e.key)) endsByNode.set(e.key, []);
      endsByNode.get(e.key)!.push({ info, e });
    }
  }
  for (const [key, list] of endsByNode) {
    const near = new Map<string, string>();
    const cross = new Map<string, string>();
    for (const p of list) {
      if (!p.e.head) continue;
      for (const q of list) {
        if (q.info === p.info) continue;
        const pair = [p.info.a.id, q.info.a.id].sort().join("|");
        if (!q.e.head) {
          const d = dist(p.e.pt, q.e.pt);
          if (d < T.tailNear - T.slack) near.set(pair, `${p.info.a.id} arrowhead is ${r1(d)} px from the start of ${q.info.a.id}`);
        } else if (p.info.a.id < q.info.a.id) {
          const sp = finalSegment(p.info.pts, p.e.atEnd);
          const sq = finalSegment(q.info.pts, q.e.atEnd);
          const x = sp && sq ? segIntersect(sp[0], sp[1], sq[0], sq[1]) : null;
          if (x && dist(x.point, p.e.pt) >= 3 && dist(x.point, q.e.pt) >= 3 && Math.max(dist(x.point, p.e.pt), dist(x.point, q.e.pt)) <= T.headCrossReach) {
            cross.set(pair, `arrowheads of ${p.info.a.id} and ${q.info.a.id} cross in an X`);
          }
        }
      }
    }
    for (const [pair, detail] of near) add("arrowhead-near-tail", pair.split("|"), `${detail} on node ${key}`);
    for (const [pair, detail] of cross) add("arrowheads-cross", pair.split("|"), `${detail} on node ${key}`);
  }
  // ... and any arrow crossing the stretch of route right behind an arrowhead tip (head and arrow read as one blob)
  for (const p of infos) {
    for (const e of p.ends) {
      if (!e.head) continue;
      const win = routeNearTip(p.pts, e.atEnd, T.headCrossWindow);
      const hit = infos.find((q) => q !== p && win.some((w, k) => k > 0 && q.pts.some((v, m) => m > 0 && segCrossAt(win[k - 1]!, w, q.pts[m - 1]!, v, e.pt, q.pts))));
      if (hit) add("arrowheads-cross", [p.a.id, hit.a.id], `${hit.a.id} crosses the ${T.headCrossWindow} px behind the ${e.end} arrowhead of ${p.a.id}`);
    }
  }

  // ---- label-at-crossing and label-covers-own-arrow ----
  const crossings: Pt[] = [];
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const A = infos[i]!;
      const B = infos[j]!;
      for (let x = 1; x < A.pts.length; x++) {
        for (let y = 1; y < B.pts.length; y++) {
          const hit = segIntersect(A.pts[x - 1]!, A.pts[x]!, B.pts[y - 1]!, B.pts[y]!);
          if (!hit) continue;
          const ends = [A.pts[0]!, A.pts[A.pts.length - 1]!, B.pts[0]!, B.pts[B.pts.length - 1]!];
          if (!ends.some((p) => dist(p, hit.point) < 3)) crossings.push(hit.point);
        }
      }
    }
  }
  for (const l of labels.filter((x) => x.kind === "edge")) {
    const own = l.owner && infoById.get(l.owner.id);
    if (!own) continue;
    const crossBox = shrink(l.rect, -T.labelCrossMargin);
    const nx = crossings.filter((c) => pointInRect(c, crossBox)).length;
    const foreignBox = shrink(l.rect, -T.labelForeignMargin);
    const foreign = infos.filter((i) => i !== own && i.pts.some((p, k) => (k > 0 ? segHitsRect(i.pts[k - 1]!, p, foreignBox) : false)));
    if (nx > 0 || foreign.length >= T.labelForeignMin) {
      add("label-at-crossing", [l.id, own.a.id, ...foreign.map((f) => f.a.id)], `edge label "${l.el.text}" sits on ${nx} crossing(s) and touches ${foreign.length} foreign arrow(s)`);
    }
    const total = pathLength(own.pts);
    const cover = total > 0 ? insideRect(own.pts, l.rect) / total : 0;
    let why = cover > T.labelCoverFrac ? `hides ${Math.round(cover * 100)}% of its arrow` : "";
    if (!why && own.loop && own.pts.length >= 4) {
      // a self-loop's label should sit beside its outer run, not hide the loop down to two stubs
      const run: Pt[] = [own.pts[1]!, own.pts[2]!];
      const runLen = pathLength(run);
      const visible = runLen - insideRect(run, l.rect);
      if (visible < T.loopRunVisible) why = `leaves only ${r1(visible)} px of the outer run of its self-loop visible`;
    }
    for (const e of own.ends) {
      if (!e.head || why) continue;
      const win = Math.min(T.labelHeadWindow, total);
      const tip = routeNearTip(own.pts, e.atEnd, win);
      const frac = win > 0 ? insideRect(tip, l.rect) / win : 0;
      if (frac > T.labelHeadCover) why = `hides ${Math.round(frac * 100)}% of the ${r1(win)} px behind the ${e.end} arrowhead`;
    }
    if (why) add("label-covers-own-arrow", [l.id, own.a.id], `edge label "${l.el.text}" ${why}`);
  }

  // ---- R5: arrowhead-covered, arrowheads-close, label-dominates-edge ----
  const footprint = (pts: Pt[], atEnd: boolean): Rect | null => {
    const seg = finalSegment(pts, atEnd);
    if (!seg) return null;
    const [far, tip] = seg;
    const l = segLength(far, tip);
    const ux = (far[0] - tip[0]) / l;
    const uy = (far[1] - tip[1]) / l;
    const back: Pt = [tip[0] + ux * T.headLen, tip[1] + uy * T.headLen];
    const hw = T.headHalfWidth;
    // axis-aligned box around the head (routes are orthogonal almost everywhere; a slanted head gets a slightly roomy box)
    return { x1: Math.min(tip[0], back[0]) - (Math.abs(uy) > 0.5 ? hw : 0), x2: Math.max(tip[0], back[0]) + (Math.abs(uy) > 0.5 ? hw : 0), y1: Math.min(tip[1], back[1]) - (Math.abs(ux) > 0.5 ? hw : 0), y2: Math.max(tip[1], back[1]) + (Math.abs(ux) > 0.5 ? hw : 0) };
  };
  const overlapArea = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const heads: Array<{ info: ArrowInfo; e: ArrowEnd; box: Rect }> = [];
  for (const info of infos) {
    for (const e of info.ends) {
      if (!e.head) continue;
      const box = footprint(info.pts, e.atEnd);
      if (box) heads.push({ info, e, box });
    }
  }
  for (const h of heads) {
    const area = (h.box.x2 - h.box.x1) * (h.box.y2 - h.box.y1);
    let why = "";
    for (const l of labels) {
      if (l.kind !== "edge") continue;
      if (area > 0 && overlapArea(h.box, l.rect) / area > T.headCover) why = `edge label "${l.el.text}" hides the ${h.e.end} arrowhead of ${h.info.a.id}`;
      if (why) break;
    }
    if (!why) {
      const inner = shrink(h.box, 2.5);
      if (inner.x2 > inner.x1 && inner.y2 > inner.y1) {
        const hit = infos.find((q) => q !== h.info && q.pts.some((v, m) => m > 0 && segHitsRect(q.pts[m - 1]!, v, inner)));
        if (hit) why = `${hit.a.id} runs through the ${h.e.end} arrowhead of ${h.info.a.id}`;
      }
    }
    if (why) add("arrowhead-covered", [h.info.a.id], why);
  }
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const p = heads[i]!;
      const q = heads[j]!;
      if (p.info === q.info || !p.e.key || p.e.key !== q.e.key) continue;
      const d = dist(p.e.pt, q.e.pt);
      if (d < T.headPitch - T.slack) add("arrowheads-close", [p.info.a.id, q.info.a.id], `arrowheads of ${p.info.a.id} and ${q.info.a.id} are ${r1(d)} px apart on node ${p.e.key}`);
    }
  }
  for (const l of labels.filter((x) => x.kind === "edge")) {
    const own = l.owner && infoById.get(l.owner.id);
    if (!own || own.loop) continue;
    const total = pathLength(own.pts);
    const cover = total > 0 ? insideRect(own.pts, l.rect) / total : 0;
    if (cover > T.labelDominates) add("label-dominates-edge", [l.id, own.a.id], `edge label "${l.el.text}" hides ${Math.round(cover * 100)}% of its arrow`);
  }

  // ---- labels-side-by-side ----
  const edgeLabels = labels.filter((x) => x.kind === "edge" && x.owner);
  for (let i = 0; i < edgeLabels.length; i++) {
    for (let j = i + 1; j < edgeLabels.length; j++) {
      const a = edgeLabels[i]!;
      const b = edgeLabels[j]!;
      if (a.owner!.id === b.owner!.id) continue;
      const gx = Math.max(a.rect.x1 - b.rect.x2, b.rect.x1 - a.rect.x2, 0);
      const gy = Math.max(a.rect.y1 - b.rect.y2, b.rect.y1 - a.rect.y2, 0);
      if (gx === 0 && gy === 0) continue; // overlapping labels are label-label-overlap's business
      if (gx <= T.labelSideX && gy <= T.labelSideY) add("labels-side-by-side", [a.id, b.id], `edge labels "${a.el.text}" and "${b.el.text}" sit ${r1(gx)} px apart horizontally and ${r1(gy)} px vertically`);
    }
  }

  // ---- short-final-segment ----
  for (const info of infos) {
    for (const e of info.ends) {
      if (!e.head) continue;
      const seg = finalSegment(info.pts, e.atEnd);
      if (!seg) continue;
      const len = segLength(seg[0], seg[1]);
      const turn = lastTurn(info.pts, e.atEnd);
      if (len < T.finalMin - T.slack) add("short-final-segment", [info.a.id], `${info.a.id} ${e.end} arrowhead sits on a ${r1(len)} px final segment`);
      else if (turn !== null && turn > T.sharpAngle && len < T.sharpWithin) add("short-final-segment", [info.a.id], `${info.a.id} ${e.end} arrowhead follows a ${Math.round(turn)} degree bend ${r1(len)} px before the tip`);
    }
  }

  // ---- node-edge-graze ----
  for (const info of infos) {
    const own = new Set(info.ends.map((e) => e.key));
    for (const [key, parts] of partsByNode) {
      if (own.has(key)) continue;
      let best: { dist: number; run: number } | null = null;
      for (const part of parts) {
        if (part.type === "ellipse") continue; // no straight side to run along
        const poly = shapePoly(part);
        for (let x = 1; x < info.pts.length; x++) {
          for (let i = 0; i < poly.length; i++) {
            const r = parallelRun(info.pts[x - 1]!, info.pts[x]!, poly[i]!, poly[(i + 1) % poly.length]!, 0.05, T.grazeRun);
            if (r && r.dist < T.grazeGap - T.slack && (!best || r.dist < best.dist)) best = r;
          }
        }
      }
      if (best) add("node-edge-graze", [info.a.id, parts[0]!.id], `${info.a.id} runs ${r1(best.run)} px along node ${key} at ${r1(best.dist)} px`);
    }
    for (const z of ctx.zones) {
      const poly = rectPoly({ x1: z.x, y1: z.y, x2: z.x + z.width, y2: z.y + z.height });
      let best: { dist: number; run: number } | null = null;
      for (let x = 1; x < info.pts.length; x++) {
        for (let i = 0; i < poly.length; i++) {
          const r = parallelRun(info.pts[x - 1]!, info.pts[x]!, poly[i]!, poly[(i + 1) % poly.length]!, 0.05, T.grazeRun);
          if (r && r.dist < T.grazeGap - T.slack && (!best || r.dist < best.dist)) best = r;
        }
      }
      if (best) add("node-edge-graze", [info.a.id, z.id], `${info.a.id} runs ${r1(best.run)} px along the border of zone ${z.id} at ${r1(best.dist)} px`);
    }
  }

  // ---- arrow-hugs-own-node (R5): a run along the side of one of the arrow's own nodes reads like a self-loop ----
  for (const info of infos) {
    if (info.loop) continue;
    for (const key of new Set(info.ends.map((e) => e.key))) {
      if (!key) continue;
      let best: { dist: number; run: number } | null = null;
      for (const part of partsByNode.get(key) ?? []) {
        if (part.type === "ellipse") continue;
        const poly = shapePoly(part);
        for (let x = 1; x < info.pts.length; x++) {
          for (let i = 0; i < poly.length; i++) {
            const r = parallelRun(info.pts[x - 1]!, info.pts[x]!, poly[i]!, poly[(i + 1) % poly.length]!, 0.05, T.hugRun);
            if (r && r.dist < T.hugGap - T.slack && (!best || r.dist < best.dist)) best = r;
          }
        }
      }
      if (best) add("arrow-hugs-own-node", [info.a.id], `${info.a.id} runs ${r1(best.run)} px along its own node ${key} at ${r1(best.dist)} px`);
    }
  }

  // ---- arrows-end-to-end (R5): collinear segments of different arrows that touch read as one arrow ----
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const A = infos[i]!;
      const B = infos[j]!;
      let best: { dist: number; run: number } | null = null;
      for (let x = 1; x < A.pts.length; x++) {
        for (let y = 1; y < B.pts.length; y++) {
          const r = parallelRun(A.pts[x - 1]!, A.pts[x]!, B.pts[y - 1]!, B.pts[y]!, T.trackSin, -T.endGap);
          if (r && r.dist < T.endDist - T.slack && (!best || r.dist < best.dist)) best = r;
        }
      }
      if (best) add("arrows-end-to-end", [A.a.id, B.a.id], `${A.a.id} and ${B.a.id} run on one line (${r1(best.dist)} px apart, ${best.run >= 0 ? `overlap ${r1(best.run)}` : `gap ${r1(-best.run)}`} px)`);
    }
  }

  // ---- track-spacing ----
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const A = infos[i]!;
      const B = infos[j]!;
      let best: { dist: number; run: number } | null = null;
      for (let x = 1; x < A.pts.length; x++) {
        for (let y = 1; y < B.pts.length; y++) {
          const r = parallelRun(A.pts[x - 1]!, A.pts[x]!, B.pts[y - 1]!, B.pts[y]!, T.trackSin, T.trackRun);
          if (r && r.dist < T.trackGap - T.slack && (!best || r.dist < best.dist)) best = r;
        }
      }
      if (best) add("track-spacing", [A.a.id, B.a.id], `${A.a.id} and ${B.a.id} run ${r1(best.dist)} px apart over ${r1(best.run)} px`);
    }
  }
}
