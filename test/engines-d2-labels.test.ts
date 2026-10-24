// D2 label geometry and post-layout label placement (U10): where D2 draws a label, and moving labels off other edges.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { d2Engine } from "../src/engines/d2/index.js";
import { diagramToNeutral } from "../src/engines/d2/geometry.js";
import { routeLabelBox } from "../src/engines/d2/label-box.js";
import { placeLabels } from "../src/engines/d2/label-place.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { d2Compile, d2RenderSvg, disposeD2, type D2Diagram } from "../src/engines/d2/wasm.js";
import { analyzeScene } from "../src/quality/analyze.js";
import { toScene } from "../src/engines/neutral.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const golden = (n: string): string => readFileSync(here(`./golden/d2/${n}`), "utf8");

afterAll(async () => {
  await disposeD2();
});

const route: [number, number][] = [[47.5, 78], [47.5, 239]];
const center = (b: { x: number; y: number; w: number; h: number }): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];

describe("routeLabelBox follows D2's lib/label", () => {
  it("INSIDE_MIDDLE_* sit on the route at 1/4, 1/2, 3/4 of its length", () => {
    const at = (pos: string) => center(routeLabelBox(route, 71, 21, pos, 0)!);
    expect(at("INSIDE_MIDDLE_CENTER")[0]).toBeCloseTo(47.5, 5);
    expect(at("INSIDE_MIDDLE_CENTER")[1]).toBeCloseTo(78 + 161 / 2, 5);
    expect(at("INSIDE_MIDDLE_LEFT")[1]).toBeCloseTo(78 + 161 / 4, 5);
    expect(at("INSIDE_MIDDLE_RIGHT")[1]).toBeCloseTo(78 + (161 * 3) / 4, 5);
  });

  it("UNLOCKED_* use the percentage; TOP is the left of the travel direction (+x going down), BOTTOM the right", () => {
    const mid = center(routeLabelBox(route, 71, 21, "UNLOCKED_MIDDLE", 0.2)!);
    expect(mid[0]).toBeCloseTo(47.5, 5);
    expect(mid[1]).toBeCloseTo(78 + 0.2 * 161, 5);
    // beside the line: half stroke + 5 px padding + half the label width, as measured on D2's SVG (text x 89.5 / 5.5)
    const top = center(routeLabelBox(route, 71, 21, "UNLOCKED_TOP", 0.5)!);
    const bottom = center(routeLabelBox(route, 71, 21, "UNLOCKED_BOTTOM", 0.5)!);
    expect(Math.abs(top[0] - 89.5)).toBeLessThan(1);
    expect(Math.abs(bottom[0] - 5.5)).toBeLessThan(1);
    // going right, TOP is above
    const above = center(routeLabelBox([[0, 100], [200, 100]], 40, 20, "OUTSIDE_TOP_CENTER", 0)!);
    expect(above[0]).toBeCloseTo(100, 5);
    expect(above[1]).toBeLessThan(100 - 10);
  });

  it("agrees with where D2 draws the label (mask rect of the rendered SVG)", async () => {
    const c = await d2Compile('direction: down\na -> b: "hello there"\n', { layout: "elk" });
    const e = c.diagram.connections[0]!;
    for (const [position, percentage] of [["UNLOCKED_MIDDLE", 0.3], ["UNLOCKED_TOP", 0.7], ["UNLOCKED_BOTTOM", 0.4], ["INSIDE_MIDDLE_LEFT", 0]] as const) {
      e.labelPosition = position;
      e.labelPercentage = percentage;
      const svg = await d2RenderSvg(c);
      const m = /<mask [^>]*>\s*<rect [^>]*\/?>(?:<\/rect>)?\s*<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(\d+)" height="(\d+)"/.exec(svg)!;
      const [mx, my, mw, mh] = m.slice(1).map(Number) as [number, number, number, number];
      const box = routeLabelBox(e.route.map((p): [number, number] => [p.x, p.y]), e.labelWidth!, e.labelHeight!, position, percentage, e.strokeWidth)!;
      // the mask is the label box padded by 2 px left and right, rounded to whole px
      expect(Math.abs(box.x + box.w / 2 - (mx + mw / 2))).toBeLessThan(1.5);
      expect(Math.abs(box.y + box.h / 2 - (my + mh / 2))).toBeLessThan(1.5);
    }
  });
});

