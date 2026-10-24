// Validates the QA checker itself (src/quality/analyze.ts) on synthetic scenes: every HARD rule must be
// flagged on a minimal violating scene, and a clean scene must pass. These tests never depend on the
// current layout engine, so they stay valid while the layout is being fixed.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULES, analyzeScene, boundTextCenter } from "../src/quality/analyze.js";
import { run, tempDir } from "./helpers/run.js";

type El = Record<string, any>;
interface Finding {
  code: string;
  severity: "hard" | "soft";
  elements: string[];
  detail: string;
}

// ---- synthetic scene builders (ids follow src/scene/ids.ts) ----

const common = { angle: 0, isDeleted: false, groupIds: [] as string[], boundElements: null };
const node = (key: string, x: number, y: number, w = 120, h = 60, type = "rectangle", groupIds: string[] = []): El => ({
  ...common, id: `node-${key}`, type, x, y, width: w, height: h, groupIds,
});
const nodeLabel = (key: string, w: number, h: number, container: El): El => ({
  ...common, id: `label-${key}`, type: "text", text: key, containerId: container.id, width: w, height: h,
  x: container.x + (container.width - w) / 2, y: container.y + (container.height - h) / 2, groupIds: container.groupIds,
});
/** Arrow through absolute waypoints, bound to node-from / node-to. */
const arrow = (n: number, pts: [number, number][], from?: string, to?: string): El => ({
  ...common, id: `edge-${n}`, type: "arrow", x: pts[0]![0], y: pts[0]![1], width: 0, height: 0,
  points: pts.map(([x, y]) => [x - pts[0]![0], y - pts[0]![1]]),
  startBinding: from ? { elementId: `node-${from}` } : null,
  endBinding: to ? { elementId: `node-${to}` } : null,
});
/** Edge label; its stored x/y is deliberately wrong: the checker must use the midpoint rule. */
const edgeLabel = (n: number, text: string, w: number, h = 20, extra: El = {}): El => ({
  ...common, id: `edge-label-${n}`, type: "text", text, containerId: `edge-${n}`, width: w, height: h, x: -999, y: -999, ...extra,
});
const zone = (key: string, x: number, y: number, w: number, h: number, groupIds: string[]): El => ({
  ...common, id: `zone-${key}`, type: "rectangle", x, y, width: w, height: h, groupIds,
});
const scene = (...elements: El[]) => ({ type: "excalidraw", version: 2, elements });
const codes = (s: El, severity?: "hard" | "soft"): string[] =>
  (analyzeScene(s).findings as Finding[]).filter((f) => !severity || f.severity === severity).map((f) => f.code);
const hard = (s: El) => codes(s, "hard");

// A clean two-node scene with one labeled arrow.
const a = node("a", 0, 0);
const b = node("b", 0, 160);
const clean = () =>
  scene(a, b, nodeLabel("a", 60, 25, a), nodeLabel("b", 60, 25, b), arrow(0, [[60, 60], [60, 160]], "a", "b"), edgeLabel(0, "ok", 30, 20, { x: 45, y: 100 }));

describe("clean scene", () => {
  it("has no findings at all", () => {
    expect(analyzeScene(clean()).findings).toEqual([]);
  });
  it("is deterministic", () => {
    const s = scene(a, b, arrow(0, [[40, 60], [40, 160]], "a", "b"), arrow(1, [[50, 160], [50, 60]], "b", "a"), edgeLabel(0, "x", 70), edgeLabel(1, "y", 70));
    expect(JSON.stringify(analyzeScene(s))).toBe(JSON.stringify(analyzeScene(s)));
  });
  it("every rule has a severity and a definition", () => {
    for (const [code, [severity, definition]] of Object.entries(RULES as Record<string, [string, string]>)) {
      expect(["hard", "soft"], code).toContain(severity);
      expect(definition.length, code).toBeGreaterThan(10);
    }
  });
});

