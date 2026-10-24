// D2 geometry (U2): compile().diagram -> neutral model -> scene elements the checker runs on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { d2Engine, d2QualityRows } from "../src/engines/d2/index.js";
import { clipEndToBox, D2_NON_GRAPH_SKIPPED, D2_RULES_SKIPPED, diagramKind, diagramToNeutral, labelBox, rulesSkippedFor, titlesOutsideZones } from "../src/engines/d2/geometry.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { d2Compile, disposeD2, type D2Diagram, type D2Shape } from "../src/engines/d2/wasm.js";
import { analyzeScene } from "../src/quality/analyze.js";
import type { SceneElement } from "../src/quality/geom.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const fixture = (n: string): string => readFileSync(here(`./fixtures/d2/${n}`), "utf8");
const golden = (n: string): string => readFileSync(here(`./golden/d2/${n}`), "utf8");

afterAll(async () => {
  await disposeD2();
});

const count = (els: SceneElement[], pred: (e: SceneElement) => boolean): number => els.filter(pred).length;

describe("day-rag-agent geometry, all three layouts", () => {
  for (const layout of ["dagre", "elk", "tala"]) {
    it(`${layout}: 4 nodes, 1 zone, 6 arrows with bound labels, checker runs`, async () => {
      const r = await renderD2(golden("day-rag-agent-DOWN.d2"), { layout });
      const g = d2Engine.geometry!(r);
      const els = g.elements;
      // user, agent, search, vdb; the title shape is placed by `near`, not part of the layout
      expect(count(els, (e) => e.id.startsWith("node-") && e.type !== "text")).toBe(4);
      expect(count(els, (e) => e.id.startsWith("zone-g-"))).toBe(1);
      expect(count(els, (e) => e.type === "arrow")).toBe(6);
      const arrows = els.filter((e) => e.type === "arrow");
      for (const a of arrows) {
        expect(a.startBinding?.elementId).toMatch(/^(node|zone-g)-/);
        expect(a.endBinding?.elementId).toMatch(/^(node|zone-g)-/);
        expect(a.points!.length).toBeGreaterThanOrEqual(2);
      }
      const labels = els.filter((e) => e.type === "text" && e.id.startsWith("edge-label-"));
      expect(labels).toHaveLength(6);
      for (const l of labels) expect(arrows.map((a) => a.id)).toContain(l.containerId);
      expect(els.find((e) => e.id === "zone-title-tools")?.text).toBe("Tools");
      // everything is translated into positive space
      for (const e of els) {
        expect(e.x).toBeGreaterThanOrEqual(0);
        expect(e.y).toBeGreaterThanOrEqual(0);
      }
      const { findings, stats } = analyzeScene({ elements: els });
      expect(stats).toMatchObject({ nodes: 4, edges: 6, zones: 1 });
      expect(Array.isArray(findings)).toBe(true);
      expect(g.rulesSkipped).toEqual(expect.arrayContaining(D2_RULES_SKIPPED));
      // the translation puts the zone title inside the box (label.near: top-left), so containment applies in every layout
      expect(g.rulesSkipped.includes("group-containment")).toBe(false);
    });
  }

  it("titlesOutsideZones is true only when a zone title box leaves its zone", () => {
    const zone = { id: "g", kind: "zone" as const, box: { x: 0, y: 100, w: 200, h: 100 }, shape: "rectangle" as const };
    const scene = (title: { x: number; y: number; w: number; h: number }) => ({ nodes: [zone], edges: [], labels: [{ ownerId: "g", box: title, text: "G" }] });
    expect(titlesOutsideZones(scene({ x: 5, y: 105, w: 40, h: 20 }))).toBe(false);
    expect(titlesOutsideZones(scene({ x: 5, y: 75, w: 40, h: 20 }))).toBe(true); // dagre's OUTSIDE_TOP_*
  });

  it("the layout never leaves a zone title outside its zone unless nothing else is free (placement moves it inside)", async () => {
    const dagre = d2Engine.geometry!(await renderD2("g: G {\n  a\n}\nb -> g.a", { layout: "dagre" }));
    expect(dagre.rulesSkipped.includes("group-containment")).toBe(false);
  });

  it("members sit inside their zone and the zone title inside the zone", async () => {
    const r = await renderD2(golden("day-rag-agent-DOWN.d2"));
    const els = d2Engine.geometry!(r).elements;
    const { findings } = analyzeScene({ elements: els });
    expect(findings.filter((f) => ["group-containment", "node-overlap", "zone-intrusion", "label-label-overlap"].includes(f.code))).toEqual([]);
  });
});

