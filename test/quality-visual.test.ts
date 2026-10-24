// Round 4 visual rules (src/quality/rules-visual.ts): a positive and a near-miss synthetic scene for each rule.
// Scenes are hand-built so every distance is exact; thresholds are TOL_VISUAL (calibrated on the vision-reviewed renders).

import { describe, expect, it } from "vitest";
import { RULES, analyzeScene } from "../src/quality/analyze.js";
import { TOL_VISUAL, VISUAL_RULES, VISUAL_RULES_SOFT } from "../src/quality/rules-visual.js";

type El = Record<string, any>;
type P = [number, number];

const node = (id: string, x: number, y: number, w = 100, h = 60): El => ({ id: `node-${id}`, type: "rectangle", x, y, width: w, height: h, groupIds: [] });
function arrow(id: string, pts: P[], from?: string, to?: string, opts: { startHead?: boolean } = {}): El {
  const [x, y] = pts[0]!;
  return {
    id,
    type: "arrow",
    x,
    y,
    width: 0,
    height: 0,
    points: pts.map(([px, py]) => [px - x, py - y]),
    startBinding: from ? { elementId: `node-${from}` } : null,
    endBinding: to ? { elementId: `node-${to}` } : null,
    startArrowhead: opts.startHead ? "arrow" : null,
    endArrowhead: "arrow",
    roundness: null,
  };
}
const label = (arrowId: string, text: string, w: number, h: number, labelPosition?: number): El => ({
  id: `label-${arrowId}`,
  type: "text",
  x: 0,
  y: 0,
  width: w,
  height: h,
  text,
  containerId: arrowId,
  ...(labelPosition === undefined ? {} : { labelPosition }),
});
const codes = (elements: El[]): string[] => analyzeScene({ elements: elements as never }).findings.map((f) => f.code);
const has = (elements: El[], code: string): boolean => codes(elements).includes(code);

describe("visual rules registry", () => {
  it("ships every visual rule SOFT with a plannedSeverity", () => {
    expect(VISUAL_RULES_SOFT).toBe(true);
    for (const code of Object.keys(VISUAL_RULES)) {
      expect(RULES[code], code).toBeDefined();
      expect(RULES[code]![0], `${code} severity`).toBe("soft");
      expect(RULES[code]![2], `${code} plannedSeverity`).toBeDefined();
    }
    expect(Object.keys(VISUAL_RULES).sort()).toEqual([
      "arrow-hugs-own-node",
      "arrowhead-covered",
      "arrowhead-near-tail",
      "arrowheads-close",
      "arrowheads-cross",
      "arrows-end-to-end",
      "label-at-crossing",
      "label-covers-own-arrow",
      "label-dominates-edge",
      "labels-side-by-side",
      "node-edge-graze",
      "short-final-segment",
      "track-spacing",
    ]);
  });
});

describe("arrowhead-near-tail", () => {
  // B's top side is y = 100; A feeds it from above, C leaves it (tail) from the same side.
  const base = [node("a", 0, 0, 100, 40), node("b", 0, 100, 200, 60), node("c", 120, 220, 80, 40)];
  it("flags an arrowhead tip 20 px from another arrow's start on the same node", () => {
    const els = [...base, arrow("edge-0", [[50, 40], [50, 100]], "a", "b"), arrow("edge-1", [[70, 100], [70, 130], [160, 130], [160, 220]], "b", "c")];
    expect(has(els, "arrowhead-near-tail")).toBe(true);
  });
  it("flags a tail 26 px from the tip (the pitch is 28 px now) and accepts 30 px", () => {
    const at = (x: number) => [...base, arrow("edge-0", [[50, 40], [50, 100]], "a", "b"), arrow("edge-1", [[x, 100], [x, 130], [160, 130], [160, 220]], "b", "c")];
    expect(has(at(76), "arrowhead-near-tail")).toBe(true);
    expect(has(at(80), "arrowhead-near-tail")).toBe(false);
  });
  it("accepts the same arrows 40 px apart (and a tail on another node)", () => {
    const apart = [...base, arrow("edge-0", [[50, 40], [50, 100]], "a", "b"), arrow("edge-1", [[90, 100], [90, 130], [160, 130], [160, 220]], "b", "c")];
    expect(has(apart, "arrowhead-near-tail")).toBe(false);
    expect(TOL_VISUAL.tailNear).toBe(28);
  });
});