describe("where Excalidraw draws an arrow-bound label", () => {
  const at = (pts: [number, number][], extra: El = {}) => boundTextCenter(arrow(0, pts), edgeLabel(0, "t", 10, 10, extra));
  it("2 points: midpoint of the only segment", () => {
    expect(at([[0, 0], [100, 40]])).toEqual([50, 20]);
  });
  it("odd count (3): the middle vertex", () => {
    expect(at([[0, 0], [80, 0], [80, 100]])).toEqual([80, 0]);
  });
  it("even count (4): midpoint of the middle segment", () => {
    expect(at([[0, 0], [10, 0], [10, 100], [50, 100]])).toEqual([10, 50]);
  });
  it("honours a finite labelPosition along the path length", () => {
    expect(at([[0, 0], [100, 0], [100, 100]], { labelPosition: 0.25 })).toEqual([50, 0]);
  });
  it("ignores the text element's stored x/y", () => {
    // arrows 20 px apart, labels stored far away but drawn on top of each other
    const s = scene(arrow(0, [[0, 0], [0, 100]]), arrow(1, [[20, 0], [20, 100]]), edgeLabel(0, "q", 60), edgeLabel(1, "r", 60));
    expect(hard(s)).toContain("label-label-overlap");
    expect(codes(s, "soft")).toContain("label-stored-offset");
  });
});

