// D2 detour repair (extract hardening F7): an arrow that ELK routed through a node is slid clear or bypassed, accepted
// only when the checker likes the whole diagram better. Geometry tests need no browser and no WASM; the fixtures are two
// real edge orders (shuffles of the extract corpus) whose ELK routes run through a node.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bypass, deepestSegment, detourCandidates, judge, mayRunThrough, reorderEdgeBlocks, repairThroughNodes, throughHits } from "../src/engines/d2/detour.js";
import { diagramToNeutral } from "../src/engines/d2/geometry.js";
import { outlineOf, type Pt } from "../src/engines/d2/lane-shapes.js";
import { placeLabels } from "../src/engines/d2/label-place.js";
import { spreadLanes } from "../src/engines/d2/lane-spread.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { translateGraph } from "../src/engines/d2/translate.js";
import { parse } from "../src/dsl/parser.js";
import { D2_PAD, d2Compile, disposeD2, type D2Diagram, type D2Shape } from "../src/engines/d2/wasm.js";

afterAll(async () => {
  await disposeD2();
});

const shape = (id: string, x: number, y: number, w: number, h: number): D2Shape => ({ id, type: "rectangle", pos: { x, y }, width: w, height: h, level: 1 });
const diagram = (shapes: D2Shape[], routes: [string, string, Pt[]][]): D2Diagram =>
  ({
    shapes,
    connections: routes.map(([src, dst, pts], i) => ({ id: `(${src} -> ${dst})[${i}]`, src, dst, dstArrow: "triangle", route: pts.map(([x, y]) => ({ x, y })) })),
  }) as unknown as D2Diagram;
const route = (d: D2Diagram, i = 0): Pt[] => d.connections[i]!.route.map((p): Pt => [p.x, p.y]);
const orthogonalRoute = (pts: Pt[]): boolean => pts.every((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1]![0]) < 1e-6 || Math.abs(p[1] - pts[i - 1]![1]) < 1e-6);

/** a (top) -> b (bottom) in one column, with a wide node c across the line: no slide can clear it, only a detour. */
const wide = (): D2Diagram => diagram([shape("a", 0, 0, 100, 50), shape("b", 0, 300, 100, 50), shape("c", -40, 150, 180, 60)], [["a", "b", [[50, 50], [50, 300]]]]);

describe("bypass", () => {
  const box = { x: -40, y: 150, w: 180, h: 60 };
  const line: Pt[] = [[50, 50], [50, 300]];

  it("goes round a node beside a vertical segment and returns to its line", () => {
    const left = bypass(line, 0, box, "lo", 12, 12)!;
    expect(left).toEqual([[50, 50], [50, 138], [-52, 138], [-52, 222], [50, 222], [50, 300]]);
    const right = bypass(line, 0, box, "hi", 12, 12)!;
    expect(right[2]).toEqual([152, 138]);
    expect(orthogonalRoute(left) && orthogonalRoute(right)).toBe(true);
  });

  it("keeps both ends of the route", () => {
    const out = bypass(line, 0, box, "hi", 8, 8)!;
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[1]);
  });

  it("works upwards and along a horizontal segment", () => {
    const up = bypass([[50, 300], [50, 50]], 0, box, "lo", 12, 12)!;
    expect(up.map((p) => p[1])).toEqual([300, 222, 222, 138, 138, 50]);
    const across = bypass([[0, 100], [300, 100]], 0, { x: 100, y: 60, w: 60, h: 100 }, "hi", 10, 10)!;
    expect(across).toEqual([[0, 100], [90, 100], [90, 170], [170, 170], [170, 100], [300, 100]]);
  });

  it("refuses when an arrow end would be left without room", () => {
    expect(bypass([[50, 140], [50, 300]], 0, box, "lo", 12, 12)).toBeUndefined(); // starts 10 px above the node
    expect(bypass([[50, 50], [50, 220]], 0, box, "lo", 12, 12)).toBeUndefined(); // ends 10 px below it
  });

  it("detours around the middle segment of a longer route without touching the others", () => {
    const pts: Pt[] = [[0, 0], [0, 40], [50, 40], [50, 300], [200, 300]];
    const out = bypass(pts, 2, box, "hi", 12, 12)!;
    expect(out.slice(0, 3)).toEqual(pts.slice(0, 3));
    expect(out[out.length - 1]).toEqual([200, 300]);
    expect(out.length).toBe(pts.length + 4);
  });
});