describe("arrowheads-cross", () => {
  const base = [node("a", 0, 0, 40, 40), node("d", 160, 0, 40, 40), node("b", 0, 200, 200, 60)];
  it("flags two heads whose final segments cross in an X on one node", () => {
    const els = [...base, arrow("edge-0", [[150, 100], [50, 200]], "d", "b"), arrow("edge-1", [[50, 100], [150, 200]], "a", "b")];
    expect(has(els, "arrowheads-cross")).toBe(true);
  });
  it("accepts two parallel arrivals", () => {
    const els = [...base, arrow("edge-0", [[50, 100], [50, 200]], "a", "b"), arrow("edge-1", [[150, 100], [150, 200]], "d", "b")];
    expect(has(els, "arrowheads-cross")).toBe(false);
  });
  it("flags another arrow crossing the 20 px behind an arrowhead, accepts it 30 px behind", () => {
    const head = arrow("edge-0", [[50, 40], [50, 100]], "a", "b");
    expect(has([...base, head, arrow("edge-1", [[0, 90], [100, 90]])], "arrowheads-cross")).toBe(true);
    expect(has([...base, head, arrow("edge-1", [[0, 70], [100, 70]])], "arrowheads-cross")).toBe(false);
  });
  it("ignores a crossing farther than 100 px from the tips", () => {
    const els = [...base, arrow("edge-0", [[190, -20], [10, 200]], "d", "b"), arrow("edge-1", [[10, -20], [190, 200]], "a", "b")];
    expect(has(els, "arrowheads-cross")).toBe(false);
  });
});

describe("label-at-crossing", () => {
  const own = (): El[] => [arrow("edge-0", [[0, 100], [200, 100]]), label("edge-0", "go", 40, 20, 0.5)];
  it("flags a label sitting on a crossing of its arrow with another arrow", () => {
    expect(has([...own(), arrow("edge-1", [[100, 0], [100, 200]])], "label-at-crossing")).toBe(true);
  });
  it("accepts the label 40 px from the crossing", () => {
    const els = [arrow("edge-0", [[0, 100], [200, 100]]), label("edge-0", "go", 40, 20, 0.2), arrow("edge-1", [[100, 0], [100, 200]])];
    expect(has(els, "label-at-crossing")).toBe(false);
  });
  it("flags a label touched (8 px grown) by two foreign arrows", () => {
    const els = [...own(), arrow("edge-1", [[0, 116], [200, 116]]), arrow("edge-2", [[0, 84], [200, 84]])];
    expect(has(els, "label-at-crossing")).toBe(true);
  });
  it("accepts one foreign arrow close by and a second one far away", () => {
    const els = [...own(), arrow("edge-1", [[0, 116], [200, 116]]), arrow("edge-2", [[0, 40], [200, 40]])];
    expect(has(els, "label-at-crossing")).toBe(false);
  });
});

describe("label-covers-own-arrow", () => {
  it("flags a label larger than its short arrow", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 50]]), label("edge-0", "a very long wrapped label", 100, 60, 0.5)], "label-covers-own-arrow")).toBe(true);
  });
  it("flags a label sitting on the route just behind the arrowhead", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 100]]), label("edge-0", "late", 40, 20, 0.9)], "label-covers-own-arrow")).toBe(true);
  });
  it("accepts a label mid-route on a long arrow", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 400]]), label("edge-0", "mid", 40, 20, 0.5)], "label-covers-own-arrow")).toBe(false);
  });
  it("accepts a label ending 40 px before the tip", () => {
    // label centred at 0.5 of a 100 px arrow spans y 40..60; the 16 px behind the tip are y 84..100
    expect(has([arrow("edge-0", [[0, 0], [0, 100]]), label("edge-0", "mid", 40, 20, 0.5)], "label-covers-own-arrow")).toBe(false);
  });
});

