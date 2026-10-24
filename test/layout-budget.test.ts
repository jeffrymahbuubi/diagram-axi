// The layout runs on a deterministic work budget (src/layout/budget.ts): a pathological input (many parallel
// edges between one pair) stops searching when the budget is spent and keeps the best layout found so far,
// at the same point and with the same output on every machine. The budget never changes a typical diagram.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { LAYOUT_BUDGET, dagreLayout } from "../src/layout/dagre-layout.js";
import { Budget } from "../src/layout/budget.js";
import { astarRoute } from "../src/layout/astar.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Fuzz case multi-edge/101: 4 nodes, 18 edges, 11 of them between one pair (took ~26 s before the budget). */
const MULTI_EDGE = `dir DOWN
n0[Storage] :green
n1(Report Validator Worker)
n2[(Registry)] :sketchy
n3(Loader)
n0 --> n1 : query
n0 -> n1
n0 -> n1 : reject request
n1 -> n2 : fail trigger
n2 -> n1 : trigger
n2 -> n3 : commit reject notify
n3 <-> n2 : reject
n2 -> n3 : enqueue ack
n3 <-> n2 : commit approve query
n2 --> n3 : rollback notify reject
n3 <-> n2 : dispatch commit on error
n2 -> n3 : sync
n2 -> n3 : emit
n3 -.-> n2 : yes
n2 <-> n3 : reject notify
n2 -> n3 : every 5s
n0 <-> n0 : sync
n0 -> n0 : ok query
`;

const laidOut = (text: string, budget?: number) => {
  const { graph } = parse(text);
  return dagreLayout.layout({ graph, direction: graph.direction ?? "DOWN", budget });
};

describe("layout work budget", () => {
  it("never throws and keeps every node and edge, even with nothing to spend", () => {
    const { graph } = parse(MULTI_EDGE);
    for (const budget of [0, 1, 1e5, 3e6]) {
      const r = laidOut(MULTI_EDGE, budget);
      expect(r.nodes).toHaveLength(graph.nodes.length);
      expect(r.edges).toHaveLength(graph.edges.length);
      for (const e of r.edges) {
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        expect(e.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
      }
    }
  });

  it("is deterministic: the same budget gives the same layout", () => {
    const a = JSON.stringify(laidOut(MULTI_EDGE, 2e7));
    const b = JSON.stringify(laidOut(MULTI_EDGE, 2e7));
    expect(a).toBe(b);
  });

  it("does not change a typical diagram", () => {
    const text = readFileSync(join(fixtures, "flow.exd"), "utf8");
    expect(JSON.stringify(laidOut(text))).toBe(JSON.stringify(laidOut(text, LAYOUT_BUDGET * 10)));
  });
});

describe("Budget", () => {
  it("counts units and reports exhaustion", () => {
    const b = new Budget(10);
    expect(b.exhausted).toBe(false);
    b.spend(9);
    expect(b.exhausted).toBe(false);
    b.spend(1);
    expect(b.exhausted).toBe(true);
  });

  it("an exhausted budget stops the A* router (no route, no throw)", () => {
    const spent = new Budget(0);
    const route = astarRoute({
      pa: { x: 0, y: 0 }, sa: "right", pb: { x: 200, y: 0 }, sb: "left",
      obstacles: [], ends: [{ x: -100, y: -30, w: 100, h: 60 }, { x: 200, y: -30, w: 100, h: 60 }],
      margin: 10, placed: [], samePair: [], window: 160, budget: spent,
    });
    expect(route).toBeUndefined();
    const free = astarRoute({
      pa: { x: 0, y: 0 }, sa: "right", pb: { x: 200, y: 0 }, sb: "left",
      obstacles: [], ends: [{ x: -100, y: -30, w: 100, h: 60 }, { x: 200, y: -30, w: 100, h: 60 }],
      margin: 10, placed: [], samePair: [], window: 160,
    });
    expect(free?.length).toBeGreaterThanOrEqual(2);
  });
});