describe("kinds and rule masks", () => {
  it("sequence: no lifeline edges, messages kept, groups are zones, non-graph rules skipped", async () => {
    const r = await renderD2(fixture("sequence.d2"));
    expect(r.kind).toBe("sequence");
    const g = d2Engine.geometry!(r);
    const arrows = g.elements.filter((e) => e.type === "arrow");
    expect(arrows).toHaveLength(4); // hello, think, hi, again; no (alice -- ) lifelines
    expect(r.neutral!.edges.map((e) => e.id).some((id) => id.includes(" -- "))).toBe(false);
    expect(r.neutral!.nodes.find((n) => n.id === "grp")?.kind).toBe("zone");
    expect(r.neutral!.nodes.find((n) => n.id === "alice")?.kind).toBe("node");
    expect(g.rulesSkipped).toEqual(expect.arrayContaining(["arrow-crossings", "route-ratio", "label-stored-offset", "text-exceeds-inscribed"]));
    expect(g.rulesSkipped).toEqual(rulesSkippedFor("sequence"));
    expect(() => analyzeScene({ elements: g.elements })).not.toThrow();
  });

  it("sequence actors that own spans stay nodes, spans are nodes too", async () => {
    const r = await renderD2("shape: sequence_diagram\nalice -> bob: hi\nalice.a1 -> bob.b1: span\nbob.b1 -> alice.a1: back\n");
    const kinds = new Map(r.neutral!.nodes.map((n) => [n.id, n.kind]));
    expect(kinds.get("alice")).toBe("node");
    expect(kinds.get("alice.a1")).toBe("node");
    expect(r.neutral!.nodes.find((n) => n.id === "alice.a1")?.parent).toBeUndefined();
    expect(r.neutral!.edges).toHaveLength(3);
  });

  it("sql_table and class shapes are whole boxes without a separate label; kind erd/class", async () => {
    const r = await renderD2(fixture("sql.d2"));
    expect(r.kind).toBe("erd");
    expect(r.neutral!.nodes.map((n) => [n.id, n.shape])).toEqual([["users", "table"], ["orgs", "table"]]);
    expect(r.neutral!.labels).toEqual([]);
    expect(r.neutral!.edges).toHaveLength(1);
    expect(rulesSkippedFor("erd")).toContain("route-ratio");
    const cls = await renderD2("Animal: {\n  shape: class\n  +name: string\n}\nDog: {shape: class; +bark(): void}\nAnimal -> Dog");
    expect(cls.kind).toBe("class");
  });

  it("a graph keeps every rule except the Excalidraw-specific two", () => {
    expect(rulesSkippedFor("graph")).toEqual(["label-stored-offset", "text-exceeds-inscribed"]);
    expect(rulesSkippedFor("state")).toEqual([...D2_RULES_SKIPPED, ...D2_NON_GRAPH_SKIPPED].sort());
    expect(D2_NON_GRAPH_SKIPPED).toEqual(expect.arrayContaining(["arrow-crossings", "route-ratio"]));
  });

  it("diagramKind reads the compiled diagram", async () => {
    expect(diagramKind((await d2Compile("a -> b")).diagram)).toBe("graph");
  });
});