describe("short-final-segment", () => {
  it("flags a final segment shorter than an arrowhead", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 100], [40, 100], [40, 108]])], "short-final-segment")).toBe(true);
  });
  it("flags a hairpin last bend close to the tip", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 100], [0, 70]])], "short-final-segment")).toBe(true);
  });
  it("accepts a 30 px final segment after an ordinary elbow", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 100], [40, 100], [40, 130]])], "short-final-segment")).toBe(false);
  });
  it("accepts a 24 px final segment (the threshold itself)", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 100], [40, 100], [40, 124]])], "short-final-segment")).toBe(false);
  });
  it("flags a 20 px final segment (the layout used to stub 12 px)", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 100], [40, 100], [40, 120]])], "short-final-segment")).toBe(true);
  });
  it("ignores a short segment at an end without an arrowhead", () => {
    const a = arrow("edge-0", [[0, 0], [0, 100], [40, 100], [40, 108]]);
    a.endArrowhead = null;
    expect(has([a], "short-final-segment")).toBe(false);
  });
});

describe("node-edge-graze", () => {
  const mid = node("m", 100, 100, 60, 100); // left side x = 100, y 100..200
  it("flags an arrow running 6 px beside a node that is not its end", () => {
    expect(has([mid, arrow("edge-0", [[94, 0], [94, 300]])], "node-edge-graze")).toBe(true);
  });
  it("flags an arrow running 10 px beside a node (the clearance is 12 px) and accepts 14 px", () => {
    expect(has([mid, arrow("edge-0", [[90, 0], [90, 300]])], "node-edge-graze")).toBe(true);
    expect(has([mid, arrow("edge-0", [[86, 0], [86, 300]])], "node-edge-graze")).toBe(false);
  });
  it("flags an arrow running 8 px inside a zone border and accepts 16 px", () => {
    const zone = { id: "zone-g-z", type: "rectangle", x: 0, y: 0, width: 300, height: 300, groupIds: [] };
    expect(has([zone, arrow("edge-0", [[8, 50], [8, 250]])], "node-edge-graze")).toBe(true);
    expect(has([zone, arrow("edge-0", [[16, 50], [16, 250]])], "node-edge-graze")).toBe(false);
  });
  it("accepts the same arrow 20 px away", () => {
    expect(has([mid, arrow("edge-0", [[80, 0], [80, 300]])], "node-edge-graze")).toBe(false);
  });
  it("accepts a brush shorter than 24 px along the side", () => {
    expect(has([mid, arrow("edge-0", [[94, 0], [94, 110]])], "node-edge-graze")).toBe(false);
  });
  it("accepts an arrow that ends at the node", () => {
    expect(has([mid, node("s", 0, 0, 60, 20), arrow("edge-0", [[94, 20], [94, 300]], "s", "m")], "node-edge-graze")).toBe(false);
  });
});

describe("track-spacing", () => {
  it("flags parallel runs of two arrows 10 px apart", () => {
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[0, 10], [100, 10]])], "track-spacing")).toBe(true);
  });
  it("accepts tracks 20 px apart", () => {
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[0, 20], [100, 20]])], "track-spacing")).toBe(false);
  });
  it("accepts tracks that overlap for only 20 px", () => {
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[80, 10], [200, 10]])], "track-spacing")).toBe(false);
  });
});

// ---- layout round 5: hidden / merged arrowheads, labels that swallow their edge, runs along an own node ----

describe("arrowhead-covered", () => {
  // A (top) feeds B (bottom): the head sits at y = 100, its footprint is y 82..100, x 42..58.
  const base = [node("a", 0, 0, 100, 40), node("b", 0, 100, 200, 60)];
  const feed = () => arrow("edge-0", [[50, 40], [50, 100]], "a", "b");
  it("flags an edge label lying over the arrowhead", () => {
    expect(has([...base, feed(), label("edge-0", "late", 40, 20, 0.85)], "arrowhead-covered")).toBe(true);
  });
  it("accepts a label at mid-route", () => {
    expect(has([...base, feed(), label("edge-0", "mid", 40, 20, 0.3)], "arrowhead-covered")).toBe(false);
  });
  it("flags another arrow running through the arrowhead", () => {
    expect(has([...base, feed(), arrow("edge-1", [[0, 90], [100, 90]])], "arrowhead-covered")).toBe(true);
  });
  it("accepts an arrow passing 30 px behind the arrowhead", () => {
    expect(has([...base, feed(), arrow("edge-1", [[0, 60], [100, 60]])], "arrowhead-covered")).toBe(false);
  });
});

