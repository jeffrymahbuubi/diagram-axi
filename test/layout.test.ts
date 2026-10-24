import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ArrowKind, Direction, Edge, Graph, Group, Node, ShapeKind } from "../src/dsl/ast.js";
import type { Box, LayoutResult } from "../src/layout/engine.js";
import { dagreLayout } from "../src/layout/dagre-layout.js";
import { measure, measureWrapped } from "../src/layout/measure.js";
import { parse } from "../src/dsl/parser.js";
import { fractionAt, pointAt } from "../src/layout/route.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---- hand-built graphs (the parser is a separate unit) ----

const node = (id: string, label: string, shape: ShapeKind = "rect"): Node => ({
  id,
  label,
  shape,
  flags: [],
  line: 1,
  col: 1,
});
const edge = (from: string, to: string, label?: string, arrow: ArrowKind = "solid"): Edge => ({
  from,
  to,
  arrow,
  label,
  line: 1,
  col: 1,
});
const group = (id: string, title: string | undefined, children: string[], groups: string[] = []): Group => ({
  id,
  title,
  flags: [],
  children,
  groups,
  line: 1,
  col: 1,
});

/** Mirrors the plan's arch example (dir RIGHT, group "Edge" with web + mobile, fan-in, labels). */
const arch: Graph = {
  direction: "RIGHT",
  title: "Order pipeline",
  nodes: [
    node("web", "Web app"),
    node("mobile", "Mobile app"),
    node("api", "API Gateway"),
    node("auth", "Auth?", "diamond"),
    node("orders", "Order svc"),
    node("db", "Orders DB", "cylinder"),
    node("cache", "Redis", "cylinder"),
    node("audit", "Audit\nlog", "ellipse"),
  ],
  edges: [
    edge("web", "api", "HTTPS"),
    edge("mobile", "api", "HTTPS"),
    edge("api", "auth", "JWT"),
    edge("auth", "api", "401", "dashed"),
    edge("api", "orders"),
    edge("orders", "db"),
    edge("api", "cache", "read-through", "dotted"),
    edge("api", "audit"),
  ],
  groups: [group("edge", "Edge", ["web", "mobile"])],
};

const nested: Graph = {
  nodes: [
    node("client", "Client"),
    node("lb", "Load balancer"),
    node("svc1", "Service A"),
    node("svc2", "Service B"),
    node("db", "Primary DB", "cylinder"),
    node("replica", "Replica", "cylinder"),
    node("mon", "Monitoring"),
  ],
  edges: [
    edge("client", "lb"),
    edge("lb", "svc1", "route"),
    edge("lb", "svc2", "route"),
    edge("svc1", "db"),
    edge("svc2", "db"),
    edge("db", "replica", "sync"),
    edge("svc1", "mon"),
  ],
  groups: [
    group("platform", "Platform", ["lb"], ["compute", "data"]),
    group("compute", "Compute", ["svc1", "svc2"]),
    group("data", "Data tier", ["db", "replica"]),
  ],
};

const emptyGroup: Graph = {
  nodes: [node("a", "A"), node("b", "B")],
  edges: [edge("a", "b")],
  groups: [group("g", "Lonely", [])],
};

const cases: Array<[string, Graph, Direction]> = [
  ["arch (RIGHT)", arch, "RIGHT"],
  ["arch (DOWN)", arch, "DOWN"],
  ["arch (UP)", arch, "UP"],
  ["arch (LEFT)", arch, "LEFT"],
  ["nested (DOWN)", nested, "DOWN"],
  ["nested (RIGHT)", nested, "RIGHT"],
  ["empty group", emptyGroup, "DOWN"],
];

// ---- helpers ----

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

function checkNoNodeOverlap(r: LayoutResult) {
  for (let i = 0; i < r.nodes.length; i++) {
    for (let j = i + 1; j < r.nodes.length; j++) {
      expect(overlaps(r.nodes[i]!, r.nodes[j]!), `${r.nodes[i]!.id} vs ${r.nodes[j]!.id}`).toBe(false);
    }
  }
}