describe("detourCandidates", () => {
  it("lists a slide first when the ends can follow, detours (shortest first) otherwise", () => {
    const a = outlineOf(shape("a", 0, 0, 100, 50), false);
    const b = outlineOf(shape("b", 0, 300, 100, 50), false);
    const narrow = { x: 30, y: 150, w: 40, h: 60 };
    const slide = detourCandidates([[50, 50], [50, 300]], 0, narrow, { src: a, dst: b });
    expect(slide[0]).toHaveLength(2);
    expect(slide[0]![0]![0]).toBe(82); // 12 px right of the node (x 30..70)
    expect(slide[0]![1]![0]).toBe(82);
    const blocked = detourCandidates([[50, 50], [50, 300]], 0, { x: -40, y: 150, w: 180, h: 60 }, { src: a, dst: b });
    expect(blocked.length).toBeGreaterThan(2);
    expect(blocked.every((c) => c.length === 6)).toBe(true);
    const lengths = blocked.map((c) => c.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - c[i - 1]![0], p[1] - c[i - 1]![1]) : 0), 0));
    expect(lengths).toEqual([...lengths].sort((p, q) => p - q));
  });
});

describe("repairThroughNodes", () => {
  it("is found by the cheap pre-test and by the checker", () => {
    const d = wide();
    expect(mayRunThrough(d)).toBe(true);
    expect(deepestSegment(route(d), outlineOf(d.shapes[2]!, false)).k).toBe(0);
    const hits = throughHits(diagramToNeutral(d).neutral);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ node: "c" });
    expect(hits[0]!.inside).toBeGreaterThan(50);
  });

  it("goes round the node and the checker finds no HARD defect afterwards", () => {
    const d = wide();
    const stats = repairThroughNodes(d);
    expect(stats).toEqual({ found: 1, repaired: 1 });
    const out = route(d);
    expect(out[0]).toEqual([50, 50]);
    expect(out[out.length - 1]).toEqual([50, 300]);
    expect(orthogonalRoute(out)).toBe(true);
    expect(out.length).toBe(6);
    expect(mayRunThrough(d)).toBe(false);
    const verdict = judge(diagramToNeutral(d).neutral);
    expect(verdict.hits).toEqual([]);
    expect([...verdict.hard.values()].reduce((n, v) => n + v, 0)).toBe(0);
  });

  it("slides a segment clear when a slide is enough (no new corners)", () => {
    const d = diagram([shape("a", 0, 0, 100, 50), shape("b", 0, 300, 100, 50), shape("c", 30, 150, 40, 60)], [["a", "b", [[50, 50], [50, 300]]]]);
    expect(repairThroughNodes(d)).toEqual({ found: 1, repaired: 1 });
    const out = route(d);
    expect(out).toHaveLength(2);
    expect(out[0]![0]).toBe(out[1]![0]);
    expect(Math.abs(out[0]![0]! - 50)).toBeGreaterThan(20);
    expect(throughHits(diagramToNeutral(d).neutral)).toEqual([]);
  });

  it("leaves a clean diagram alone", () => {
    const d = diagram([shape("a", 0, 0, 100, 50), shape("b", 0, 300, 100, 50), shape("c", 200, 150, 40, 60)], [["a", "b", [[50, 50], [50, 300]]]]);
    const before = JSON.stringify(d);
    expect(repairThroughNodes(d)).toEqual({ found: 0, repaired: 0 });
    expect(JSON.stringify(d)).toBe(before);
    expect(mayRunThrough(d)).toBe(false);
  });

  it("never touches a curved or a diagonal route", () => {
    const d = wide();
    d.connections[0]!.isCurve = true;
    expect(repairThroughNodes(d)).toEqual({ found: 1, repaired: 0 });
    expect(route(d)).toEqual([[50, 50], [50, 300]]);
    const e = diagram([shape("a", 0, 0, 100, 50), shape("b", 0, 300, 100, 50), shape("c", -40, 150, 180, 60)], [["a", "b", [[50, 50], [60, 300]]]]);
    expect(repairThroughNodes(e).repaired).toBe(0);
  });

  it("refuses a detour that would add a HARD finding, and takes a free one", () => {
    // arrows p->q and r->s run beside c where every candidate lane lies (4 to 24 px from c), so each detour would sit
    // within a few px of them (parallel-edges-close): the checker refuses all and the route stays as laid out
    const nodes = (dx: number): D2Shape[] => [shape("a", 0, 0, 100, 50), shape("b", 0, 300, 100, 50), shape("c", -40, 150, 180, 60), shape("p", -52 - dx, 0, 4, 40), shape("q", -52 - dx, 320, 4, 40), shape("r", 150 + dx, 0, 4, 40), shape("s", 150 + dx, 320, 4, 40)];
    const routes = (dx: number): [string, string, Pt[]][] => [["a", "b", [[50, 50], [50, 300]]], ["p", "q", [[-50 - dx, 40], [-50 - dx, 320]]], ["r", "s", [[152 + dx, 40], [152 + dx, 320]]]];
    const crowded = diagram(nodes(0), routes(0));
    expect(repairThroughNodes(crowded)).toEqual({ found: 1, repaired: 0 });
    expect(route(crowded)).toEqual([[50, 50], [50, 300]]);
    expect(judge(diagramToNeutral(crowded).neutral).hits).toHaveLength(1);
    const free = diagram(nodes(200), routes(200));
    expect(repairThroughNodes(free)).toEqual({ found: 1, repaired: 1 });
    expect(judge(diagramToNeutral(free).neutral).hits).toEqual([]);
  });
});