describe("neutral mapping", () => {
  it("maps shape types, containers with qualified parents, arrow ends and edge labels", async () => {
    const r = await renderD2(fixture("ok.d2"), { layout: "dagre" });
    const n = r.neutral!;
    const by = new Map(n.nodes.map((x) => [x.id, x]));
    expect(by.get("a")?.shape).toBe("rectangle");
    expect(by.get("b")?.shape).toBe("hexagon");
    expect(by.get("db")?.shape).toBe("cylinder");
    expect(by.get("g")?.kind).toBe("zone");
    expect(by.get("g.x")).toMatchObject({ kind: "node", parent: "g" });
    const e = n.edges.find((x) => x.src === "b" && x.dst === "g.x")!;
    expect(e.endArrow).toBe(true);
    expect(e.startArrow).toBe(false);
    const labeled = n.edges.find((x) => x.text === "request")!;
    expect(labeled.label).toBeDefined();
    // dagre routes are bezier curves, sampled into many points
    expect(labeled.poly.length).toBeGreaterThan(2);
  });

  it("nested containers chain their parents; scene groupIds follow", async () => {
    const r = await renderD2("a: A {\n  b: B {\n    c\n  }\n}\nd -> a.b.c");
    const by = new Map(r.neutral!.nodes.map((x) => [x.id, x]));
    expect(by.get("a")?.kind).toBe("zone");
    expect(by.get("a.b")).toMatchObject({ kind: "zone", parent: "a" });
    expect(by.get("a.b.c")).toMatchObject({ kind: "node", parent: "a.b" });
    const els = d2Engine.geometry!(r).elements;
    expect(els.find((e) => e.id === "node-a.b.c")?.groupIds).toEqual(["group-a.b", "group-a"]);
  });

  it("our title shape is dropped, a user text shape is kept", async () => {
    const t = await renderD2('d2_title: "T" {\n  shape: text\n  near: top-center\n}\na -> b');
    expect(t.neutral!.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    const u = await renderD2('note: "N" {shape: text}\na -> b');
    expect(u.neutral!.nodes.map((n) => n.id)).toContain("note");
  });

  it("label boxes follow D2's labelPosition", () => {
    const base: D2Shape = { id: "s", type: "rectangle", pos: { x: 100, y: 100 }, width: 200, height: 100, level: 1, label: "L", labelWidth: 40, labelHeight: 20 };
    expect(labelBox({ ...base, labelPosition: "INSIDE_MIDDLE_CENTER" })).toEqual({ x: 180, y: 140, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "INSIDE_TOP_CENTER" })).toEqual({ x: 180, y: 105, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "INSIDE_TOP_LEFT" })).toEqual({ x: 105, y: 105, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "INSIDE_BOTTOM_RIGHT" })).toEqual({ x: 255, y: 175, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "OUTSIDE_TOP_CENTER" })).toEqual({ x: 180, y: 75, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "OUTSIDE_BOTTOM_CENTER" })).toEqual({ x: 180, y: 205, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "OUTSIDE_MIDDLE_RIGHT" })).toEqual({ x: 305, y: 140, w: 40, h: 20 });
    expect(labelBox({ ...base, labelPosition: "BORDER_TOP_CENTER" })).toEqual({ x: 180, y: 90, w: 40, h: 20 });
    expect(labelBox({ ...base, label: "" })).toBeUndefined();
    expect(labelBox({ ...base, labelWidth: 0 })).toBeUndefined();
  });

  it("an edge label sits on the route midpoint, where D2 draws it", async () => {
    const r = await renderD2("direction: right\na -> b: hello", { layout: "elk" });
    const e = r.neutral!.edges[0]!;
    const mid = (e.poly[0]![0] + e.poly[e.poly.length - 1]![0]) / 2;
    expect(e.label!.x + e.label!.w / 2).toBeCloseTo(mid, 0);
  });

  it("an unlabeled edge (the translator's `a -> b:` form) has no label", async () => {
    const r = await renderD2("a -> b:  {\n  style.stroke: \"#1e1e1e\"\n}");
    expect(r.neutral!.edges[0]!.label).toBeUndefined();
  });
});

describe("hints", () => {
  const f = (code: string) => ({ code, severity: "hard" as const, elements: [], detail: "x".repeat(200) });

  it("name layouts, direction and label changes, never coordinates; other layouts than the current one", () => {
    const rows = d2QualityRows([f("node-overlap"), f("label-on-node"), f("arrow-crossings"), f("route-ratio"), f("text-overflow"), f("something-new")], { layout: "elk" });
    expect(rows).toHaveLength(6);
    expect(rows[0]!.fix).toContain("--layout tala or --layout dagre");
    expect(rows[2]!.fix).toMatch(/direction/);
    expect(rows[1]!.fix).toMatch(/shorten the label/);
    expect(rows[4]!.fix).toMatch(/width\/height/);
    expect(rows[5]!.fix).toMatch(/--layout/);
    for (const r of rows) {
      expect(r.fix).not.toMatch(/\d+ ?px|x=|y=|coordinate/);
      expect(r.detail.length).toBeLessThanOrEqual(150);
    }
    expect(d2QualityRows([f("node-overlap")], { layout: "tala" })[0]!.fix).toContain("--layout elk or --layout dagre");
  });
});

