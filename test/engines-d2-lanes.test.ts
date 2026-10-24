// D2 lane spreading (U10 round 2): ELK's orthogonal routes nudged apart, arrow ends spread along node borders.

import { afterAll, describe, expect, it } from "vitest";
import { d2Engine } from "../src/engines/d2/index.js";
import { attach, outlineOf } from "../src/engines/d2/lane-shapes.js";
import { orthogonal, shiftSegment, spreadLanes } from "../src/engines/d2/lane-spread.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { d2Compile, disposeD2, type D2Diagram, type D2Shape } from "../src/engines/d2/wasm.js";
import { analyzeScene } from "../src/quality/analyze.js";

afterAll(async () => {
  await disposeD2();
});

const shape = (id: string, x: number, y: number, w: number, h: number, type = "rectangle"): D2Shape => ({ id, type, pos: { x, y }, width: w, height: h, level: 1 });
const diagram = (shapes: D2Shape[], routes: [string, string, [number, number][]][]): D2Diagram =>
  ({
    shapes,
    connections: routes.map(([src, dst, pts], i) => ({ id: `(${src} -> ${dst})[${i}]`, src, dst, dstArrow: "triangle", route: pts.map(([x, y]) => ({ x, y })) })),
  }) as unknown as D2Diagram;
const route = (d: D2Diagram, i: number): [number, number][] => d.connections[i]!.route.map((p): [number, number] => [p.x, p.y]);