describe("HARD rules are flagged", () => {
  it("label-label-overlap: two edge labels", () => {
    const s = scene(arrow(0, [[40, 0], [40, 100]]), arrow(1, [[60, 100], [60, 0]]), edgeLabel(0, "question", 70), edgeLabel(1, "answer", 60));
    expect(hard(s)).toContain("label-label-overlap");
  });
  it("label-label-overlap: node label vs zone title", () => {
    const g = zone("g", 0, 0, 300, 200, ["group-g"]);
    const n = node("n", 20, 5, 120, 60, "rectangle", ["group-g"]);
    const title = { ...common, id: "zone-title-g", type: "text", text: "Zone", x: 24, y: 8, width: 60, height: 20, containerId: null, groupIds: ["group-g"] };
    expect(hard(scene(g, n, nodeLabel("n", 60, 25, n), title))).toContain("label-label-overlap");
  });
  it("label-on-foreign-arrow: another arrow crosses the label, own arrow does not count", () => {
    const s = scene(arrow(0, [[0, 100], [200, 100]]), arrow(1, [[100, 0], [100, 200]]), edgeLabel(0, "label", 60));
    const f = (analyzeScene(s).findings as Finding[]).filter((x) => x.code === "label-on-foreign-arrow");
    expect(f).toHaveLength(1);
    expect(f[0]!.elements).toEqual(["edge-1", "edge-label-0"]);
    expect(hard(scene(arrow(0, [[0, 100], [200, 100]]), edgeLabel(0, "label", 60)))).toEqual([]);
  });
  it("label-on-node: the label midpoint sits inside a node", () => {
    const c = node("c", 60, 80, 120, 60);
    const s = scene(c, arrow(0, [[0, 110], [240, 110]]), edgeLabel(0, "label", 50));
    expect(hard(s)).toContain("label-on-node");
  });
  it("arrow-through-node: passes through a non-endpoint node, not through its own ends", () => {
    const mid = node("m", 0, 80);
    const s = scene(a, mid, b, arrow(0, [[60, 60], [60, 220]], "a", "b"));
    const f = (analyzeScene(s).findings as Finding[]).filter((x) => x.code === "arrow-through-node");
    expect(f.map((x) => x.elements)).toEqual([["edge-0", "node-m"]]);
  });
  it("arrow-through-node: honours the 2 px tolerance", () => {
    const side = node("s", 59, 80, 120, 60); // arrow at x=60 is only 1 px inside this node's left edge
    expect(hard(scene(a, side, b, arrow(0, [[60, 60], [60, 160]], "a", "b")))).not.toContain("arrow-through-node");
  });
  it("text-overflow: label wider than container minus 4 px", () => {
    const n = node("n", 0, 0, 120, 60);
    expect(hard(scene(n, nodeLabel("n", 118, 20, n)))).toContain("text-overflow");
    expect(hard(scene(n, nodeLabel("n", 116, 20, n)))).not.toContain("text-overflow");
    expect(hard(scene(n, nodeLabel("n", 60, 57, n)))).toContain("text-overflow");
  });
  it("group-containment: member node outside its zone", () => {
    const g = zone("g", 0, 0, 300, 300, ["group-g"]);
    const inside = node("in", 20, 20, 100, 50, "rectangle", ["group-g"]);
    const outside = node("out", 400, 20, 100, 50, "rectangle", ["group-g"]);
    const f = (analyzeScene(scene(g, inside, outside)).findings as Finding[]).filter((x) => x.code === "group-containment");
    expect(f.map((x) => x.elements)).toEqual([["node-out", "zone-g"]]);
  });
  it("group-containment: nested zone sticking out of its parent", () => {
    const outer = zone("o", 0, 0, 300, 300, ["group-o"]);
    const inner = zone("i", 200, 200, 200, 200, ["group-i", "group-o"]);
    expect(hard(scene(outer, inner))).toContain("group-containment");
  });
  it("group-containment: nested zone properly inside passes", () => {
    const outer = zone("o", 0, 0, 300, 300, ["group-o"]);
    const inner = zone("i", 20, 20, 200, 200, ["group-i", "group-o"]);
    expect(hard(scene(outer, inner))).toEqual([]);
  });
  it("parallel-edges-close: reciprocal arrows 8 px apart, but not 40 px apart", () => {
    const close = scene(a, b, arrow(0, [[56, 60], [56, 160]], "a", "b"), arrow(1, [[64, 160], [64, 60]], "b", "a"));
    expect(hard(close)).toContain("parallel-edges-close");
    const far = scene(a, b, arrow(0, [[30, 60], [30, 160]], "a", "b"), arrow(1, [[90, 160], [90, 60]], "b", "a"));
    expect(hard(far)).not.toContain("parallel-edges-close");
  });
  it("parallel-edges-close: only arrows of the same node pair are compared", () => {
    const c = node("c", 200, 0);
    const d = node("d", 200, 160);
    const s = scene(a, b, c, d, arrow(0, [[60, 60], [60, 160]], "a", "b"), arrow(1, [[200, 60], [200, 160]], "c", "d"));
    expect(hard(s)).not.toContain("parallel-edges-close");
  });
  it("arrow-detached: an arrow end far from its bound node (broken self-loop)", () => {
    const loop = scene(a, arrow(0, [[300, 20], [200, 40], [100, 60]], "a", "a"));
    expect(hard(loop)).toContain("arrow-detached");
    expect(hard(clean())).not.toContain("arrow-detached");
  });
  it("node-overlap and zone-intrusion (extra rules)", () => {
    expect(hard(scene(node("p", 0, 0), node("q", 50, 30)))).toContain("node-overlap");
    const g = zone("g", 0, 0, 200, 200, ["group-g"]);
    const stray = node("stray", 150, 150, 100, 60); // not a member but overlaps the zone
    expect(hard(scene(g, stray))).toContain("zone-intrusion");
  });
});

describe("SOFT signals", () => {
  it("arrow-crossings counts proper crossings, not shared endpoints", () => {
    const x = scene(arrow(0, [[0, 0], [100, 100]]), arrow(1, [[100, 0], [0, 100]]));
    expect(codes(x, "soft")).toContain("arrow-crossings");
    const shared = scene(arrow(0, [[0, 0], [100, 100]]), arrow(1, [[0, 0], [100, 0]]));
    expect(codes(shared, "soft")).not.toContain("arrow-crossings");
  });
  it("route-ratio: a long detour is reported", () => {
    const s = scene(arrow(0, [[0, 0], [0, 500], [100, 500], [100, 0]]));
    expect(codes(s, "soft")).toContain("route-ratio");
  });
  it("aspect-ratio: very wide diagrams are reported", () => {
    const s = scene(node("w1", 0, 0), node("w2", 2000, 0));
    expect(codes(s, "soft")).toContain("aspect-ratio");
    expect(codes(clean(), "soft")).not.toContain("aspect-ratio");
  });
  it("soft findings never count as hard", () => {
    expect(hard(scene(arrow(0, [[0, 0], [100, 100]]), arrow(1, [[100, 0], [0, 100]])))).toEqual([]);
  });
});