describe("diagramToNeutral on a compiled corpus diagram", () => {
  it("every edge end that names a shape is a node or zone of the scene", async () => {
    const c = await d2Compile(golden("day-k8s-deployment-RIGHT.d2"), { layout: "elk" });
    const { neutral } = diagramToNeutral(c.diagram);
    const ids = new Set(neutral.nodes.map((n) => n.id));
    for (const e of neutral.edges) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });
});

describe("cylinder adapter (verified against the d2 SVG)", () => {
  const box = { x: 100, y: 100, w: 120, h: 80 };

  it("a centered cylinder label sits 12 px below the box middle, other shapes stay centered", () => {
    const base: D2Shape = { id: "s", type: "cylinder", pos: { x: 100, y: 100 }, width: 120, height: 80, level: 1, label: "DB", labelWidth: 40, labelHeight: 20, labelPosition: "INSIDE_MIDDLE_CENTER" };
    expect(labelBox(base)).toEqual({ x: 140, y: 142, w: 40, h: 20 });
    expect(labelBox({ ...base, type: "rectangle" })).toEqual({ x: 140, y: 130, w: 40, h: 20 });
  });

  it("clipEndToBox trims a route end that lies inside the box back to the box side", () => {
    // heading down, ending 10 px inside the top (the cap arc off-center)
    expect(clipEndToBox([[130, 20], [130, 110]], box, "end")).toEqual([[130, 20], [130, 100]]);
    // an elbow route: the last segment is the vertical one
    expect(clipEndToBox([[0, 0], [150, 0], [150, 112]], box, "end")).toEqual([[0, 0], [150, 0], [150, 100]]);
    // the same route read from the other end
    expect(clipEndToBox([[130, 110], [130, 20]], box, "start")).toEqual([[130, 100], [130, 20]]);
    // a route from the left ending inside
    expect(clipEndToBox([[40, 140], [108, 140]], box, "end")).toEqual([[40, 140], [100, 140]]);
  });

  it("clipEndToBox leaves an end on the border, or a route wholly inside, alone", () => {
    const onBorder: [number, number][] = [[130, 20], [130, 100]];
    expect(clipEndToBox(onBorder, box, "end")).toBe(onBorder);
    const inside: [number, number][] = [[110, 110], [150, 150]];
    expect(clipEndToBox(inside, box, "end")).toBe(inside);
  });

  it("fan-in onto a cylinder: no arrowhead reads as buried in the node", async () => {
    const src = ["direction: down", "db: DB {shape: cylinder}", ...[1, 2, 3, 4, 5, 6].map((i) => `s${i}: S${i}\ns${i} -> db`)].join("\n");
    const r = await renderD2(src, { layout: "elk" });
    const db = r.neutral!.nodes.find((n) => n.id === "db")!;
    for (const e of r.neutral!.edges) {
      const end = e.poly[e.poly.length - 1]!;
      expect(end[1]).toBeLessThanOrEqual(db.box.y + 0.5);
    }
    const { findings } = analyzeScene({ elements: d2Engine.geometry!(r).elements });
    expect(findings.filter((f) => f.code === "arrowhead-inside-node")).toEqual([]);
  });
});

describe("route precision", () => {
  it("rounds D2's float32 route noise to 0.01 px, so lanes 10 px apart measure 10", () => {
    const shape = (id: string, x: number): D2Shape => ({ id, type: "rectangle", pos: { x, y: 0 }, width: 50, height: 30, level: 1 });
    const diagram = {
      shapes: [shape("a", 0), shape("b", 100)],
      connections: [{ id: "(a -> b)[0]", src: "a", dst: "b", dstArrow: "triangle", route: [{ x: 424.3330078125, y: 30 }, { x: 414.3330078125, y: 90.0000001 }] }],
    } as unknown as D2Diagram;
    const poly = diagramToNeutral(diagram).neutral.edges[0]!.poly;
    expect(poly).toEqual([[424.33, 30], [414.33, 90]]);
  });
});