describe("reorderEdgeBlocks", () => {
  const src = (edges: string[]): string => {
    const g = parse(`a[A]\nb[B]\nc[C]\n${edges.join("\n")}\n`).graph;
    return translateGraph(g).source;
  };

  it("reverses the edge blocks and nothing else", () => {
    const s = src(["a -> b : x2", "b -> c", "a -> c : x3"]);
    const r = reorderEdgeBlocks(s)!;
    expect(r.split("\n").sort()).toEqual(s.split("\n").sort());
    expect(r.slice(0, s.indexOf("a -> b"))).toBe(s.slice(0, s.indexOf("a -> b")));
    expect(r.indexOf("a -> c")).toBeLessThan(r.indexOf("b -> c"));
    expect(r.indexOf("b -> c")).toBeLessThan(r.indexOf("a -> b"));
    expect(reorderEdgeBlocks(r)).toBe(s);
  });

  it("is undefined for a source it did not write", () => {
    expect(reorderEdgeBlocks("a -> b\nb -> c\n")).toBeUndefined(); // no blocks
    expect(reorderEdgeBlocks(src(["a -> b"]))).toBeUndefined(); // one edge: nothing to reorder
    const s = src(["a -> b", "b -> c"]);
    expect(reorderEdgeBlocks(s + "d: D\n")).toBeUndefined(); // a node after the edges
    expect(reorderEdgeBlocks(s.replace(/\}\n$/, ""))).toBeUndefined(); // an unclosed block
  });

  it("does not mistake an arrow inside a quoted label for an edge", () => {
    const g = parse('a["x -> y {"]\nb[B]\nc[C]\na -> b\nb -> c\n').graph;
    const s = translateGraph(g).source;
    const r = reorderEdgeBlocks(s)!;
    expect(r.indexOf('a: "x -> y {"')).toBe(s.indexOf('a: "x -> y {"'));
    expect(r.indexOf("b -> c")).toBeLessThan(r.indexOf("a -> b"));
  });
});

describe("real ELK routes through a node (edge-order shuffles of the extract corpus)", () => {
  const FIXTURES = ["through-node-vitest.d2", "through-node-excalidraw.d2"];
  const source = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/d2/${name}`, import.meta.url)), "utf8");

  it.each(FIXTURES)("%s: ELK's own routes run through a node, renderD2 returns none", async (name) => {
    const compiled = await d2Compile(source(name), { layout: "elk", pad: D2_PAD });
    expect(throughHits(diagramToNeutral(compiled.diagram).neutral).length).toBeGreaterThan(0);
    spreadLanes(compiled.diagram);
    placeLabels(compiled.diagram);
    const afterSpread = throughHits(diagramToNeutral(compiled.diagram).neutral).length;
    const stats = repairThroughNodes(compiled.diagram);
    expect(stats.found).toBe(afterSpread);
    expect(stats.repaired).toBe(afterSpread);
    expect(throughHits(diagramToNeutral(compiled.diagram).neutral)).toEqual([]);

    const out = await renderD2(source(name));
    expect(throughHits(out.neutral)).toEqual([]);
    expect(out.svg).toContain("<svg");
  }, 60_000);
});