describe("arrowheads-close", () => {
  const base = [node("a", 0, 0, 40, 40), node("b", 0, 100, 240, 60)];
  const into = (x: number, id: string) => arrow(id, [[x, 40], [x, 100]], "a", "b");
  it("flags two heads 20 px apart on one node", () => {
    expect(has([...base, into(20, "edge-0"), into(40, "edge-1")], "arrowheads-close")).toBe(true);
  });
  it("accepts heads 30 px apart", () => {
    expect(has([...base, into(20, "edge-0"), into(50, "edge-1")], "arrowheads-close")).toBe(false);
    expect(TOL_VISUAL.headPitch).toBe(28);
  });
});

describe("labels-side-by-side", () => {
  const lane = (x: number, id: string, at = 0.5): El[] => [arrow(id, [[x, 0], [x, 200]]), label(id, "x2", 30, 20, at)];
  it("flags labels of two parallel lanes 10 px apart at the same height", () => {
    expect(has([...lane(0, "edge-0"), ...lane(40, "edge-1")], "labels-side-by-side")).toBe(true);
  });
  it("flags labels 20 px apart horizontally and 30 px vertically", () => {
    expect(has([...lane(0, "edge-0"), ...lane(50, "edge-1", 0.65)], "labels-side-by-side")).toBe(true);
  });
  it("accepts labels staggered 60 px apart vertically", () => {
    expect(has([...lane(0, "edge-0"), ...lane(40, "edge-1", 0.9)], "labels-side-by-side")).toBe(false);
  });
  it("accepts labels on lanes 70 px apart", () => {
    expect(has([...lane(0, "edge-0"), ...lane(100, "edge-1")], "labels-side-by-side")).toBe(false);
  });
});

describe("label-dominates-edge", () => {
  it("flags a label hiding 75% of a short arrow", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 80]]), label("edge-0", "a long label", 40, 60, 0.5)], "label-dominates-edge")).toBe(true);
  });
  it("accepts a label hiding half of the arrow", () => {
    expect(has([arrow("edge-0", [[0, 0], [0, 120]]), label("edge-0", "mid", 40, 60, 0.5)], "label-dominates-edge")).toBe(false);
  });
});

describe("arrow-hugs-own-node", () => {
  const a = node("a", 0, 100, 100, 60); // bottom side y = 160
  const b = node("b", 300, 0, 100, 60);
  it("flags an arrow that leaves a node and runs 3 px beside its side for 100 px", () => {
    expect(has([a, b, arrow("edge-0", [[50, 160], [50, 163], [150, 163], [150, 30], [300, 30]], "a", "b")], "arrow-hugs-own-node")).toBe(true);
  });
  it("accepts the same detour 30 px below the node", () => {
    expect(has([a, b, arrow("edge-0", [[50, 160], [50, 190], [150, 190], [150, 30], [300, 30]], "a", "b")], "arrow-hugs-own-node")).toBe(false);
  });
});

describe("arrows-end-to-end", () => {
  it("flags two arrows that meet on one line (head of one at the tail of the other)", () => {
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[100, 0], [200, 0]])], "arrows-end-to-end")).toBe(true);
  });
  it("flags collinear arrows 8 px apart along the line, accepts 14 px", () => {
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[108, 0], [200, 0]])], "arrows-end-to-end")).toBe(true);
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[114, 0], [200, 0]])], "arrows-end-to-end")).toBe(false);
  });
  it("accepts parallel arrows 20 px apart", () => {
    expect(has([arrow("edge-0", [[0, 0], [100, 0]]), arrow("edge-1", [[100, 20], [200, 20]])], "arrows-end-to-end")).toBe(false);
  });
});
