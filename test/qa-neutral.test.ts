// Checker rules for neutral-geometry engines (D2, Mermaid): edge labels are drawn exactly where the engine put
// them (beside the route), so the checker must use the stored box (`exactPlacement`), measure label-far-from-arrow
// from the box to the route, and size the arrowheads-crowded limit from the engine's arrowhead breadth.
// Synthetic scenes only: the tests never depend on an engine.

import { describe, expect, it } from "vitest";
import { HEAD_WIDTH, toScene, type NeutralBox, type NeutralScene } from "../src/engines/neutral.js";
import { analyzeScene } from "../src/quality/analyze.js";
import { polylineRectDist, rectOf } from "../src/quality/geom.js";

const box = (x: number, y: number, w: number, h: number): NeutralBox => ({ x, y, w, h });
const codesOf = (els: ReturnType<typeof toScene>): string[] => analyzeScene({ elements: els }).findings.map((f) => f.code);

/** S -> T along y = 100, a foreign node N just above the route's middle, and one edge label at `label`. */
function routeScene(label: NeutralBox, foreign = box(170, 70, 60, 25)): NeutralScene {
  return {
    nodes: [
      { id: "S", kind: "node", box: box(0, 80, 40, 40), shape: "rectangle" },
      { id: "T", kind: "node", box: box(360, 80, 40, 40), shape: "rectangle" },
      { id: "N", kind: "node", box: foreign, shape: "rectangle" },
    ],
    edges: [{ id: "e", src: "S", dst: "T", poly: [[40, 100], [360, 100]], label, text: "go" }],
    labels: [],
  };
}

describe("toScene: exact edge-label placement", () => {
  it("marks every edge label text as exactly placed, node labels not", () => {
    const n = routeScene(box(170, 104, 60, 20));
    n.labels.push({ ownerId: "S", box: box(5, 90, 30, 20), text: "S" });
    const els = toScene(n);
    const edgeLabel = els.find((e) => e.id === "edge-label-0")!;
    expect(edgeLabel.exactPlacement).toBe(true);
    expect(els.find((e) => e.id === "label-S")!.exactPlacement).toBeUndefined();
    // the stored box is the engine's box (translated), not a point on the route
    expect(edgeLabel.y - els.find((e) => e.id === "edge-0")!.y).toBeCloseTo(4, 5);
  });

  it("carries the arrowhead breadth: the scene default, overridden per edge; absent when neither is given", () => {
    const n = routeScene(box(170, 104, 60, 20));
    expect(toScene(n).find((e) => e.id === "edge-0")!.arrowheadWidth).toBeUndefined();
    expect(toScene({ ...n, headWidth: HEAD_WIDTH.d2 }).find((e) => e.id === "edge-0")!.arrowheadWidth).toBe(12);
    n.edges[0]!.headWidth = 9;
    expect(toScene({ ...n, headWidth: HEAD_WIDTH.d2 }).find((e) => e.id === "edge-0")!.arrowheadWidth).toBe(9);
  });
});

describe("exact labels: label-on-node and label-stored-offset use the real box", () => {
  it("flags a label box that overlaps a node although its on-route projection would not", () => {
    // label box y 104..124 overlaps the node below (y 120..160) by 4 px; projected on the route (y 90..110) it would miss it
    const els = toScene(routeScene(box(170, 104, 60, 20), box(170, 120, 60, 40)));
    expect(codesOf(els)).toContain("label-on-node");
    const legacy = toScene(routeScene(box(170, 104, 60, 20), box(170, 120, 60, 40)));
    for (const e of legacy) delete e.exactPlacement;
    expect(codesOf(legacy)).not.toContain("label-on-node");
  });

  it("near miss: a label beside the route that clears the node is no hit, where the projection would be one", () => {
    // node above the route ends at y 95; the label box starts at y 104, 9 px clear. Projected on the route the box is y 90..110: a spurious hit
    const els = toScene(routeScene(box(170, 104, 60, 20)));
    expect(codesOf(els)).not.toContain("label-on-node");
    const legacy = toScene(routeScene(box(170, 104, 60, 20)));
    for (const e of legacy) delete e.exactPlacement;
    expect(codesOf(legacy)).toContain("label-on-node");
  });

  it("never reports label-stored-offset for an exact label", () => {
    expect(codesOf(toScene(routeScene(box(170, 104, 60, 20))))).not.toContain("label-stored-offset");
  });
});