// ---- QA stage 2 rules: ship SOFT, plannedSeverity records the intended HARD (see src/quality/rules-extra.ts) ----
const NEW_CODES = [
  "arrowhead-inside-node", "arrow-end-on-wrong-side", "label-far-from-arrow", "label-outside-zone", "zone-title-crossed",
  "arrows-collinear-overlap", "label-outside-canvas", "label-near-arrowhead", "self-loop-shape", "degenerate-segment",
  "checker-id-collision", "arrowheads-crowded",
];
/** Give an arrow heads: "end" (->), "both" (<->), or "none". */
const heads = (el: El, which: "end" | "both" | "none" = "end"): El => ({
  ...el, endArrowhead: which === "none" ? null : "arrow", startArrowhead: which === "both" ? "arrow" : null,
});
const has = (s: El, code: string) => codes(s).includes(code);
const bn = node("b2", 0, 160); // a node with its top at y = 160 for arrows that end on it
const title = (id: string, text: string, x: number, y: number, w = 80, h = 20, gids: string[] = []): El => ({
  ...common, id, type: "text", text, x, y, width: w, height: h, containerId: null, groupIds: gids,
});

describe("new rules run at their planned severity (promoted after one SOFT iteration)", () => {
  it("every new rule's severity equals its plannedSeverity", () => {
    for (const code of NEW_CODES) {
      const [severity, definition, planned] = (RULES as Record<string, string[]>)[code]!;
      expect(severity, code).toBe(planned);
      expect(["hard", "soft"], code).toContain(planned);
      expect(definition!.length, code).toBeGreaterThan(20);
    }
  });
  it("planned-hard rules fail the render, planned-soft rules do not", () => {
    const s = scene(bn, heads(arrow(0, [[50, 100], [50, 175]], undefined, "b2")), heads(arrow(1, [[0, 0], [0, 1], [0, 100]])));
    expect(has(s, "arrowhead-inside-node")).toBe(true);
    expect(has(s, "degenerate-segment")).toBe(true);
    expect(hard(s)).toContain("arrowhead-inside-node");
    expect(hard(s)).not.toContain("degenerate-segment");
  });
});

describe("arrowhead-inside-node", () => {
  const into = (y: number, h: "end" | "none" = "end") => scene(bn, heads(arrow(0, [[60, 100], [60, y]], undefined, "b2"), h));
  it("flags a head tip 10 px inside the node", () => expect(has(into(170), "arrowhead-inside-node")).toBe(true));
  it("near miss: 2 px inside (tolerance 3), on the border, no head, or a tail end", () => {
    expect(has(into(162), "arrowhead-inside-node")).toBe(false);
    expect(has(into(160), "arrowhead-inside-node")).toBe(false);
    expect(has(into(170, "none"), "arrowhead-inside-node")).toBe(false);
    expect(has(scene(bn, arrow(0, [[60, 170], [60, 100]], "b2")), "arrowhead-inside-node")).toBe(false);
  });
  it("<-> checks the start tip too", () => {
    const s = scene(bn, heads(arrow(0, [[60, 175], [60, 100]], "b2"), "both"));
    expect(has(s, "arrowhead-inside-node")).toBe(true);
  });
  it("cylinders: the cap outline is fine, a tip deep in the body is not", () => {
    const body = node("c", 0, 160);
    const cap = { ...common, id: "cap-c", type: "ellipse", x: 0, y: 152, width: 120, height: 16, groupIds: ["cyl-c"] };
    expect(has(scene(body, cap, heads(arrow(0, [[60, 100], [60, 152]], undefined, "c"))), "arrowhead-inside-node")).toBe(false);
    expect(has(scene(body, cap, heads(arrow(0, [[60, 100], [60, 185]], undefined, "c"))), "arrowhead-inside-node")).toBe(true);
  });
});

