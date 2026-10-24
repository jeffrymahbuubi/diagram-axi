// Geometric layout analysis of a produced .excalidraw scene. Pure: scene object in, findings out.
// Typed port of scripts/qa/analyze.mjs (same behaviour); scripts/qa/analyze.mjs re-exports dist/quality/analyze.js.
//
// HARD findings are defects (the QA run fails on any); SOFT findings are quality signals (reported only).
// See RULES below for the definition of every code. Results are sorted, so output is deterministic.
//
// Where Excalidraw draws a label bound to an arrow (verified against @excalidraw/utils 0.1.7,
// dist/dev/index.js: LinearElementEditor.computeBoundTextElementPosition / getBoundTextElementCenter,
// used by both the canvas hit-testing and renderElementToSvg):
//   - if the text has a finite `labelPosition` (0..1), it is centered on that fraction of the arrow's path length;
//   - else it is centered on the middle vertex when the arrow has an odd number of points, otherwise on the
//     midpoint of the middle segment (points n/2-1 .. n/2). Arrows here have roundness null, so segments are straight.
// The text element's own stored x/y is ignored on screen, so the checker recomputes it the same way.
//
// Exception: a text with `exactPlacement: true` (edge labels of neutral-geometry engines, src/engines/neutral.ts) is
// drawn exactly at its stored x/y/width/height. D2 and Mermaid/ELK put labels beside the route, so the box centre is
// not a point on it; the checker uses the stored box as is.

import {
  arrowPoints,
  convexOverlapDepth,
  parallelRun,
  pathLength,
  pointAtFraction,
  rectInside,
  rectOf,
  rectOverlapDepth,
  rectPoly,
  segHitsRect,
  segInsideLength,
  segIntersect,
  segLength,
  shapePoly,
  shrink,
  type Pt,
  type Rect,
  type SceneElement,
} from "./geom.js";
import { NEW_RULES, TOL_EXTRA, runExtraRules, type Label, type RuleDef } from "./rules-extra.js";
import { TOL_VISUAL, VISUAL_RULES, runVisualRules } from "./rules-visual.js";

// Every rule is [severity, definition, plannedSeverity?]. Rules added in QA stage 2 (see NEW_RULES in
// rules-extra.mjs) ship as "soft" with plannedSeverity "hard": promotion is flipping NEW_RULES_SOFT there.
export const RULES: Record<string, RuleDef> = {
  "label-label-overlap": ["hard", "two text boxes (node, zone, edge or title labels) intersect by more than 1 px"],
  "label-on-foreign-arrow": ["hard", "an edge label's box is crossed by a segment of an arrow other than its own"],
  "label-on-node": ["hard", "an edge label's box overlaps a node shape by more than 1 px"],
  "arrow-through-node": ["hard", "an arrow segment passes more than 2 px inside a node that is not one of its endpoints"],
  "text-overflow": ["hard", "a node label is wider or taller than its container minus 4 px"],
  "group-containment": ["hard", "a member node, nested zone or zone title is not inside its zone rectangle"],
  "parallel-edges-close": ["hard", "arrows between the same node pair run closer than 20 px along a shared run of 16 px or more"],
  "node-overlap": ["hard", "two different nodes overlap by more than 1 px (extra rule)"],
  "zone-intrusion": ["hard", "a node or zone overlaps a zone it does not belong to by more than 1 px (extra rule)"],
  "arrow-detached": ["hard", "an arrow end is more than 10 px away from the node it is bound to, e.g. a broken self-loop (extra rule)"],
  "cli-failure": ["hard", "draw exited non-zero, crashed, or wrote no valid scene (added by the runner)"],
  "render-failure": ["hard", "--png was requested but no PNG was produced (added by the runner)"],
  "arrow-crossings": ["soft", "number of proper arrow-arrow crossings in the diagram"],
  "route-ratio": ["soft", "an arrow's route is more than 3x longer than the straight line between its ends"],
  "aspect-ratio": ["soft", "the diagram's bounding box is more than 4:1 in either direction"],
  "label-stored-offset": ["soft", "an edge label's stored position differs by more than 2 px from where Excalidraw draws it"],
  "text-exceeds-inscribed": ["soft", "an ellipse/diamond label is larger than the shape's inscribed text area (w/sqrt2, w/2)"],
  "cli-stderr": ["soft", "draw wrote to stderr on a successful run (added by the runner)"],
  ...NEW_RULES,
  ...VISUAL_RULES,
};