describe("placeLabels", () => {
  const findings = (diagram: D2Diagram) => {
    const { neutral } = diagramToNeutral(diagram);
    const g = analyzeScene({ elements: toScene(neutral) });
    return g.findings.filter((f) => f.severity === "hard").map((f) => f.code);
  };

  it("moves a label off a node and off a foreign edge, and the checker agrees", async () => {
    const compiled = await d2Compile(golden("day-microservices-RIGHT.d2"), { layout: "elk" });
    const before = findings(compiled.diagram);
    expect(before).toContain("label-on-node");
    const stats = placeLabels(compiled.diagram);
    expect(stats.moved).toBeGreaterThan(0);
    const after = findings(compiled.diagram);
    expect(after.filter((c) => c.startsWith("label-"))).toEqual([]);
  });

  it("is idempotent: a second pass moves nothing further", async () => {
    const compiled = await d2Compile(golden("day-microservices-RIGHT.d2"), { layout: "elk" });
    placeLabels(compiled.diagram);
    const snapshot = JSON.stringify(compiled.diagram.connections.map((c) => [c.labelPosition, c.labelPercentage]));
    placeLabels(compiled.diagram);
    expect(JSON.stringify(compiled.diagram.connections.map((c) => [c.labelPosition, c.labelPercentage]))).toBe(snapshot);
  });

  it("leaves a clean diagram as D2 drew it", async () => {
    const compiled = await d2Compile("direction: right\na -> b: hello\nb -> c: bye\n", { layout: "elk" });
    const stats = placeLabels(compiled.diagram);
    expect(stats.moved).toBe(0);
    expect(compiled.diagram.connections.every((c) => c.labelPosition === "INSIDE_MIDDLE_CENTER")).toBe(true);
  });

  it("finds a spot in 1 % steps when a label is nearly as wide as the gap between two nodes", () => {
    // the edge runs between node p (right edge 520) and node q (left edge 600): 80 px of clear line for a 73 px label,
    // whose only fit is near 57.5 % of the route, between the 5 % grid points
    const shape = (id: string, x: number, y: number, w: number, h: number) => ({ id, type: "rectangle", pos: { x, y }, width: w, height: h, level: 1 });
    const d = {
      shapes: [shape("a", 0, 150, 100, 60), shape("p", 105, 100, 415, 160), shape("q", 600, 100, 295, 160), shape("b", 900, 150, 100, 60)],
      connections: [{ id: "(a -> b)[0]", src: "a", dst: "b", dstArrow: "triangle", label: "OrderPlaced", labelWidth: 73, labelHeight: 18, labelPosition: "INSIDE_MIDDLE_CENTER", labelPercentage: 0, route: [{ x: 100, y: 180 }, { x: 900, y: 180 }] }],
    } as unknown as D2Diagram;
    expect(placeLabels(d).moved).toBe(1);
    const c = d.connections[0]!;
    expect(c.labelPosition).toBe("UNLOCKED_MIDDLE");
    const x = 100 + c.labelPercentage! * 800;
    expect(x - 36.5).toBeGreaterThanOrEqual(519);
    expect(x + 36.5).toBeLessThanOrEqual(601);
    expect(Math.round(c.labelPercentage! * 100) % 5).not.toBe(0);
  });

  it("renderD2 draws the moved labels, and its geometry matches the drawing", async () => {
    const r = await renderD2(golden("day-microservices-RIGHT.d2"), { layout: "elk" });
    const els = d2Engine.geometry!(r).elements;
    const hard = analyzeScene({ elements: els }).findings.filter((f) => f.severity === "hard" && f.code.startsWith("label-"));
    expect(hard).toEqual([]);
    expect(r.svg).toContain("OrderPlaced");
  });

  it("leaves sequence diagrams alone", async () => {
    const r = await renderD2("shape: sequence_diagram\nalice -> bob: hi\nbob -> alice: back\n");
    expect(r.kind).toBe("sequence");
  });
});