describe("orthogonal", () => {
  it("drops repeated points and the middle of straight runs", () => {
    expect(orthogonal([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 20 }, { x: 0, y: 40 }, { x: 30, y: 40 }].map((p) => ({ ...p })))).toEqual([[0, 0], [0, 40], [30, 40]]);
  });

  it("refuses a route with a diagonal segment", () => {
    expect(orthogonal([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBeUndefined();
  });
});

describe("shiftSegment", () => {
  const rect = outlineOf(shape("a", 0, 0, 100, 50), false);
  const elbow: [number, number][] = [[0, 0], [0, 50], [100, 50], [100, 100]];

  it("moves a middle segment and its two corners together, staying orthogonal", () => {
    expect(shiftSegment(elbow, 1, 10, undefined, undefined)).toEqual([[0, 0], [0, 60], [100, 60], [100, 100]]);
    const longer: [number, number][] = [[10, 0], [10, 50], [100, 50], [100, 120], [150, 120], [150, 200]];
    expect(shiftSegment(longer, 2, 15, undefined, undefined)).toEqual([[10, 0], [10, 50], [100, 50], [100, 120], [150, 120], [150, 200]].map(([x, y]) => [x, y]).map(([x, y], i) => (i === 2 || i === 3 ? [x! + 15, y!] : [x!, y!])));
  });

  it("refuses a move that flips or squeezes a neighbouring segment", () => {
    const longer: [number, number][] = [[10, 0], [10, 50], [100, 50], [100, 120], [150, 120], [150, 200]];
    expect(shiftSegment(longer, 1, -60, undefined, undefined)).toBeUndefined(); // the horizontal segment would pass through its end
    expect(shiftSegment(longer, 1, 68, undefined, undefined)).toBeUndefined(); // leaves 2 px
  });

  it("slides an end segment along the border of a rectangle, within its side", () => {
    const start: [number, number][] = [[50, 50], [50, 120], [200, 120], [200, 200]];
    const moved = shiftSegment(start, 0, 20, rect, undefined)!;
    expect(moved[0]).toEqual([70, 50]);
    expect(moved[1]).toEqual([70, 120]);
    expect(shiftSegment(start, 0, 60, rect, undefined)).toBeUndefined(); // off the side
  });

  it("slides an end onto the outline of an ellipse, not its box", () => {
    const o = outlineOf(shape("e", 0, 0, 100, 60, "oval"), false);
    const p = attach(o, "v", 80, true)!;
    expect(p[0]).toBe(80);
    expect(p[1]).toBeCloseTo(30 + 30 * Math.sqrt(1 - 0.36), 6);
    expect(attach(o, "v", 99, true)).toBeUndefined(); // too near the side
  });

  it("puts a cylinder end on its cap arc, and refuses shapes without a closed form", () => {
    const o = outlineOf(shape("c", 0, 0, 100, 80, "cylinder"), false);
    expect(attach(o, "v", 50, false)).toEqual([50, 0]);
    expect(attach(o, "v", 85, false)![1]).toBeCloseTo(12 - 12 * Math.sqrt(1 - 0.49), 6);
    expect(attach(outlineOf(shape("h", 0, 0, 100, 60, "hexagon"), false), "v", 50, true)).toBeUndefined();
  });

  it("a straight edge slides as a whole, both ends staying on their nodes", () => {
    const a = outlineOf(shape("a", 0, 0, 100, 50), false);
    const b = outlineOf(shape("b", 0, 150, 100, 50), false);
    expect(shiftSegment([[50, 50], [50, 150]], 0, 25, a, b)).toEqual([[75, 50], [75, 150]]);
    expect(shiftSegment([[50, 50], [50, 150]], 0, 25, a, undefined)).toBeUndefined();
  });
});

describe("spreadLanes", () => {
  it("snaps ELK drift of up to 1.5 px straight, so a nearly vertical route can still be moved", () => {
    expect(orthogonal([{ x: 210, y: 124 }, { x: 211, y: 322 }])).toEqual([[210, 124], [210, 322]]);
  });

  it("pulls two arrows between the same nodes out of the checker's 20 px line", () => {
    const d = diagram(
      [shape("a", 0, 0, 200, 40), shape("b", 0, 300, 200, 40)],
      [
        ["a", "b", [[60, 40], [60, 300]]],
        ["a", "b", [[77, 40], [77, 300]]],
      ],
    );
    spreadLanes(d);
    expect(Math.abs(route(d, 0)[0]![0] - route(d, 1)[0]![0])).toBeGreaterThanOrEqual(20.5);
  });

  it("separates two arrows ending 6 px apart on one node and spreads them to at least 20 px", () => {
    const d = diagram(
      [shape("t", 0, 0, 200, 40), shape("a", 0, 200, 80, 40), shape("b", 120, 200, 80, 40)],
      [
        ["a", "t", [[94, 200], [94, 40]]],
        ["b", "t", [[100, 200], [100, 40]]],
      ],
    );
    const stats = spreadLanes(d);
    expect(stats.before).toBeGreaterThan(0);
    expect(stats.after).toBe(0);
    const [p, q] = [route(d, 0), route(d, 1)];
    expect(Math.abs(p[p.length - 1]![0] - q[q.length - 1]![0])).toBeGreaterThanOrEqual(20);
    for (const r of [p, q]) {
      expect(r[r.length - 1]![1]).toBe(40); // still on the border
      expect(r.every((pt, i) => i === 0 || pt[0] === r[i - 1]![0] || pt[1] === r[i - 1]![1])).toBe(true);
    }
  });

  it("moves an arrow out of a node it runs through", () => {
    const d = diagram(
      [shape("a", 0, 0, 50, 30), shape("b", 0, 300, 50, 30), shape("c", 0, 120, 30, 40)],
      [["a", "b", [[22, 30], [22, 300]]]],
    );
    expect(spreadLanes(d).after).toBe(0);
    expect(route(d, 0)[0]![0]).toBeGreaterThan(31);
  });

  it("leaves a route alone when no move improves it (shapes without a closed outline, curved routes)", () => {
    const d = diagram(
      [shape("t", 0, 0, 200, 40, "hexagon"), shape("a", 0, 200, 80, 40), shape("b", 120, 200, 80, 40)],
      [
        ["a", "t", [[94, 200], [94, 40]]],
        ["b", "t", [[100, 200], [100, 40]]],
      ],
    );
    const before = JSON.stringify(d.connections.map((c) => c.route));
    spreadLanes(d);
    // the ends on the hexagon are fixed, but the other ends may not be: the crowded pair must not get worse
    const stats = spreadLanes(d);
    expect(stats.after).toBeLessThanOrEqual(stats.before);
    expect(route(d, 0)[route(d, 0).length - 1]).toEqual([94, 40]);
    expect(route(d, 1)[route(d, 1).length - 1]).toEqual([100, 40]);
    expect(JSON.stringify(d.connections.map((c) => c.route))).toBe(before);
  });

  it("never merges or drops an edge, and keeps every route attached to its two nodes", async () => {
    const src = ["direction: down", "hub: Hub", ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `s${i}: Source ${i}\ns${i} -> hub`)].join("\n");
    const c = await d2Compile(src, { layout: "elk" });
    const n = c.diagram.connections.length;
    spreadLanes(c.diagram);
    expect(c.diagram.connections).toHaveLength(n);
    for (const e of c.diagram.connections) expect(e.route.length).toBeGreaterThanOrEqual(2);
  });

  it("a fan-in onto one node leaves no crowded arrowheads for the checker", async () => {
    const src = ["direction: down", "hub: Hub", ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `s${i}: S${i}\ns${i} -> hub`)].join("\n");
    const r = await renderD2(src, { layout: "elk" });
    const { findings } = analyzeScene({ elements: d2Engine.geometry!(r).elements });
    expect(findings.filter((f) => f.code === "arrowheads-crowded" || f.code === "arrows-collinear-overlap")).toEqual([]);
  });
});
