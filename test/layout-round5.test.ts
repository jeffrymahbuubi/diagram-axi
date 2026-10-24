// Layout round 5: arrowheads stay visible (no label or arrow over a head), parallel and reciprocal edges keep distinct
// heads, nothing hugs its own node, dashed / dotted arrows keep a solid head. Run on the reviewer's named cases.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import type { Direction } from "../src/dsl/ast.js";
import { layout } from "../src/layout/dagre-layout.js";
import { headFootprint, headFootprints, overlapArea } from "../src/layout/route-util.js";
import { analyzeScene } from "../src/quality/analyze.js";
import { buildScene } from "../src/scene/build.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = (name: string): string => readFileSync(join(here, "qa", "corpus", `${name}.exd`), "utf8");

function sceneOf(source: string, direction: Direction) {
  const { graph } = parse(source);
  const result = layout({ graph, direction });
  return { graph, result, scene: buildScene(graph, result) };
}
const codes = (source: string, direction: Direction): string[] => analyzeScene(sceneOf(source, direction).scene as never).findings.map((f) => f.code);

describe("headFootprint", () => {
  it("is 18 px long behind the tip and 16 px wide", () => {
    const b = headFootprint([{ x: 0, y: 0 }, { x: 0, y: 100 }], true)!;
    expect(b).toEqual({ x: -8, y: 82, w: 16, h: 18 });
    const c = headFootprint([{ x: 0, y: 0 }, { x: 100, y: 0 }], false)!;
    expect(c).toEqual({ x: 0, y: -8, w: 18, h: 16 });
  });
  it("skips ends without a head and degenerate routes", () => {
    expect(headFootprints([{ x: 0, y: 0 }, { x: 0, y: 50 }], [false, false])).toEqual([]);
    expect(headFootprints([{ x: 0, y: 0 }, { x: 0, y: 50 }], [false, true])).toHaveLength(1);
    expect(headFootprint([{ x: 3, y: 3 }, { x: 3, y: 3 }], true)).toBeUndefined();
  });
});

describe.each([
  ["edge-triple-parallel", "DOWN"],
  ["edge-triple-parallel", "UP"],
  ["edge-multi-edge-k5-mixed", "DOWN"],
  ["edge-multi-edge-k5-mixed", "UP"],
  ["day-multi-agent-orchestration", "UP"],
] as const)("round 5 case %s (%s)", (name, direction) => {
  const source = corpus(name);
  const { graph, result } = sceneOf(source, direction);

  it("no label lies over an arrowhead (any edge's)", () => {
    for (const e of result.edges) {
      const heads: [boolean, boolean] = graph.edges[e.index]!.arrow === "both" ? [true, true] : graph.edges[e.index]!.arrow === "line" ? [false, false] : [false, true];
      for (const foot of headFootprints(e.points, heads)) {
        for (const other of result.edges) {
          if (!other.label) continue;
          expect(overlapArea(foot, other.label), `edge ${e.index} head under the label of edge ${other.index}`).toBeLessThanOrEqual(0.2 * foot.w * foot.h);
        }
      }
    }
  });

  it("the checker finds no hidden arrowhead, no run along an own node and no HARD defect", () => {
    const found = codes(source, direction);
    expect(found).not.toContain("arrowhead-covered");
    expect(found).not.toContain("arrow-hugs-own-node");
    expect(found).not.toContain("label-covers-own-arrow");
  });
});

describe("dashed and dotted arrows", () => {
  it("get a filled triangle head, solid arrows keep the open one", () => {
    const { scene } = sceneOf("dir DOWN\na[A]\nb[B]\na -> b\na --> b\na -.-> b\n", "DOWN");
    const heads = scene.elements.filter((e) => e.type === "arrow").map((e) => (e as { endArrowhead: string | null }).endArrowhead);
    expect(heads).toEqual(["arrow", "triangle", "triangle"]);
  });
});

describe("rank gap for long labels", () => {
  it("grows with a wide label along a horizontal flow, so the label hides at most about 60% of the run", () => {
    const wide = "dir RIGHT\na[A]\nb[B]\na -> b : a label that is several words long and wraps\n";
    const r = layout({ graph: parse(wide).graph, direction: "RIGHT" });
    const e = r.edges[0]!;
    const run = Math.abs(e.points[e.points.length - 1]!.x - e.points[0]!.x);
    expect(e.label!.w / run).toBeLessThan(0.68);
  });
});