describe("arrow-end-on-wrong-side", () => {
  it("flags an end that meets a side while travelling outward, at either end", () => {
    expect(has(scene(a, arrow(0, [[60, 0], [60, 60]], undefined, "a")), "arrow-end-on-wrong-side")).toBe(true);
    expect(has(scene(a, arrow(0, [[60, 60], [60, 20]], "a")), "arrow-end-on-wrong-side")).toBe(true);
  });
  it("near miss: arriving from outside, sliding along the side, and cylinders/diamonds entered properly", () => {
    expect(has(scene(a, arrow(0, [[60, 160], [60, 60]], undefined, "a")), "arrow-end-on-wrong-side")).toBe(false);
    expect(has(scene(a, arrow(0, [[120, 160], [120, 60]], undefined, "a")), "arrow-end-on-wrong-side")).toBe(false); // along the right side
    expect(has(scene(a, arrow(0, [[60, 60], [60, 160]], "a")), "arrow-end-on-wrong-side")).toBe(false);
    const dia = node("d", 0, 0, 120, 60, "diamond");
    expect(has(scene(dia, arrow(0, [[60, -80], [60, 0]], undefined, "d")), "arrow-end-on-wrong-side")).toBe(false);
  });
});

describe("label-far-from-arrow", () => {
  it("flags a labelPosition outside 0..1 and an arrow with nothing to sit on", () => {
    expect(has(scene(arrow(0, [[0, 0], [200, 0]]), edgeLabel(0, "q", 30, 20, { labelPosition: 1.4 })), "label-far-from-arrow")).toBe(true);
    expect(has(scene(arrow(0, [[10, 10]]), edgeLabel(0, "q", 30)), "label-far-from-arrow")).toBe(true);
  });
  it("near miss: centered by the midpoint rule or by a labelPosition in range", () => {
    expect(has(scene(arrow(0, [[0, 0], [200, 0]]), edgeLabel(0, "q", 30)), "label-far-from-arrow")).toBe(false);
    expect(has(scene(arrow(0, [[0, 0], [200, 0]]), edgeLabel(0, "q", 30, 20, { labelPosition: 0.9 })), "label-far-from-arrow")).toBe(false);
  });
});

describe("label-outside-zone", () => {
  const g = zone("g", 0, 0, 300, 200, ["group-g"]);
  const p = node("p", 20, 20, 100, 50, "rectangle", ["group-g"]);
  const q = node("q", 170, 20, 100, 50, "rectangle", ["group-g"]);
  it("flags a label of an inside edge drawn outside the zone", () => {
    const detour = arrow(0, [[70, 70], [70, 260], [220, 260], [220, 70]], "p", "q"); // label at (145, 260)
    expect(has(scene(g, p, q, detour, edgeLabel(0, "x", 40)), "label-outside-zone")).toBe(true);
  });
  it("near miss: the same edge routed and labelled inside the zone", () => {
    const direct = arrow(0, [[120, 45], [170, 45]], "p", "q");
    expect(has(scene(g, p, q, direct, edgeLabel(0, "x", 30)), "label-outside-zone")).toBe(false);
  });
  it("flags a label sitting in a zone neither end belongs to; not when one end does", () => {
    const r = node("r", 400, 0), s = node("s", 400, 160);
    const through = arrow(0, [[130, 100], [220, 100]], "r", "s"); // label at (175, 100) inside g
    expect(has(scene(g, p, q, r, s, through, edgeLabel(0, "x", 40)), "label-outside-zone")).toBe(true);
    const member = node("r", 400, 0, 120, 60, "rectangle", ["group-g"]);
    expect(has(scene(g, p, q, member, s, through, edgeLabel(0, "x", 40)), "label-outside-zone")).toBe(false);
  });
});