describe("label-far-from-arrow for exact labels", () => {
  const far = (label: NeutralBox) => codesOf(toScene(routeScene(label, box(170, 300, 60, 25)))).includes("label-far-from-arrow");
  it("flags a label box 30 px away from its route", () => expect(far(box(170, 130, 60, 20))).toBe(true));
  it("flags a box just over the tolerance (17 px) and passes one just under it (15 px)", () => {
    expect(far(box(170, 117, 60, 20))).toBe(true);
    expect(far(box(170, 115, 60, 20))).toBe(false);
  });
  it("near miss: beside the route (8 px), straddling it, or sitting on it", () => {
    expect(far(box(170, 108, 60, 20))).toBe(false);
    expect(far(box(170, 90, 60, 20))).toBe(false);
    expect(far(box(170, 85, 60, 30))).toBe(false);
  });
  it("still flags an arrow with no segment to sit on", () => {
    const n = routeScene(box(170, 104, 60, 20));
    n.edges[0]!.poly = [[40, 100], [40, 100]];
    expect(codesOf(toScene(n))).toContain("label-far-from-arrow");
  });
  it("leaves the Excalidraw rule alone: a bound text without exactPlacement is measured from its center, 2 px", () => {
    const els = toScene(routeScene(box(170, 104, 60, 20)));
    const t = els.find((e) => e.id === "edge-label-0")!;
    delete t.exactPlacement;
    t.labelPosition = 1.4;
    expect(codesOf(els)).toContain("label-far-from-arrow");
  });
});

describe("arrowheads-crowded follows the engine's arrowhead breadth", () => {
  /** Two arrows from nodes above end on node H at x = 100 and 100 + gap. */
  function heads(gap: number, headWidth?: number): NeutralScene {
    return {
      nodes: [
        { id: "H", kind: "node", box: box(0, 200, 300, 40), shape: "rectangle" },
        { id: "A", kind: "node", box: box(60, 0, 40, 40), shape: "rectangle" },
        { id: "B", kind: "node", box: box(100 + gap - 20, 0, 40, 40), shape: "rectangle" },
      ],
      edges: [
        { id: "a", src: "A", dst: "H", poly: [[100, 40], [100, 200]] },
        { id: "b", src: "B", dst: "H", poly: [[100 + gap, 40], [100 + gap, 200]] },
      ],
      labels: [],
      headWidth,
    };
  }
  const crowded = (gap: number, headWidth?: number) => codesOf(toScene(heads(gap, headWidth))).includes("arrowheads-crowded");

  it("keeps 18 px for Excalidraw-sized heads (no breadth given)", () => {
    expect(crowded(17)).toBe(true);
    expect(crowded(19)).toBe(false);
  });
  it("Mermaid heads (8 px): the limit is 14 px", () => {
    expect(crowded(13, HEAD_WIDTH.mermaid)).toBe(true);
    expect(crowded(15, HEAD_WIDTH.mermaid)).toBe(false);
    expect(crowded(15)).toBe(true); // the same geometry with Excalidraw-sized heads is crowded
  });
  it("D2 heads (12 px): the limit is 18 px, like Excalidraw", () => {
    expect(crowded(17, HEAD_WIDTH.d2)).toBe(true);
    expect(crowded(19, HEAD_WIDTH.d2)).toBe(false);
  });
});

describe("polylineRectDist", () => {
  const r = rectOf(10, 10, 20, 10);
  it("is 0 when the polyline enters or touches the rect", () => {
    expect(polylineRectDist([[0, 15], [40, 15]], r)).toBe(0);
    expect(polylineRectDist([[20, 0], [20, 10]], r)).toBe(0);
    expect(polylineRectDist([[20, 15], [25, 16]], r)).toBe(0);
  });
  it("measures side and corner distances, and the nearest of several segments", () => {
    expect(polylineRectDist([[0, 30], [40, 30]], r)).toBe(10);
    expect(polylineRectDist([[33, 24], [60, 24]], r)).toBeCloseTo(5, 5);
    expect(polylineRectDist([[0, 100], [0, 60], [0, 22]], r)).toBeCloseTo(Math.hypot(10, 2), 5);
  });
  it("handles degenerate input", () => {
    expect(polylineRectDist([], r)).toBe(Infinity);
    expect(polylineRectDist([[0, 15]], r)).toBe(10);
  });
});
