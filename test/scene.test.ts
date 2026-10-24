import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import type { Graph } from "../src/dsl/ast.js";
import { layout } from "../src/layout/dagre-layout.js";
import { buildScene, type Scene } from "../src/scene/build.js";
import type { SceneElement } from "../src/scene/elements.js";
import { indexSequence, ids } from "../src/scene/ids.js";
import { serialize } from "../src/scene/serialize.js";
import { summarize } from "../src/scene/summary.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const goldenDir = join(here, "golden");
const update = process.env.UPDATE_GOLDEN === "1";

function build(source: string, direction: "DOWN" | "RIGHT" | "UP" | "LEFT" = "DOWN"): { graph: Graph; scene: Scene } {
  const { graph, diagnostics } = parse(source);
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const lr = layout({ graph, direction: graph.direction ?? direction });
  return { graph, scene: buildScene(graph, lr) };
}

const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith(".exd"))
  .sort();

const BASE_FIELDS = [
  "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle",
  "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds", "frameId", "index", "roundness",
  "seed", "version", "versionNonce", "isDeleted", "boundElements", "updated", "link", "locked",
];
const TEXT_FIELDS = [
  "text", "fontSize", "fontFamily", "textAlign", "verticalAlign", "containerId", "originalText",
  "autoResize", "lineHeight",
];
const ARROW_FIELDS = ["points", "startBinding", "endBinding", "startArrowhead", "endArrowhead", "elbowed"];