// ---- tests ----

describe("font metrics", () => {
  it("ships the generated JSON", () => {
    for (const f of ["excalifont.json", "cascadia.json"]) {
      const path = join(here, "..", "src", "layout", "metrics", f);
      expect(existsSync(path)).toBe(true);
      const data = JSON.parse(readFileSync(path, "utf8"));
      expect(data.unitsPerEm).toBeGreaterThan(0);
      expect(data.widths).toHaveLength(data.last - data.first + 1);
      expect(data.avg).toBeGreaterThan(0);
    }
  });

  it("measures 'API Gateway' at 20px close to the opentype.js reference", () => {
    // Reference computed once with opentype.js: font.getAdvanceWidth("API Gateway", 20) on
    // Excalifont.ttf (node_modules/@excalidraw/utils/dist/prod/assets) = 131.28.
    const m = measure("API Gateway", 20);
    expect(Math.abs(m.width - 131.28) / 131.28).toBeLessThan(0.1);
    expect(m.height).toBe(25);
    expect(m.lines).toEqual(["API Gateway"]);
  });

  it("splits lines, takes the widest and scales height", () => {
    const m = measure("ab\nabcdef\nabc", 16);
    expect(m.lines).toHaveLength(3);
    expect(m.height).toBe(3 * 1.25 * 16);
    expect(m.width).toBe(measure("abcdef", 16).width);
  });

  it("wraps a line wider than the limit at spaces and leaves short text alone", () => {
    expect(measureWrapped("short label", 16, 200).lines).toEqual(["short label"]);
    const long = "cache hit notify on error yes poll route validate enqueue response cache hit";
    const m = measureWrapped(long, 16, 200);
    expect(m.lines.length).toBeGreaterThan(1);
    expect(m.lines.join(" ")).toBe(long);
    expect(m.width).toBeLessThanOrEqual(200);
    expect(m.height).toBe(m.lines.length * 1.25 * 16);
    // one word wider than the limit stays whole on its own line
    expect(measureWrapped("a incomprehensibilities b", 16, 40).lines).toEqual(["a", "incomprehensibilities", "b"]);
  });

  it("falls back to the average advance for unmapped codepoints and supports cascadia", () => {
    expect(measure("中", 20).width).toBeGreaterThan(0);
    expect(measure("iiii", 20, "cascadia").width).toBeCloseTo(measure("WWWW", 20, "cascadia").width, 5);
  });
});

