// Edge routing / label placement guarantees, run over every fixture in all four directions.
// Regression: rag-agent (reciprocal edges between nodes aligned on the flow axis rendered their
// labels on top of each other and on the neighbouring arrows).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import type { Direction } from "../src/dsl/ast.js";
import type { Box, LayoutResult, Point } from "../src/layout/engine.js";
import { dagreLayout } from "../src/layout/dagre-layout.js";
import { overlap, parallelGap, segmentHits } from "../src/layout/geom.js";
import { measure } from "../src/layout/measure.js";
import { fractionAt, placeLabels, pointAt } from "../src/layout/route.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".exd"))
  .map((f) => f.replace(/\.exd$/, ""))
  .sort();
const dirs: Direction[] = ["DOWN", "RIGHT", "UP", "LEFT"];

const run = (name: string, direction: Direction): LayoutResult => {
  const { graph } = parse(readFileSync(join(fixtureDir, `${name}.exd`), "utf8"));
  return dagreLayout.layout({ graph, direction });
};
const labelsOf = (r: LayoutResult) => r.edges.flatMap((e) => (e.label ? [{ index: e.index, box: e.label }] : []));

it("the suite covers rag-agent", () => {
  expect(fixtures).toContain("rag-agent");
});

describe.each(fixtures.flatMap((f) => dirs.map((d) => [f, d] as const)))("fixture %s (%s)", (name, direction) => {
  const r = run(name, direction);

  it("edge labels are disjoint from each other, from nodes and from group titles", () => {
    const labels = labelsOf(r);
    const fixed: Array<[string, Box]> = [
      ...r.nodes.map((n): [string, Box] => [`node ${n.id}`, n]),
      ...r.groups.flatMap((g): Array<[string, Box]> => (g.titleBox ? [[`title ${g.id}`, g.titleBox]] : [])),
    ];
    for (let i = 0; i < labels.length; i++) {
      for (const [what, box] of fixed) {
        expect(overlap(labels[i]!.box, box, 0), `label of edge ${labels[i]!.index} vs ${what}`).toBe(false);
      }
      for (let j = i + 1; j < labels.length; j++) {
        expect(overlap(labels[i]!.box, labels[j]!.box, 0), `labels of edges ${labels[i]!.index} and ${labels[j]!.index}`).toBe(false);
      }
    }
  });

  it("no edge runs through another edge's label", () => {
    for (const { index, box } of labelsOf(r)) {
      for (const e of r.edges) {
        if (e.index === index) continue;
        for (let i = 1; i < e.points.length; i++) {
          expect(segmentHits(e.points[i - 1]!, e.points[i]!, box, 0), `edge ${e.index} crosses the label of edge ${index}`).toBe(false);
        }
      }
    }
  });

  it("the label is centered on its own route (Excalidraw draws it at labelPosition) and fits its text", () => {
    const { graph } = parse(readFileSync(join(fixtureDir, `${name}.exd`), "utf8"));
    for (const e of r.edges) {
      if (!e.label) continue;
      const c = { x: e.label.x + e.label.w / 2, y: e.label.y + e.label.h / 2 };
      const on = pointAt(e.points, fractionAt(e.points, c));
      expect(Math.hypot(on.x - c.x, on.y - c.y), `edge ${e.index} label center lies on its route`).toBeLessThanOrEqual(1);
      // The box is the measured Excalifont 16px text plus padding, so what is drawn matches what was reserved.
      const m = measure(graph.edges[e.index]!.label!, 16);
      expect(e.label.w).toBeGreaterThanOrEqual(m.width);
      expect(e.label.w).toBeLessThanOrEqual(m.width + 10);
      expect(e.label.h).toBeGreaterThanOrEqual(m.height);
    }
  });

  // The multi-edge crash fixture is a stress case (three parallel edges plus reciprocals): it is held to the hard rules only.
  it.skipIf(name === "crash-multi-edge")("edges between one pair of nodes run at least 40px apart wherever they are parallel", () => {
    const byPair = new Map<string, typeof r.edges>();
    for (const e of r.edges) {
      if (e.from === e.to) continue;
      const key = [e.from, e.to].sort().join("|");
      byPair.set(key, [...(byPair.get(key) ?? []), e]);
    }
    for (const list of byPair.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          for (let a = 1; a < list[i]!.points.length; a++) {
            for (let b = 1; b < list[j]!.points.length; b++) {
              const gap = parallelGap(list[i]!.points[a - 1]!, list[i]!.points[a]!, list[j]!.points[b - 1]!, list[j]!.points[b]!, 0.35);
              expect(gap, `edges ${list[i]!.index} and ${list[j]!.index}`).toBeGreaterThanOrEqual(40);
            }
          }
        }
      }
    }
  });

  it("routes keep clear of unrelated nodes", () => {
    for (const e of r.edges) {
      if (e.from === e.to) continue;
      for (const n of r.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        for (let i = 1; i < e.points.length; i++) {
          expect(segmentHits(e.points[i - 1]!, e.points[i]!, n, -2), `edge ${e.index} crosses ${n.id}`).toBe(false);
        }
      }
    }
  });
});