/** Structural validity of a scene: fields, uniqueness, order, cross references. */
function checkScene(scene: Scene): void {
  const els = scene.elements;
  const byId = new Map<string, SceneElement>();
  for (const e of els) {
    expect(byId.has(e.id), `duplicate id ${e.id}`).toBe(false);
    byId.set(e.id, e);
  }

  for (const e of els) {
    for (const f of BASE_FIELDS) expect(e, `${e.id} missing ${f}`).toHaveProperty(f);
    if (e.type === "text") for (const f of TEXT_FIELDS) expect(e, `${e.id} missing ${f}`).toHaveProperty(f);
    if (e.type === "arrow") for (const f of ARROW_FIELDS) expect(e, `${e.id} missing ${f}`).toHaveProperty(f);
    expect(["rectangle", "ellipse", "diamond", "text", "arrow"]).toContain(e.type);
    expect(Number.isFinite(e.x) && Number.isFinite(e.y) && e.width >= 0 && e.height >= 0).toBe(true);
    expect(e.seed).toBeGreaterThanOrEqual(0);
    expect(e.seed).toBeLessThanOrEqual(0x7fffffff);
    expect(e.version).toBe(1);
    expect(e.updated).toBe(1);
    expect(e.isDeleted).toBe(false);
  }

  for (let i = 1; i < els.length; i++) {
    expect(els[i - 1]!.index < els[i]!.index, `index order at ${els[i]!.id}`).toBe(true);
  }

  for (const e of els) {
    if (e.type === "text" && e.containerId) {
      const c = byId.get(e.containerId);
      expect(c, `container of ${e.id}`).toBeDefined();
      expect(c!.boundElements ?? [], `${c!.id} mirrors ${e.id}`).toContainEqual({ id: e.id, type: "text" });
      expect(e.groupIds).toEqual(c!.type === "arrow" ? [] : c!.groupIds);
    }
    for (const b of e.boundElements ?? []) {
      const t = byId.get(b.id);
      expect(t, `bound element ${b.id} of ${e.id}`).toBeDefined();
      if (b.type === "text") expect((t as { containerId: string | null }).containerId).toBe(e.id);
      else {
        const a = t as Extract<SceneElement, { type: "arrow" }>;
        expect([a.startBinding?.elementId, a.endBinding?.elementId]).toContain(e.id);
      }
    }
    if (e.type === "arrow") {
      for (const bnd of [e.startBinding, e.endBinding]) {
        if (!bnd) continue;
        const t = byId.get(bnd.elementId);
        expect(t, `binding target of ${e.id}`).toBeDefined();
        expect(t!.boundElements ?? []).toContainEqual({ id: e.id, type: "arrow" });
        expect(bnd.focus).toBe(0);
        expect(bnd.gap).toBe(4);
        expect(bnd.fixedPoint.every((v) => v >= 0 && v <= 1)).toBe(true);
      }
      expect(e.points[0]).toEqual([0, 0]);
      expect(e.points.length).toBeGreaterThanOrEqual(2);
    }
  }

  // z-order: zones, zone titles, nodes, node labels, arrows, arrow labels.
  const rank = (e: SceneElement): number => {
    if (e.id === "title") return 0;
    if (e.id.startsWith("zone-title-")) return 2;
    if (e.id.startsWith("zone-")) return 1;
    if (e.id.startsWith("node-") || e.id.startsWith("cap-")) return 3;
    if (e.id.startsWith("label-")) return 4;
    if (e.id.startsWith("edge-label-")) return 6;
    if (e.id.startsWith("edge-")) return 5;
    throw new Error(`unexpected id ${e.id}`);
  };
  const ranks = els.map(rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
}

describe("fractional index", () => {
  it("is strictly increasing across the digit rollover", () => {
    const seq = indexSequence(200);
    expect(seq.slice(0, 3)).toEqual(["a0", "a1", "a2"]);
    expect(seq[61]).toBe("az");
    expect(seq[62]).toBe("b00");
    for (let i = 1; i < seq.length; i++) expect(seq[i - 1]! < seq[i]!).toBe(true);
  });
});

describe("golden files", () => {
  for (const f of fixtures) {
    const name = f.replace(/\.exd$/, "");
    it(`${name}: parse -> layout -> build -> serialize matches test/golden/${name}.excalidraw`, () => {
      const { scene } = build(readFileSync(join(fixtureDir, f), "utf8"));
      const text = serialize(scene);
      const file = join(goldenDir, `${name}.excalidraw`);
      if (update) {
        mkdirSync(goldenDir, { recursive: true });
        writeFileSync(file, text);
      }
      expect(text).toBe(readFileSync(file, "utf8"));
    });

    it(`${name}: valid element set`, () => {
      const { scene } = build(readFileSync(join(fixtureDir, f), "utf8"));
      checkScene(scene);
    });

    it(`${name}: summary matches the AST`, () => {
      const { graph, scene } = build(readFileSync(join(fixtureDir, f), "utf8"));
      const s = summarize(scene);
      expect(s.nodes).toBe(graph.nodes.length);
      expect(s.edges).toBe(graph.edges.length);
      expect(s.groups).toBe(graph.groups.length);
      for (const kind of ["rect", "ellipse", "diamond", "cylinder"] as const) {
        expect(s.shapes[kind]).toBe(graph.nodes.filter((n) => n.shape === kind).length);
      }
      expect(s.title).toBe(graph.title);
      const labels = graph.nodes.length + graph.edges.filter((e) => e.label).length;
      const titles = graph.groups.filter((g) => g.title).length + (graph.title ? 1 : 0);
      expect(s.texts).toBe(labels + titles);
      expect(s.fonts).toEqual({ Excalifont: s.texts });
      expect(s.bounds.width).toBeGreaterThan(0);
    });
  }

  it("serialization is deterministic with 2-space JSON and a trailing newline", () => {
    const src = readFileSync(join(fixtureDir, "arch.exd"), "utf8");
    const a = serialize(build(src).scene);
    expect(a).toBe(serialize(build(src).scene));
    expect(a.endsWith("}\n")).toBe(true);
    expect(a.startsWith('{\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://github.com/')).toBe(true);
    const parsed = JSON.parse(a);
    expect(parsed.appState).toEqual({ gridSize: 20, viewBackgroundColor: "#ffffff" });
    expect(parsed.files).toEqual({});
  });
});

describe("element details", () => {
  const el = (scene: Scene, id: string) => scene.elements.find((e) => e.id === id)!;

  it("default fills: uncolored -> light blue, cylinder -> teal, explicit color wins", () => {
    const { scene } = build("a[A]\nb[(B)]\nc[C] :red\nd[(D)] :purple\ne(E)\nf{F}\n");
    expect(el(scene, "node-a").backgroundColor).toBe("#a5d8ff");
    expect(el(scene, "node-a").fillStyle).toBe("solid");
    expect(el(scene, "node-b").backgroundColor).toBe("#c3fae8");
    expect(el(scene, "node-c").backgroundColor).toBe("#ffc9c9");
    expect(el(scene, "node-d").backgroundColor).toBe("#d0bfff");
    expect(el(scene, "cap-d").backgroundColor).toBe("#d0bfff");
    expect(el(scene, "node-e").backgroundColor).toBe("#a5d8ff");
    expect(el(scene, "node-f").backgroundColor).toBe("#a5d8ff");
    expect(el(scene, "node-a").strokeColor).toBe("#1e1e1e");
  });

  it("shapes: rect rounded, ellipse/diamond sharp, label text fields", () => {
    const { scene } = build("a[Alpha]\nb(Beta)\nc{Gamma}\n");
    expect(el(scene, "node-a").type).toBe("rectangle");
    expect(el(scene, "node-a").roundness).toEqual({ type: 3 });
    expect(el(scene, "node-b").type).toBe("ellipse");
    expect(el(scene, "node-b").roundness).toBeNull();
    expect(el(scene, "node-c").type).toBe("diamond");
    const t = el(scene, "label-a") as Extract<SceneElement, { type: "text" }>;
    const box = el(scene, "node-a");
    expect(t).toMatchObject({
      fontFamily: 5, fontSize: 20, textAlign: "center", verticalAlign: "middle",
      lineHeight: 1.25, autoResize: true, containerId: "node-a", text: "Alpha", originalText: "Alpha",
    });
    expect(t.x + t.width / 2).toBeCloseTo(box.x + box.width / 2, 1);
    expect(t.y + t.height / 2).toBeCloseTo(box.y + box.height / 2, 1);
  });

  it("style flags: bold, sketchy, dashed, dotted", () => {
    const { scene } = build("a[A] :bold,sketchy\nb[B] :dashed\nc[C] :dotted\nd[D]\n");
    expect(el(scene, "node-a")).toMatchObject({ strokeWidth: 4, roughness: 2, strokeStyle: "solid" });
    expect(el(scene, "node-b")).toMatchObject({ strokeWidth: 2, roughness: 1, strokeStyle: "dashed" });
    expect(el(scene, "node-c").strokeStyle).toBe("dotted");
    expect(el(scene, "node-d")).toMatchObject({ strokeWidth: 2, roughness: 1, strokeStyle: "solid" });
  });

  it("arrow kinds map to strokeStyle and arrowheads, labels bind to the arrow", () => {
    const { scene } = build("a[A]\nb[B]\na -> b : one\na --> b\na -- b\na <-> b\na -.-> b : dots\n");
    const arrows = scene.elements.filter((e) => e.type === "arrow") as Extract<SceneElement, { type: "arrow" }>[];
    expect(arrows.map((a) => [a.strokeStyle, a.startArrowhead, a.endArrowhead])).toEqual([
      ["solid", null, "arrow"],
      ["dashed", null, "triangle"],
      ["solid", null, null],
      ["solid", "arrow", "arrow"],
      ["dotted", null, "triangle"],
    ]);
    expect(arrows[0]!.boundElements).toEqual([{ id: "edge-label-0", type: "text" }]);
    expect(arrows[1]!.boundElements).toBeNull();
    const label = el(scene, "edge-label-4") as Extract<SceneElement, { type: "text" }>;
    expect(label).toMatchObject({ containerId: "edge-4", fontSize: 16, text: "dots" });
    // The shared endpoints list every arrow after the node's own label.
    expect(el(scene, "node-a").boundElements!.map((b) => b.id)).toEqual([
      "label-a", "edge-0", "edge-1", "edge-2", "edge-3", "edge-4",
    ]);
    checkScene(scene);
  });

  it("arrow labels carry labelPosition and their stored x/y is where Excalidraw draws them", () => {
    const { scene } = build("a[A]\nb[B]\na -> b : one\nb -> a : two\na -> a : loop\n");
    for (const id of ["0", "1", "2"]) {
      const arrow = el(scene, `edge-${id}`) as Extract<SceneElement, { type: "arrow" }>;
      const label = el(scene, `edge-label-${id}`) as Extract<SceneElement, { type: "text" }>;
      expect(label.labelPosition).toBeGreaterThanOrEqual(0);
      expect(label.labelPosition).toBeLessThanOrEqual(1);
      // walk the path to labelPosition * length and compare with the stored center
      const pts = arrow.points.map(([px, py]) => ({ x: arrow.x + px, y: arrow.y + py }));
      const total = pts.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);
      let rest = label.labelPosition! * total;
      let at = pts[pts.length - 1]!;
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
        if (rest <= seg) {
          const k = seg === 0 ? 0 : rest / seg;
          at = { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * k, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * k };
          break;
        }
        rest -= seg;
      }
      expect(Math.abs(label.x + label.width / 2 - at.x), `${id} x`).toBeLessThan(0.5);
      expect(Math.abs(label.y + label.height / 2 - at.y), `${id} y`).toBeLessThan(0.5);
    }
  });

  it("a self-loop is a short orthogonal loop that starts and ends on its node", () => {
    const { scene } = build("a[A]\na -> a : retry\n");
    const arrow = el(scene, "edge-0") as Extract<SceneElement, { type: "arrow" }>;
    const node = el(scene, "node-a");
    const pts = arrow.points.map(([px, py]) => ({ x: arrow.x + px, y: arrow.y + py }));
    expect(pts.length).toBe(4);
    const touches = (p: { x: number; y: number }) =>
      Math.abs(p.x - node.x) < 1 || Math.abs(p.x - (node.x + node.width)) < 1 || Math.abs(p.y - node.y) < 1 || Math.abs(p.y - (node.y + node.height)) < 1;
    expect(touches(pts[0]!) && touches(pts[3]!)).toBe(true);
    expect(arrow.startBinding?.elementId).toBe("node-a");
    expect(arrow.endBinding?.elementId).toBe("node-a");
    checkScene(scene);
  });

  it("arrow geometry: x,y is the first point and points are relative", () => {
    const { scene } = build("a[A]\nb[B]\na -> b\n");
    const a = el(scene, "edge-0") as Extract<SceneElement, { type: "arrow" }>;
    const from = el(scene, "node-a");
    const to = el(scene, "node-b");
    expect(a.points[0]).toEqual([0, 0]);
    const last = a.points[a.points.length - 1]!;
    expect(a.x).toBeCloseTo(from.x + from.width / 2, 0);
    expect(a.y).toBeCloseTo(from.y + from.height, 0);
    expect(a.y + last[1]).toBeCloseTo(to.y, 0);
    expect(a.startBinding).toMatchObject({ elementId: "node-a", focus: 0, gap: 4 });
    expect(a.endBinding).toMatchObject({ elementId: "node-b", focus: 0, gap: 4 });
    expect(a.elbowed).toBe(false);
  });

  it("cylinder: body + cap share a groupIds entry and bindings target the body", () => {
    const { scene } = build("a[A]\ndb[(DB)]\na -> db\n");
    const body = el(scene, "node-db");
    const cap = el(scene, "cap-db");
    expect(body.type).toBe("rectangle");
    expect(cap.type).toBe("ellipse");
    expect(body.groupIds).toEqual([ids.cylinder("db")]);
    expect(cap.groupIds).toEqual(body.groupIds);
    expect(el(scene, "label-db").groupIds).toEqual(body.groupIds);
    expect((el(scene, "edge-0") as Extract<SceneElement, { type: "arrow" }>).endBinding!.elementId).toBe("node-db");
    expect(cap.y).toBeLessThan(body.y);
    expect(cap.x).toBe(body.x);
    expect(cap.width).toBe(body.width);
  });

  it("zones: style, title, and nested groupIds innermost first", () => {
    const { scene } = build(
      'group outer "Outer" :green {\n  a[A]\n  group inner "Inner" {\n    b[B]\n  }\n}\nc[C]\n',
    );
    const outer = el(scene, "zone-g-outer");
    const inner = el(scene, "zone-g-inner");
    expect(outer).toMatchObject({
      type: "rectangle", backgroundColor: "#d3f9d8", opacity: 30, strokeColor: "#868e96", strokeWidth: 1,
      groupIds: ["group-outer"],
    });
    expect(inner).toMatchObject({ backgroundColor: "#dbe4ff", opacity: 30, groupIds: ["group-inner", "group-outer"] });
    expect(el(scene, "zone-title-inner").groupIds).toEqual(["group-inner", "group-outer"]);
    expect(el(scene, "zone-title-inner")).toMatchObject({ type: "text", text: "Inner", fontSize: 16, containerId: null });
    expect(el(scene, "node-a").groupIds).toEqual(["group-outer"]);
    expect(el(scene, "node-b").groupIds).toEqual(["group-inner", "group-outer"]);
    expect(el(scene, "label-b").groupIds).toEqual(["group-inner", "group-outer"]);
    expect(el(scene, "node-c").groupIds).toEqual([]);
    // Nested zone is drawn after (above) its parent.
    expect(scene.elements.indexOf(inner)).toBeGreaterThan(scene.elements.indexOf(outer));
    checkScene(scene);
  });

  it("title: free text of fontSize 28 above the content", () => {
    const { scene } = build('title "My diagram"\na[A]\n');
    const t = el(scene, "title") as Extract<SceneElement, { type: "text" }>;
    expect(t).toMatchObject({ fontSize: 28, text: "My diagram", containerId: null, groupIds: [] });
    expect(scene.elements[0]).toBe(t);
    const a = el(scene, "node-a");
    expect(t.y + t.height).toBeLessThan(a.y);
    expect(summarize(scene).title).toBe("My diagram");
  });

  it("opts.title overrides graph.title; seed and nonce derive from the id", () => {
    const { graph } = build('title "Old"\na[A]\n');
    const scene = buildScene(graph, layout({ graph, direction: "DOWN" }), { title: "New" });
    expect(el(scene, "title")).toMatchObject({ text: "New" });
    const a = el(scene, "node-a");
    expect(a.seed).toBe(a.versionNonce);
    expect(a.seed).not.toBe(el(scene, "label-a").seed);
  });
});

describe("summarize", () => {
  it("reports shapes, colors and fonts for a mixed diagram", () => {
    const { scene } = build("a[A]\nb[(B)]\nc(C) :red\nd{D}\na -> b\nb -> c\nc -> d\n");
    const s = summarize(scene);
    expect(s.nodes).toBe(4);
    expect(s.edges).toBe(3);
    expect(s.groups).toBe(0);
    expect(s.shapes).toEqual({ rect: 1, ellipse: 1, diamond: 1, cylinder: 1 });
    expect(s.colors).toEqual({ "#a5d8ff": 2, "#c3fae8": 1, "#ffc9c9": 1 });
    expect(s.fonts).toEqual({ Excalifont: 4 });
  });

  it("copes with an empty scene", () => {
    const s = summarize({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });
    expect(s).toMatchObject({ nodes: 0, edges: 0, groups: 0, bounds: { width: 0, height: 0 } });
  });
});