describe("zone-title-crossed", () => {
  const g = zone("g", 0, 0, 300, 200, ["group-g"]);
  const t = title("zone-title-g", "Zone", 24, 8, 80, 20, ["group-g"]);
  it("flags an arrow crossing the title box", () => {
    expect(has(scene(g, t, arrow(0, [[50, -20], [50, 100]])), "zone-title-crossed")).toBe(true);
  });
  it("near miss: an arrow beside the title, and one touching its box by under 1 px", () => {
    expect(has(scene(g, t, arrow(0, [[150, -20], [150, 100]])), "zone-title-crossed")).toBe(false);
    expect(has(scene(g, t, arrow(0, [[103.5, -20], [103.5, 100]])), "zone-title-crossed")).toBe(false);
  });
});

describe("arrows-collinear-overlap", () => {
  const line = (n: number, x1: number, x2: number, y: number, from: string, to: string) => arrow(n, [[x1, y], [x2, y]], from, to);
  it("flags near-parallel tracks of different node pairs that overlap", () => {
    expect(has(scene(line(0, 0, 200, 100, "a", "b"), line(1, 20, 220, 106, "c", "d")), "arrows-collinear-overlap")).toBe(true);
  });
  it("near miss: 14 px apart, only 20 px of overlap, or the same node pair (that is parallel-edges-close)", () => {
    expect(has(scene(line(0, 0, 200, 100, "a", "b"), line(1, 20, 220, 114, "c", "d")), "arrows-collinear-overlap")).toBe(false);
    expect(has(scene(line(0, 0, 200, 100, "a", "b"), line(1, 180, 380, 106, "c", "d")), "arrows-collinear-overlap")).toBe(false);
    expect(has(scene(line(0, 0, 200, 100, "a", "b"), line(1, 200, 20, 106, "b", "a")), "arrows-collinear-overlap")).toBe(false);
  });
  const fanIn = (pitch: number) =>
    scene(...Array.from({ length: 8 }, (_, i) => {
      const y = 100 + pitch * i;
      return arrow(i, [[600 + 160 * i, 80], [600 + 160 * i, y], [584 + 16.5 * i, y], [584 + 16.5 * i, 164]], `s${i}`, "sink");
    }));
  it("8-arrow fan-in on rails 8.4 px apart is flagged; with 14 px rails it is not", () => {
    const found = (analyzeScene(fanIn(8.4)).findings as Finding[]).filter((f) => f.code === "arrows-collinear-overlap");
    expect(found.length).toBeGreaterThanOrEqual(6); // rail 0 is only 16 px long
    expect(has(fanIn(14), "arrows-collinear-overlap")).toBe(false);
  });
});

describe("label-outside-canvas", () => {
  it("flags a point at a negative coordinate and a label drawn outside the exported bounds", () => {
    expect(has(scene(arrow(0, [[-5, 0], [100, 0]])), "label-outside-canvas")).toBe(true);
    // stored label box (100..160) is inside the bounds, the drawn one (75..135) sticks out to the left
    const s = scene(arrow(0, [[100, 100], [110, 100]]), edgeLabel(0, "x", 60, 20, { x: 100, y: 90 }));
    expect(has(s, "label-outside-canvas")).toBe(true);
  });
  it("near miss: everything at x,y >= 0, and the title above y = 0 is allowed", () => {
    expect(has(scene(arrow(0, [[0, 0], [100, 0]]), title("title", "T", 10, -35, 60, 35)), "label-outside-canvas")).toBe(false);
    expect(has(clean(), "label-outside-canvas")).toBe(false);
  });
});

describe("label-near-arrowhead", () => {
  const short = (len: number, h: "end" | "none") => scene(heads(arrow(0, [[0, 100], [len, 100]]), h), edgeLabel(0, "x", 20));
  it("flags a label box within 6 px of the arrowhead tip", () => expect(has(short(30, "end"), "label-near-arrowhead")).toBe(true));
  it("near miss: 10 px clear, or no head at that end", () => {
    expect(has(short(40, "end"), "label-near-arrowhead")).toBe(false);
    expect(has(short(30, "none"), "label-near-arrowhead")).toBe(false);
  });
});