describe.each(cases)("dagreLayout: %s", (_name, graph, direction) => {
  const r = dagreLayout.layout({ graph, direction });

  it("positions every node and edge, no node overlap", () => {
    expect(r.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(r.edges).toHaveLength(graph.edges.length);
    checkNoNodeOverlap(r);
  });

  it("applies the sizing rules", () => {
    for (const n of r.nodes) {
      const src = graph.nodes.find((x) => x.id === n.id)!;
      const t = measure(src.label, 20);
      const w = Math.max(120, t.width + 32);
      const h = Math.max(60, t.height + 24);
      const k = { rect: [1, 1], diamond: [1.6, 1.4], ellipse: [1.3, 1.3], cylinder: [1, 1.25] }[src.shape]!;
      expect(n.w).toBeGreaterThanOrEqual(Math.floor(w * k[0]!));
      expect(n.h).toBeGreaterThanOrEqual(Math.floor(h * k[1]!));
      // nodes grow (never shrink) along a side that carries many edge ends, up to 560 px
      expect(Math.max(n.w, n.h)).toBeLessThanOrEqual(560);
    }
  });

  it("edges have >= 2 points and reserve label boxes", () => {
    for (const e of r.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      const src = graph.edges[e.index]!;
      expect(e.from).toBe(src.from);
      expect(e.to).toBe(src.to);
      expect(Boolean(e.label)).toBe(Boolean(src.label));
      if (e.label) expect(e.label.text.lines.join("\n")).toBe(src.label);
    }
  });

  it("starts and ends edges on rect/cylinder node boundaries", () => {
    const onBoundary = (p: { x: number; y: number }, b: Box) => {
      const tol = 1.5;
      const inX = p.x >= b.x - tol && p.x <= b.x + b.w + tol;
      const inY = p.y >= b.y - tol && p.y <= b.y + b.h + tol;
      const nearX = Math.abs(p.x - b.x) <= tol || Math.abs(p.x - b.x - b.w) <= tol;
      const nearY = Math.abs(p.y - b.y) <= tol || Math.abs(p.y - b.y - b.h) <= tol;
      return inX && inY && (nearX || nearY);
    };
    for (const e of r.edges) {
      if (e.from === e.to) continue;
      for (const [id, p] of [[e.from, e.points[0]!], [e.to, e.points[e.points.length - 1]!]] as const) {
        const src = graph.nodes.find((n) => n.id === id)!;
        if (src.shape === "rect" || src.shape === "cylinder") {
          expect(onBoundary(p, r.nodes.find((n) => n.id === id)!), `${id} end of edge ${e.index}`).toBe(true);
        }
      }
    }
  });

  it("encloses every child (node and nested group) inside its group box", () => {
    expect(r.groups.map((g) => g.id).sort()).toEqual(graph.groups.map((g) => g.id).sort());
    const gb = new Map(r.groups.map((g) => [g.id, g]));
    const nb = new Map(r.nodes.map((n) => [n.id, n]));
    for (const g of graph.groups) {
      const box = gb.get(g.id)!;
      for (const id of g.children) expect(inside(nb.get(id)!, box), `${id} in ${g.id}`).toBe(true);
      for (const id of g.groups) expect(inside(gb.get(id)!, box), `${id} in ${g.id}`).toBe(true);
    }
  });

  it("keeps group boxes clear of non-members and unrelated groups", () => {
    const descendants = (id: string): string[] => {
      const g = graph.groups.find((x) => x.id === id)!;
      return [id, ...g.groups.flatMap(descendants)];
    };
    const memberNodes = (id: string) =>
      new Set(descendants(id).flatMap((d) => graph.groups.find((x) => x.id === d)!.children));
    for (const g of r.groups) {
      const members = memberNodes(g.id);
      for (const n of r.nodes) {
        if (!members.has(n.id)) expect(overlaps(g, n), `${n.id} vs group ${g.id}`).toBe(false);
      }
      const mine = new Set(descendants(g.id));
      for (const o of r.groups) {
        const related = mine.has(o.id) || new Set(descendants(o.id)).has(g.id);
        if (o.id !== g.id && !related) expect(overlaps(g, o), `${g.id} vs ${o.id}`).toBe(false);
      }
    }
  });

  it("orders groups parents before children and reserves a title box inside the zone", () => {
    const pos = new Map(r.groups.map((g, i) => [g.id, i]));
    for (const g of graph.groups) {
      for (const c of g.groups) expect(pos.get(g.id)!).toBeLessThan(pos.get(c)!);
    }
    for (const g of r.groups) {
      const src = graph.groups.find((x) => x.id === g.id)!;
      expect(Boolean(g.titleBox)).toBe(Boolean(src.title));
      if (!g.titleBox) continue;
      expect(inside(g.titleBox, g)).toBe(true);
      for (const id of src.children) {
        expect(overlaps(g.titleBox, r.nodes.find((n) => n.id === id)!), `title vs ${id}`).toBe(false);
      }
      for (const id of src.groups) {
        expect(overlaps(g.titleBox, r.groups.find((x) => x.id === id)!), `title vs group ${id}`).toBe(false);
      }
    }
  });

  it("bounds enclose everything", () => {
    for (const b of [...r.nodes, ...r.groups, ...r.edges.flatMap((e) => (e.label ? [e.label] : []))]) {
      expect(inside(b, r.bounds)).toBe(true);
    }
    for (const e of r.edges) {
      for (const p of e.points) expect(inside({ x: p.x, y: p.y, w: 0, h: 0 }, r.bounds)).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(dagreLayout.layout({ graph, direction })).toEqual(r);
  });
});

describe("direction", () => {
  const chain: Graph = {
    nodes: [node("web", "Web"), node("api", "API"), node("db", "DB", "cylinder")],
    edges: [edge("web", "api", "HTTPS"), edge("api", "db")],
    groups: [],
  };
  const at = (d: Direction) => {
    const r = dagreLayout.layout({ graph: chain, direction: d });
    const get = (id: string) => r.nodes.find((n) => n.id === id)!;
    return { web: get("web"), api: get("api"), db: get("db") };
  };

  it("RIGHT runs left to right", () => {
    const { web, api, db } = at("RIGHT");
    expect(web.x).toBeLessThan(api.x);
    expect(api.x).toBeLessThan(db.x);
  });
  it("LEFT runs right to left", () => {
    const { web, api, db } = at("LEFT");
    expect(web.x).toBeGreaterThan(api.x);
    expect(api.x).toBeGreaterThan(db.x);
  });
  it("DOWN runs top to bottom, UP the reverse", () => {
    const d = at("DOWN");
    expect(d.web.y).toBeLessThan(d.api.y);
    expect(d.api.y).toBeLessThan(d.db.y);
    const u = at("UP");
    expect(u.web.y).toBeGreaterThan(u.api.y);
    expect(u.api.y).toBeGreaterThan(u.db.y);
  });
  it("the arch example flows left to right with RIGHT", () => {
    const r = dagreLayout.layout({ graph: arch, direction: "RIGHT" });
    const x = (id: string) => r.nodes.find((n) => n.id === id)!.x;
    expect(x("web")).toBeLessThan(x("api"));
    expect(x("api")).toBeLessThan(x("orders"));
    expect(x("orders")).toBeLessThan(x("db"));
  });
});

describe("edge cases", () => {
  it("handles an empty graph", () => {
    const r = dagreLayout.layout({ graph: { nodes: [], edges: [], groups: [] }, direction: "DOWN" });
    expect(r.nodes).toEqual([]);
    expect(r.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("handles self loops, parallel edges and unknown references without throwing", () => {
    const g: Graph = {
      nodes: [node("a", "A"), node("b", "B")],
      edges: [edge("a", "a", "retry"), edge("a", "b"), edge("a", "b", "again"), edge("a", "ghost")],
      groups: [group("g", "G", ["a", "nope"], ["g", "missing"])],
    };
    const r = dagreLayout.layout({ graph: g, direction: "DOWN" });
    expect(r.edges.map((e) => e.index)).toEqual([0, 1, 2]);
    for (const e of r.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
    expect(r.groups).toHaveLength(1);
  });

  it("widens a group whose title is wider than its content", () => {
    const g: Graph = {
      nodes: [node("a", "A")],
      edges: [],
      groups: [group("g", "A very long zone title that exceeds the node width by far", ["a"])],
    };
    const r = dagreLayout.layout({ graph: g, direction: "DOWN" });
    const box = r.groups[0]!;
    expect(box.titleBox!.x + box.titleBox!.w).toBeLessThanOrEqual(box.x + box.w);
  });
});

// ---- edge routing guarantees ----

type Pt = { x: number; y: number };
/** Distance-ish error (px) of `p` from the outline of the shape in `b`. */
function outlineError(shape: ShapeKind, b: Box, p: Pt): number {
  const [hw, hh] = [b.w / 2, b.h / 2];
  const [dx, dy] = [Math.abs(p.x - (b.x + hw)), Math.abs(p.y - (b.y + hh))];
  const scale = Math.min(hw, hh);
  if (shape === "diamond") return Math.abs(dx / hw + dy / hh - 1) * scale;
  if (shape === "ellipse") return Math.abs(Math.hypot(dx / hw, dy / hh) - 1) * scale;
  return dx <= hw + 1 && dy <= hh + 1 ? Math.min(Math.abs(dx - hw), Math.abs(dy - hh)) : Infinity;
}

/** Does segment p-q pass through the interior of `b` (shrunk by 1px)? Sampled. */
function segHitsInterior(p: Pt, q: Pt, b: Box): boolean {
  for (let i = 1; i < 40; i++) {
    const x = p.x + ((q.x - p.x) * i) / 40;
    const y = p.y + ((q.y - p.y) * i) / 40;
    if (x > b.x + 1 && x < b.x + b.w - 1 && y > b.y + 1 && y < b.y + b.h - 1) return true;
  }
  return false;
}

function checkRouting(graph: Graph, r: LayoutResult) {
  const shape = new Map(graph.nodes.map((n) => [n.id, n.shape]));
  const box = new Map(r.nodes.map((n) => [n.id, n]));
  const ends = new Map<string, Array<{ edge: number; p: Pt }>>();
  for (const e of r.edges) {
    if (e.from === e.to) continue;
    const first = e.points[0]!;
    const last = e.points[e.points.length - 1]!;
    expect(outlineError(shape.get(e.from)!, box.get(e.from)!, first), `edge ${e.index} start`).toBeLessThanOrEqual(1);
    expect(outlineError(shape.get(e.to)!, box.get(e.to)!, last), `edge ${e.index} end`).toBeLessThanOrEqual(1);
    for (let i = 1; i < e.points.length; i++) {
      const u = { x: e.points[i]!.x - e.points[i - 1]!.x, y: e.points[i]!.y - e.points[i - 1]!.y };
      expect(Math.hypot(u.x, u.y), `edge ${e.index} segment ${i} length`).toBeGreaterThan(0.5);
      if (i < e.points.length - 1) {
        const v = { x: e.points[i + 1]!.x - e.points[i]!.x, y: e.points[i + 1]!.y - e.points[i]!.y };
        expect(u.x * v.x + u.y * v.y, `edge ${e.index} backtracks at point ${i}`).toBeGreaterThanOrEqual(0);
      }
    }
    for (const [id, p] of [[e.from, first], [e.to, last]] as const) ends.set(id, [...(ends.get(id) ?? []), { edge: e.index, p }]);
  }
  for (const [id, list] of ends) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i]!.p.x - list[j]!.p.x, list[i]!.p.y - list[j]!.p.y);
        expect(d, `edges ${list[i]!.edge} and ${list[j]!.edge} share an end point on ${id}`).toBeGreaterThanOrEqual(6);
      }
    }
  }
}

describe("edge routing", () => {
  it.each(cases)("%s: clean, distinct routes on the real outlines", (_n, graph, direction) => {
    checkRouting(graph, dagreLayout.layout({ graph, direction }));
  });

  const fixtures = ["arch", "pipeline", "flow", "nested-groups"];
  const dirs: Direction[] = ["DOWN", "RIGHT", "UP", "LEFT"];
  for (const f of fixtures) {
    for (const d of dirs) {
      it(`fixture ${f} (${d}): clean routes that avoid unrelated nodes`, () => {
        const { graph } = parse(readFileSync(join(here, "fixtures", `${f}.exd`), "utf8"));
        const r = dagreLayout.layout({ graph, direction: d });
        checkRouting(graph, r);
        for (const e of r.edges) {
          if (e.from === e.to) continue;
          for (const n of r.nodes) {
            if (n.id === e.from || n.id === e.to) continue;
            for (let i = 1; i < e.points.length; i++) {
              expect(segHitsInterior(e.points[i - 1]!, e.points[i]!, n), `edge ${e.index} crosses ${n.id}`).toBe(false);
            }
          }
        }
      });
    }
  }

  for (const f of fixtures) {
    for (const d of dirs) {
      it(`fixture ${f} (${d}): edge labels are disjoint from each other and from nodes`, () => {
        const { graph } = parse(readFileSync(join(here, "fixtures", `${f}.exd`), "utf8"));
        const r = dagreLayout.layout({ graph, direction: d });
        // Excalidraw draws arrow-bound text at labelPosition (a fraction of the path): the label center must lie on the route.
        for (const e of r.edges) {
          if (!e.label || e.from === e.to) continue;
          const c = { x: e.label.x + e.label.w / 2, y: e.label.y + e.label.h / 2 };
          const on = pointAt(e.points, fractionAt(e.points, c));
          expect(Math.hypot(on.x - c.x, on.y - c.y), `edge ${e.index} label center on its route`).toBeLessThanOrEqual(1);
        }
        const labels = r.edges.flatMap((e) => (e.label ? [{ index: e.index, box: e.label }] : []));
        for (let i = 0; i < labels.length; i++) {
          for (const n of r.nodes) {
            expect(overlaps(labels[i]!.box, n), `label of edge ${labels[i]!.index} vs node ${n.id}`).toBe(false);
          }
          for (let j = i + 1; j < labels.length; j++) {
            expect(overlaps(labels[i]!.box, labels[j]!.box), `labels of edges ${labels[i]!.index} and ${labels[j]!.index}`).toBe(false);
          }
        }
      });
    }
  }

  it.each(dirs)('edges between one pair run at least 24px apart wherever they are parallel (arch, %s)', (d) => {
    const r = dagreLayout.layout({ graph: arch, direction: d });
    const byPair = new Map<string, typeof r.edges>();
    for (const e of r.edges) {
      const key = [e.from, e.to].sort().join('|');
      byPair.set(key, [...(byPair.get(key) ?? []), e]);
    }
    for (const list of byPair.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          for (let a = 1; a < list[i]!.points.length; a++) {
            for (let b = 1; b < list[j]!.points.length; b++) {
              const p = list[i]!.points[a - 1]!;
              const q = list[i]!.points[a]!;
              const s = list[j]!.points[b - 1]!;
              const t = list[j]!.points[b]!;
              const u = { x: q.x - p.x, y: q.y - p.y };
              const v = { x: t.x - s.x, y: t.y - s.y };
              const lu = Math.hypot(u.x, u.y);
              const lv = Math.hypot(v.x, v.y);
              if (Math.abs(u.x * v.y - u.y * v.x) / (lu * lv) >= 0.35) continue;
              for (const f of [0.25, 0.5, 0.75]) {
                const m = { x: p.x + u.x * f, y: p.y + u.y * f };
                const k = ((m.x - s.x) * v.x + (m.y - s.y) * v.y) / (lv * lv);
                if (k <= 0 || k >= 1) continue; // beyond the other segment: not side by side
                const dist = Math.hypot(m.x - (s.x + v.x * k), m.y - (s.y + v.y * k));
                expect(dist, `edges ${list[i]!.index} and ${list[j]!.index}`).toBeGreaterThanOrEqual(24);
              }
            }
          }
        }
      }
    }
  });

  it("nested-groups has no long diagonals (every segment is axis-aligned or at most ~35 degrees off)", () => {
    const { graph } = parse(readFileSync(join(here, "fixtures", "nested-groups.exd"), "utf8"));
    const r = dagreLayout.layout({ graph, direction: graph.direction ?? "DOWN" });
    for (const e of r.edges) {
      for (let i = 1; i < e.points.length; i++) {
        const dx = Math.abs(e.points[i]!.x - e.points[i - 1]!.x);
        const dy = Math.abs(e.points[i]!.y - e.points[i - 1]!.y);
        expect(Math.min(dx, dy) <= 0.7 * Math.max(dx, dy), `edge ${e.index} segment ${i}`).toBe(true);
      }
    }
  });
});

describe("edge ends", () => {
  const ends = (r: LayoutResult, id: string) =>
    r.edges.flatMap((e) => [...(e.from === id ? [e.points[0]!] : []), ...(e.to === id ? [e.points[e.points.length - 1]!] : [])]);

  it("keeps the arrow ends of several self-loops on one node 18px apart", () => {
    const graph: Graph = { nodes: [node("a", "A")], edges: [edge("a", "a"), edge("a", "a", "retry"), edge("a", "a", "again")], groups: [] };
    for (const direction of ["DOWN", "RIGHT"] as Direction[]) {
      const r = dagreLayout.layout({ graph, direction });
      const pts = ends(r, "a");
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y), `${direction} ${i}/${j}`).toBeGreaterThanOrEqual(18);
      }
    }
  });
});