export const TOL = {
  ...TOL_EXTRA,
  ...TOL_VISUAL,
  labelOverlap: 1, // px of penetration before two boxes count as overlapping
  labelOnArrow: 1, // label box is shrunk by this before the segment test
  nodeOverlap: 1,
  arrowThroughNode: 2, // node is shrunk by this per side before the segment test
  textOverflow: 4,
  detached: 10, // gap between an arrow end and its bound node's box
  containment: 1,
  parallelDist: 20,
  parallelRun: 16,
  routeRatio: 3,
  aspectRatio: 4,
  labelStoredOffset: 2,
};

const r1 = (n: number): number => Math.round(n * 10) / 10;

export { arrowPoints };

/** Center where Excalidraw draws a text bound to `arrow` (see header). */
export function boundTextCenter(arrow: SceneElement, text: SceneElement | null | undefined): Pt | null {
  const pts = arrowPoints(arrow);
  if (pts.length < 2) return null;
  if (Number.isFinite(text?.labelPosition)) return pointAtFraction(pts, text!.labelPosition!);
  const n = pts.length;
  if (n % 2 === 1) return pts[(n - 1) / 2]!;
  const a = pts[n / 2 - 1]!;
  const b = pts[n / 2]!;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Key shared by all the shapes of one DSL node: a body is `node-<id>`, a cylinder cap is `cap-<id>`.
 * Prefix guessing alone aliases ids, so a `cap-` ellipse only counts as a cap when its body `node-<id>`
 * exists in the scene; anything else keeps its full element id as the key.
 */
const makeKeyOf = (els: SceneElement[]) => {
  const bodies = new Set(els.filter((e) => e.id.startsWith("node-")).map((e) => e.id));
  return (e: SceneElement): string => {
    if (e.id.startsWith("cap-") && e.type === "ellipse" && bodies.has(`node-${e.id.slice(4)}`)) return e.id.slice(4);
    return e.id.startsWith("node-") ? e.id.slice(5) : e.id;
  };
};

export interface Finding {
  code: string;
  severity: "hard" | "soft";
  elements: string[];
  detail: string;
}

export interface SceneStats {
  nodes: number;
  edges: number;
  zones: number;
  labels: number;
  crossings: number;
}

/**
 * Analyse a scene ({elements: [...]}). Returns {findings, stats}; each finding is
 * {code, severity, elements: string[], detail: string}.
 */
export function analyzeScene(scene: { elements?: SceneElement[] } | null | undefined): { findings: Finding[]; stats: SceneStats } {
  const els = (scene?.elements ?? []).filter((e) => !e.isDeleted);
  const byId = new Map(els.map((e) => [e.id, e]));
  const findings: Finding[] = [];
  const add = (code: string, elements: string[], detail: string): void => {
    findings.push({ code, severity: RULES[code]![0], elements: [...elements].sort(), detail });
  };

  const arrows = els.filter((e) => e.type === "arrow");
  const texts = els.filter((e) => e.type === "text");
  const shapes = els.filter((e) => ["rectangle", "ellipse", "diamond"].includes(e.type));
  // zone rectangles are told from node shapes by type + prefix (zone titles are texts), never by a
  // `zone-title` id prefix: a group called `titles` has the rectangle id `zone-titles`.
  const zones = shapes.filter((e) => e.type === "rectangle" && e.id.startsWith("zone-"));
  const nodeParts = shapes.filter((e) => !zones.includes(e)); // includes cylinder caps
  const keyOf = makeKeyOf(els);
  const nodeKey = (id: string): string => (byId.has(id) ? keyOf(byId.get(id)!) : id.replace(/^node-/, ""));
  const partsByNode = new Map<string, SceneElement[]>();
  for (const p of nodeParts) {
    const k = keyOf(p);
    if (!partsByNode.has(k)) partsByNode.set(k, []);
    partsByNode.get(k)!.push(p);
  }

  // ---- labels with the box Excalidraw actually draws ----
  const labels: Label[] = [];
  for (const t of texts) {
    const container = t.containerId ? byId.get(t.containerId) : undefined;
    let x = t.x;
    let y = t.y;
    let kind = t.id.startsWith("zone-title-") && !t.containerId ? "zone" : t.containerId ? "node" : "title";
    let owner = container;
    let center: Pt | null = null; // where Excalidraw draws an arrow-bound label; null when it cannot be derived
    if (container?.type === "arrow") {
      kind = "edge";
      center = t.exactPlacement ? [t.x + t.width / 2, t.y + t.height / 2] : boundTextCenter(container, t);
      if (center && !t.exactPlacement) {
        x = center[0] - t.width / 2;
        y = center[1] - t.height / 2;
      }
    }
    labels.push({ id: t.id, kind, owner, center, el: t, rect: rectOf(x, y, t.width, t.height), stored: rectOf(t.x, t.y, t.width, t.height) });
  }

  // label-label-overlap
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!;
      const b = labels[j]!;
      const d = rectOverlapDepth(a.rect, b.rect);
      if (d > TOL.labelOverlap) {
        add("label-label-overlap", [a.id, b.id], `${a.kind} label "${a.el.text}" and ${b.kind} label "${b.el.text}" overlap by ${r1(d)} px`);
      }
    }
  }

  // label-on-foreign-arrow, label-on-node, label-stored-offset
  for (const l of labels.filter((x) => x.kind === "edge")) {
    const probe = shrink(l.rect, TOL.labelOnArrow);
    for (const a of arrows) {
      if (a.id === l.owner!.id) continue;
      const pts = arrowPoints(a);
      let hits = 0;
      for (let i = 1; i < pts.length; i++) if (segHitsRect(pts[i - 1]!, pts[i]!, probe)) hits++;
      if (hits) add("label-on-foreign-arrow", [l.id, a.id], `edge label "${l.el.text}" is crossed by ${hits} segment(s) of ${a.id}`);
    }
    const lp = rectPoly(l.rect);
    for (const [key, parts] of partsByNode) {
      const d = Math.max(...parts.map((p) => convexOverlapDepth(lp, shapePoly(p))));
      if (d > TOL.labelOverlap) add("label-on-node", [l.id, parts[0]!.id], `edge label "${l.el.text}" overlaps node ${key} by ${r1(d)} px`);
    }
    const off = Math.hypot(l.rect.x1 - l.stored.x1, l.rect.y1 - l.stored.y1);
    if (off > TOL.labelStoredOffset) add("label-stored-offset", [l.id], `stored position is ${r1(off)} px from the drawn position`);
  }

  // arrow-through-node
  for (const a of arrows) {
    const ends = new Set([a.startBinding?.elementId, a.endBinding?.elementId].filter((id): id is string => Boolean(id)).map(nodeKey));
    const pts = arrowPoints(a);
    for (const [key, parts] of partsByNode) {
      if (ends.has(key)) continue;
      let worst = 0;
      for (const p of parts) {
        const poly = shapePoly(p, TOL.arrowThroughNode);
        for (let i = 1; i < pts.length; i++) worst = Math.max(worst, segInsideLength(pts[i - 1]!, pts[i]!, poly));
      }
      if (worst > 1) add("arrow-through-node", [a.id, parts[0]!.id], `${a.id} runs ${r1(worst)} px inside node ${key}`);
    }
  }

  // arrow-detached: each bound end must touch (be within 10 px of) its node
  for (const a of arrows) {
    const pts = arrowPoints(a);
    const bound: Array<[string, SceneElement["startBinding"], Pt | undefined]> = [
      ["start", a.startBinding, pts[0]],
      ["end", a.endBinding, pts[pts.length - 1]],
    ];
    for (const [end, binding, p] of bound) {
      const t = binding && byId.get(binding.elementId as string);
      if (!t || !p) continue;
      // a cylinder is its body plus a cap ellipse; the arrow may touch either
      const parts = partsByNode.get(nodeKey(t.id)) ?? [t];
      const d = Math.min(
        ...parts.map((q) => Math.hypot(Math.max(q.x - p[0], 0, p[0] - (q.x + q.width)), Math.max(q.y - p[1], 0, p[1] - (q.y + q.height)))),
      );
      if (d > TOL.detached) add("arrow-detached", [a.id, t.id], `${a.id} ${end} is ${r1(d)} px from ${t.id}`);
    }
  }

  // text-overflow and text-exceeds-inscribed
  for (const l of labels.filter((x) => x.kind === "node" && x.owner)) {
    const c = l.owner!;
    if (l.el.width > c.width - TOL.textOverflow || l.el.height > c.height - TOL.textOverflow) {
      add("text-overflow", [l.id, c.id], `label ${r1(l.el.width)}x${r1(l.el.height)} does not fit ${c.type} ${r1(c.width)}x${r1(c.height)} minus ${TOL.textOverflow} px`);
    }
    const k = c.type === "ellipse" ? Math.SQRT1_2 : c.type === "diamond" ? 0.5 : 1;
    if (k < 1 && (l.el.width > c.width * k || l.el.height > c.height * k)) {
      add("text-exceeds-inscribed", [l.id, c.id], `label ${r1(l.el.width)}x${r1(l.el.height)} exceeds ${c.type} inscribed area ${r1(c.width * k)}x${r1(c.height * k)}`);
    }
  }

  // node-overlap
  const keys = [...partsByNode.keys()].sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      let d = -Infinity;
      for (const p of partsByNode.get(keys[i]!)!) for (const q of partsByNode.get(keys[j]!)!) d = Math.max(d, convexOverlapDepth(shapePoly(p), shapePoly(q)));
      if (d > TOL.nodeOverlap) add("node-overlap", [partsByNode.get(keys[i]!)![0]!.id, partsByNode.get(keys[j]!)![0]!.id], `nodes ${keys[i]} and ${keys[j]} overlap by ${r1(d)} px`);
    }
  }

  // group-containment and zone-intrusion
  const zoneRect = (z: SceneElement): Rect => rectOf(z.x, z.y, z.width, z.height);
  for (const z of zones) {
    const gid = z.groupIds?.[0];
    if (!gid) continue;
    const zr = zoneRect(z);
    const members = els.filter(
      (e) => e !== z && e.groupIds?.includes(gid) && (e.type !== "text" || e.id.startsWith("zone-title-")) && e.type !== "arrow",
    );
    for (const m of members) {
      const mr = rectOf(m.x, m.y, m.width, m.height);
      if (!rectInside(mr, zr, TOL.containment)) add("group-containment", [m.id, z.id], `${m.id} lies outside zone ${z.id}`);
    }
    const memberIds = new Set(members.map((m) => m.id));
    const zoneGroups = new Set<string | undefined>(z.groupIds ?? []);
    for (const e of [...nodeParts, ...zones]) {
      if (e === z || memberIds.has(e.id)) continue;
      if (e.type === "rectangle" && e.id.startsWith("zone-")) {
        // an ancestor zone legitimately contains this one
        if (zoneGroups.has(e.groupIds?.[0])) continue;
      }
      if (e.id.startsWith("zone-") && z.id > e.id) continue; // report a zone pair once
      const d = e.id.startsWith("zone-") ? rectOverlapDepth(zr, zoneRect(e)) : convexOverlapDepth(rectPoly(zr), shapePoly(e));
      if (d > TOL.containment && !(e.groupIds ?? []).includes(gid)) {
        add("zone-intrusion", [e.id, z.id], `${e.id} overlaps zone ${z.id} by ${r1(d)} px but is not a member`);
      }
    }
  }

  // parallel-edges-close: same unordered node pair
  const pairs = new Map<string, SceneElement[]>();
  for (const a of arrows) {
    const s = a.startBinding?.elementId;
    const e = a.endBinding?.elementId;
    if (!s || !e || nodeKey(s) === nodeKey(e)) continue;
    const k = [nodeKey(s), nodeKey(e)].sort().join("|");
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k)!.push(a);
  }
  for (const group of pairs.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const pa = arrowPoints(group[i]!);
        const pb = arrowPoints(group[j]!);
        let best: { dist: number; run: number } | null = null;
        for (let x = 1; x < pa.length; x++) {
          for (let y = 1; y < pb.length; y++) {
            const r = parallelRun(pa[x - 1]!, pa[x]!, pb[y - 1]!, pb[y]!, 0.12, TOL.parallelRun);
            if (r && r.dist < TOL.parallelDist && (!best || r.dist < best.dist)) best = r;
          }
        }
        if (best) add("parallel-edges-close", [group[i]!.id, group[j]!.id], `${group[i]!.id} and ${group[j]!.id} run ${r1(best.dist)} px apart over ${r1(best.run)} px`);
      }
    }
  }

  // ---- soft ----
  const crossings: string[][] = [];
  for (let i = 0; i < arrows.length; i++) {
    for (let j = i + 1; j < arrows.length; j++) {
      const pa = arrowPoints(arrows[i]!);
      const pb = arrowPoints(arrows[j]!);
      for (let x = 1; x < pa.length; x++) {
        for (let y = 1; y < pb.length; y++) {
          const hit = segIntersect(pa[x - 1]!, pa[x]!, pb[y - 1]!, pb[y]!);
          if (!hit) continue;
          const nearEnd = [pa[0]!, pa[pa.length - 1]!, pb[0]!, pb[pb.length - 1]!].some((p) => Math.hypot(p[0] - hit.point[0], p[1] - hit.point[1]) < 3);
          if (!nearEnd) crossings.push([arrows[i]!.id, arrows[j]!.id]);
        }
      }
    }
  }
  if (crossings.length) {
    const sample = crossings.slice(0, 4).map((c) => c.join("x")).join(", ");
    add("arrow-crossings", [], `${crossings.length} crossing(s), e.g. ${sample}`);
  }
  for (const a of arrows) {
    const pts = arrowPoints(a);
    if (pts.length < 2) continue;
    const straight = segLength(pts[0]!, pts[pts.length - 1]!);
    if (straight < 30) continue; // self-loops and stubs have no meaningful straight line
    const ratio = pathLength(pts) / straight;
    if (ratio > TOL.routeRatio) add("route-ratio", [a.id], `route is ${r1(ratio)}x the straight-line distance`);
  }
  const box = sceneBounds(els);
  if (box) {
    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    const ar = Math.max(w / Math.max(h, 1), h / Math.max(w, 1));
    if (ar > TOL.aspectRatio) add("aspect-ratio", [], `diagram is ${r1(w)}x${r1(h)} px (${r1(ar)}:1)`);
  }

  runExtraRules({ els, byId, arrows, labels, zones, partsByNode, nodeKey, add });
  runVisualRules({ els, byId, arrows, labels, zones, partsByNode, nodeKey, add });

  findings.sort((a, b) => (a.code + a.elements.join()).localeCompare(b.code + b.elements.join()));
  return {
    findings,
    stats: { nodes: partsByNode.size, edges: arrows.length, zones: zones.length, labels: labels.length, crossings: crossings.length },
  };
}

function sceneBounds(els: SceneElement[]): Rect | null {
  let box: Rect | null = null;
  const grow = (x1: number, y1: number, x2: number, y2: number): void => {
    box = box ? { x1: Math.min(box.x1, x1), y1: Math.min(box.y1, y1), x2: Math.max(box.x2, x2), y2: Math.max(box.y2, y2) } : { x1, y1, x2, y2 };
  };
  for (const e of els) {
    if (e.type === "arrow") for (const p of arrowPoints(e)) grow(p[0], p[1], p[0], p[1]);
    else grow(e.x, e.y, e.x + e.width, e.y + e.height);
  }
  return box;
}