describe("self-loop-shape", () => {
  const loop = (pts: [number, number][]) => scene(a, heads(arrow(0, pts, "a", "a")));
  const bad = (pts: [number, number][]) => has(loop(pts), "self-loop-shape");
  it("flags 2 points, a loop collapsed into the node, too small a loop and a crowded start", () => {
    expect(bad([[120, 20], [120, 40]])).toBe(true);
    expect(bad([[100, 20], [110, 20], [110, 40], [100, 40]])).toBe(true);
    expect(bad([[120, 20], [130, 20], [130, 40], [120, 40]])).toBe(true); // reaches 10 px
    expect(bad([[120, 28], [150, 28], [150, 32], [120, 32]])).toBe(true); // 4 px between start and tip
  });
  it("near miss: a 30 px loop and a minimal acceptable 24 px / 18 px loop", () => {
    expect(bad([[120, 20], [150, 20], [150, 40], [120, 40]])).toBe(false);
    expect(bad([[120, 20], [144, 20], [144, 38], [120, 38]])).toBe(false);
  });
  it("is not applied to ordinary arrows", () => expect(has(scene(a, b, arrow(0, [[60, 60], [60, 160]], "a", "b")), "self-loop-shape")).toBe(false));
});

describe("degenerate-segment", () => {
  it("flags a 1 px segment but not a 3 px one", () => {
    expect(has(scene(arrow(0, [[0, 0], [0, 1], [0, 100]])), "degenerate-segment")).toBe(true);
    expect(has(scene(arrow(0, [[0, 0], [0, 3], [0, 100]])), "degenerate-segment")).toBe(false);
  });
});

describe("arrowheads-crowded", () => {
  const ends = (x1: number, x2: number, h: "end" | "none") =>
    scene(bn, heads(arrow(0, [[x1, 100], [x1, 160]], undefined, "b2"), h), heads(arrow(1, [[x2, 100], [x2, 160]], undefined, "b2"), h));
  it("flags two arrowheads 10 px apart on one node", () => expect(has(ends(50, 60, "end"), "arrowheads-crowded")).toBe(true));
  it("near miss: 28 px apart (the normal port spacing), or two tails that carry no head", () => {
    expect(has(ends(40, 68, "end"), "arrowheads-crowded")).toBe(false);
    expect(has(ends(50, 60, "none"), "arrowheads-crowded")).toBe(false);
  });
  it("a self-loop's own two ends do not count", () => {
    expect(has(scene(a, heads(arrow(0, [[120, 20], [150, 20], [150, 40], [120, 40]], "a", "a"))), "arrowheads-crowded")).toBe(false);
  });
});

describe("checker-id-collision and id aliasing (nodeKey)", () => {
  it("flags two elements with the same id; near miss: distinct ids", () => {
    expect(has(scene(node("x", 0, 0), node("x", 300, 0)), "checker-id-collision")).toBe(true);
    expect(has(scene(node("x", 0, 0), node("y", 300, 0)), "checker-id-collision")).toBe(false);
  });
  it("a group whose id starts with `title` is still a zone, not a node (zone-titles / zone-title-<id> prefix)", () => {
    const g = zone("titles", 0, 0, 300, 200, ["group-titles"]);
    const n = node("n", 20, 40, 100, 50, "rectangle", ["group-titles"]);
    const res = analyzeScene(scene(g, n, nodeLabel("n", 40, 20, n), arrow(0, [[70, 90], [70, 160]], "n")));
    expect(res.stats.zones).toBe(1);
    expect(res.stats.nodes).toBe(1);
    expect((res.findings as Finding[]).map((f) => f.code)).not.toContain("node-overlap");
    expect((res.findings as Finding[]).map((f) => f.code)).not.toContain("arrow-through-node");
  });
  it("node `cap-x` and cylinder `x` stay two nodes; a lone `cap-` ellipse is its own node", () => {
    const rect = node("cap-x", 0, 0);
    const body = node("x", 0, 200);
    const cap = { ...common, id: "cap-x", type: "ellipse", x: 0, y: 192, width: 120, height: 16, groupIds: ["cyl-x"] };
    const res = analyzeScene(scene(rect, body, cap));
    expect(res.stats.nodes).toBe(2);
    expect(hard(scene(rect, body, cap))).toEqual([]);
    const stray = { ...cap, id: "cap-q", y: 500 };
    expect(analyzeScene(scene(rect, body, cap, stray)).stats.nodes).toBe(3);
  });
});