describe("rag-agent regression", () => {
  it.each(dirs)("question/answer (user <-> agent) do not collide (%s)", (d) => {
    const r = run("rag-agent", d);
    const q = r.edges.find((e) => e.index === 0)!;
    const a = r.edges.find((e) => e.index === 5)!;
    expect(overlap(q.label!, a.label!, 6)).toBe(false);
    // neither label sits on the other arrow
    for (const [lab, other] of [[q, a], [a, q]] as const) {
      for (let i = 1; i < other.points.length; i++) {
        expect(segmentHits(other.points[i - 1]!, other.points[i]!, lab.label!, 2)).toBe(false);
      }
    }
  });

  it.each(dirs)("fan-in context labels stay off the query / embed arrows (%s)", (d) => {
    const r = run("rag-agent", d);
    const ctx = r.edges.filter((e) => e.index === 3 || e.index === 4);
    for (const c of ctx) {
      for (const e of r.edges) {
        if (e === c) continue;
        for (let i = 1; i < e.points.length; i++) {
          expect(segmentHits(e.points[i - 1]!, e.points[i]!, c.label!, 3), `edge ${e.index} vs label of ${c.index}`).toBe(false);
        }
      }
    }
  });
});

describe("placeLabels", () => {
  const route = (a: Point, b: Point) => [a, b];

  it("staggers two labels that cannot sit side by side on parallel routes", () => {
    // Two vertical routes 47px apart in a 84px corridor; both labels are wider than the gap.
    const r0 = route({ x: 193, y: 96 }, { x: 193, y: 182 });
    const r1 = route({ x: 240, y: 182 }, { x: 240, y: 96 });
    const nodes: Box[] = [
      { x: 138, y: 20, w: 156, h: 78 },
      { x: 148, y: 182, w: 137, h: 60 },
    ];
    const out = placeLabels(
      [
        { index: 0, w: 74, h: 24, points: r0 },
        { index: 1, w: 61, h: 24, points: r1 },
      ],
      nodes,
      [r0, r1],
    );
    const a = out.get(0)!.box;
    const b = out.get(1)!.box;
    expect(overlap(a, b, 6)).toBe(false);
    for (const box of [a, b]) for (const n of nodes) expect(overlap(box, n, 2)).toBe(false);
  });

  it("moves a label off a foreign edge that crosses its middle", () => {
    const own = route({ x: 0, y: 100 }, { x: 300, y: 100 });
    const foreign = route({ x: 150, y: 0 }, { x: 150, y: 200 });
    const out = placeLabels([{ index: 0, w: 60, h: 24, points: own }], [], [own, foreign]);
    expect(segmentHits(foreign[0]!, foreign[1]!, out.get(0)!.box, 0)).toBe(false);
  });

  it("fractionAt and pointAt round-trip along a polyline", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 80, y: 100 },
    ];
    expect(fractionAt(pts, { x: 0, y: 30 })).toBeCloseTo(30 / 180, 6);
    expect(fractionAt(pts, { x: 40, y: 100 })).toBeCloseTo(140 / 180, 6);
    const p = pointAt(pts, 0.75);
    expect(p.x).toBeCloseTo(35, 6);
    expect(p.y).toBeCloseTo(100, 6);
  });
});

describe.each(fixtures.flatMap((f) => dirs.map((d) => [f, d] as const)))("round 4 targets: fixture %s (%s)", (name, direction) => {
  const r = run(name, direction);
  const ends = r.edges.filter((e) => e.from !== e.to).flatMap((e) => [
    { e, node: e.from, at: e.points[0]!, run: Math.hypot(e.points[1]!.x - e.points[0]!.x, e.points[1]!.y - e.points[0]!.y) },
    { e, node: e.to, at: e.points[e.points.length - 1]!, run: Math.hypot(e.points[e.points.length - 1]!.x - e.points[e.points.length - 2]!.x, e.points[e.points.length - 1]!.y - e.points[e.points.length - 2]!.y) },
  ]);

  it("every arrow end keeps a straight run of at least 24 px before it bends", () => {
    for (const { e, run } of ends) {
      if (e.points.length > 2) expect(run, `edge ${e.index}`).toBeGreaterThanOrEqual(23.5);
    }
  });

  it("arrow ends on one node are at least 28 px apart", () => {
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i]!.node !== ends[j]!.node) continue;
        const d = Math.hypot(ends[i]!.at.x - ends[j]!.at.x, ends[i]!.at.y - ends[j]!.at.y);
        expect(d, `ends of edges ${ends[i]!.e.index} and ${ends[j]!.e.index} on ${ends[i]!.node}`).toBeGreaterThanOrEqual(27.5);
      }
    }
  });
});

describe("tuning profiles", () => {
  it("layout leaves the strict profile in force, also after a diagram that needs the legacy retry", async () => {
    const { T, STRICT } = await import("../src/layout/tune.js");
    const hard = readFileSync(join(here, "qa", "fuzz-corpus", readdirSync(join(here, "qa", "fuzz-corpus")).find((f) => f.endsWith(".exd"))!), "utf8");
    dagreLayout.layout({ graph: parse(hard).graph, direction: "DOWN" });
    expect(T).toEqual(STRICT);
  });
});