describe("existing rules, extra coverage", () => {
  it("multi-line node label taller than its container minus 4 px is text-overflow (3 lines of 25 px in 60 px)", () => {
    const n = node("n", 0, 0, 120, 60);
    expect(hard(scene(n, nodeLabel("n", 60, 75, n)))).toContain("text-overflow");
    expect(hard(scene(n, nodeLabel("n", 60, 50, n)))).not.toContain("text-overflow"); // 2 lines fit
  });
  it("parallel-edges-close: k=3 with one reversed edge reports each close pair once", () => {
    const s = scene(a, b, arrow(0, [[20, 60], [20, 160]], "a", "b"), arrow(1, [[34, 60], [34, 160]], "a", "b"), arrow(2, [[48, 160], [48, 60]], "b", "a"));
    const f = (analyzeScene(s).findings as Finding[]).filter((x) => x.code === "parallel-edges-close");
    expect(f.map((x) => x.elements)).toEqual([["edge-0", "edge-1"], ["edge-1", "edge-2"]]);
  });
  it("parallel-edges-close: a <-> arrow counts as one of the pair", () => {
    const s = scene(a, b, heads(arrow(0, [[20, 60], [20, 160]], "a", "b"), "both"), arrow(1, [[30, 60], [30, 160]], "a", "b"));
    expect(hard(s)).toContain("parallel-edges-close");
  });
});

describe("known bug class: rag-agent reciprocal arrows", () => {
  // Hand-built from the buggy render: user and agent are vertically aligned about 56 px apart and the
  // reciprocal arrows carry the labels "question" and "answer" (plus a foreign arrow through a label).
  const user = node("user", 100, 0, 120, 60, "ellipse");
  const agent = node("agent", 100, 116, 120, 60);
  const buggy = () =>
    scene(
      user, agent,
      arrow(0, [[150, 56], [150, 116]], "user", "agent"),
      arrow(1, [[162, 116], [162, 56]], "agent", "user"),
      edgeLabel(0, "question", 70),
      edgeLabel(1, "answer", 60),
    );
  it("is detected as a label-label overlap, a label on a foreign arrow and close parallel edges", () => {
    const found = hard(buggy());
    expect(found).toContain("label-label-overlap");
    expect(found).toContain("label-on-foreign-arrow");
    expect(found).toContain("parallel-edges-close");
  });
  it("is clean once the labels and arrows are separated", () => {
    const fixed = scene(
      user, agent,
      arrow(0, [[130, 60], [130, 116]], "user", "agent"),
      arrow(1, [[190, 116], [190, 60]], "agent", "user"),
      edgeLabel(0, "question", 50),
      edgeLabel(1, "answer", 40),
    );
    // labels (50 and 40 wide, centered on x=130 / x=190) are 60 px apart and clear of the other arrow
    expect(hard(fixed)).toEqual([]);
  });
});

describe("corpus", () => {
  const dir = new URL("./qa/corpus/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".exd")).sort();

  it("has at least 44 documented cases including rag-agent", () => {
    expect(files.length).toBeGreaterThanOrEqual(44);
    expect(files).toContain("day-rag-agent.exd");
    for (const f of files) expect(readFileSync(new URL(f, dir), "utf8").startsWith("# "), f).toBe(true);
  });

  it("every case draws (exit 0) and analyses without throwing", () => {
    const out = tempDir();
    for (const f of files) {
      const r = run(["draw", join(fileURLToPath(dir), f), "--out", join(out, f.replace(".exd", "")), "--force"]);
      expect(r.status, `${f}: ${r.stdout}${r.stderr}`).toBe(0);
      const sc = JSON.parse(readFileSync(join(out, f.replace(".exd", ".excalidraw")), "utf8"));
      const res = analyzeScene(sc);
      expect(res.stats.nodes, f).toBeGreaterThan(0);
    }
  });
});
