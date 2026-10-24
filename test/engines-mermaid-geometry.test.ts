// Mermaid geometry (U3, KTD5): the page's DOM measurements become a neutral scene the one checker reads.
// Pure tests need no browser; the rest skip without one.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { mermaidEngine } from "../src/engines/mermaid/index.js";
import { dropTinySegments, endsOfEdge, kindOfRole, geometryOf, snapToBox } from "../src/engines/mermaid/geometry.js";
import { mermaidHints } from "../src/engines/mermaid/hints.js";
import { MermaidPage, bundleUrl, launchBrowser, type MermaidBrowser } from "../src/engines/mermaid/page.js";
import { renderOn, type MermaidRenderResult } from "../src/engines/mermaid/render.js";
import { analyzeScene } from "../src/quality/analyze.js";
import { RULES } from "../src/quality/analyze.js";
import { findBrowser } from "../src/render/browser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "mermaid");
const goldens = join(here, "golden", "mermaid");
const fixture = (name: string): string => readFileSync(join(fixtures, name), "utf8");
const golden = (name: string): string => readFileSync(join(goldens, name), "utf8");

describe("mermaid geometry helpers", () => {
  it("parses edge ends from data-ids, node ids may contain underscores", () => {
    const known = new Set(["n_user", "n_agent", "A", "B_2", "A_1"]);
    expect(endsOfEdge("L_n_user_n_agent_0", known)).toEqual({ src: "n_user", dst: "n_agent" });
    expect(endsOfEdge("L_A_1_B_2_3", known)).toEqual({ src: "A_1", dst: "B_2" });
    expect(endsOfEdge("id_A_B_2_1", known)).toEqual({ src: "A", dst: "B_2" });
    expect(endsOfEdge("L_n_user_zzz_0", known)).toBeUndefined();
    expect(endsOfEdge("edge0", known)).toBeUndefined();
  });

  it("maps svg roles to kinds", () => {
    expect(kindOfRole("flowchart-v2")).toBe("graph");
    expect(kindOfRole("stateDiagram")).toBe("state");
    expect(kindOfRole("classDiagram")).toBe("class");
    expect(kindOfRole("er")).toBe("erd");
    expect(kindOfRole("pie")).toBeUndefined();
  });

  it("drops segments under 2 px but keeps both ends", () => {
    expect(dropTinySegments([[0, 0], [0, 0.4], [0, 50], [30, 50]])).toEqual([[0, 0], [0, 50], [30, 50]]);
    expect(dropTinySegments([[0, 0], [10, 0], [10, 0.5]])).toEqual([[0, 0], [10, 0.5]]);
    expect(dropTinySegments([[1, 1], [1, 1]])).toEqual([[1, 1], [1, 1]]);
  });

  it("snaps an end that stops inside a curved node's box back onto the side it arrives at", () => {
    const box = { x: 100, y: 10, w: 135, h: 70 };
    // arriving from the left at a cylinder whose cap curves the outline 3.5 px in
    expect(snapToBox([[0, 23], [60, 23], [103.5, 23]], "end", box)).toEqual([[0, 23], [60, 23], [100, 23]]);
    // leaving from the right side, route stored start first
    expect(snapToBox([[231.5, 40], [300, 40]], "start", box)).toEqual([[235, 40], [300, 40]]);
    // arriving from above and from below
    expect(snapToBox([[150, -20], [150, 13]], "end", box)).toEqual([[150, -20], [150, 10]]);
    expect(snapToBox([[150, 150], [150, 77]], "end", box)).toEqual([[150, 150], [150, 80]]);
    // a stub that runs along a rounded end to the real port (stadium) is not an arrival: left alone
    expect(snapToBox([[852.66, 776], [852.98, 763.2], [882.98, 763.2]], "start", { x: 710, y: 744, w: 142.98, h: 32 })).toEqual([[852.66, 776], [852.98, 763.2], [882.98, 763.2]]);
    // an end already outside, a diagonal last segment, an end beside the box, and a far end stay as they are
    expect(snapToBox([[0, 23], [90, 23]], "end", box)).toEqual([[0, 23], [90, 23]]);
    expect(snapToBox([[0, 0], [103, 30]], "end", box)).toEqual([[0, 0], [103, 30]]);
    expect(snapToBox([[0, 200], [103, 200]], "end", box)).toEqual([[0, 200], [103, 200]]);
    expect(snapToBox([[0, 23], [180, 23]], "end", { ...box, x: 100 })).toEqual([[0, 23], [180, 23]]);
  });

  it("no geometry: every rule is skipped", () => {
    expect(geometryOf(undefined, "timeline")).toEqual({ elements: [], rulesSkipped: Object.keys(RULES) });
  });

  it("hints name layouts, directions and label text, never coordinates", () => {
    const rows = mermaidHints(
      [
        { code: "node-overlap", severity: "hard", elements: [], detail: "two nodes overlap" },
        { code: "label-on-node", severity: "hard", elements: [], detail: "a label sits on a node" },
        { code: "arrow-crossings", severity: "soft", elements: [], detail: "9 crossings" },
        { code: "cli-failure", severity: "hard", elements: [], detail: "no hint for this" },
      ],
      { layout: "elk" },
    );
    expect(rows.map((r) => r.code)).toEqual(["node-overlap", "label-on-node", "arrow-crossings"]);
    expect(rows[0]!.fix).toContain("--layout dagre");
    expect(mermaidHints([{ code: "node-overlap", severity: "hard", elements: [], detail: "x" }], { layout: "dagre" })[0]!.fix).toContain("--layout elk");
    expect(rows.every((r) => !/\b\d+ ?px\b|\bx=|\by=/.test(r.fix))).toBe(true);
  });
});

// ---- browser ----

let browser: MermaidBrowser | undefined;
let unavailable: string | undefined;

beforeAll(async () => {
  try {
    await findBrowser();
  } catch {
    unavailable = "no browser installed";
    return;
  }
  try {
    // `npm run build` writes the bundle; this covers a bare `vitest` run (the build script is atomic).
    if (!existsSync(bundleUrl())) execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-mermaid.mjs", import.meta.url))], { stdio: "pipe" });
    browser = await launchBrowser();
  } catch (error) {
    unavailable = `mermaid unavailable: ${(error as Error).message}`;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
}, 60_000);

const need = (ctx: TestContext): MermaidBrowser => {
  if (!browser) ctx.skip(unavailable ?? "no browser");
  return browser as MermaidBrowser;
};

async function draw(b: MermaidBrowser, source: string): Promise<MermaidRenderResult> {
  const page = await MermaidPage.open(b.context);
  try {
    return await renderOn(page, b.info, source);
  } finally {
    await page.close();
  }
}

describe("mermaid geometry (browser)", () => {
  it("day-rag-agent: 4 nodes, 1 zone, 6 labeled arrows, every end bound", async (ctx) => {
    const r = await draw(need(ctx), golden("day-rag-agent-DOWN.mmd"));
    const n = r.neutral!;
    expect(n.nodes.filter((x) => x.kind === "node")).toHaveLength(4);
    expect(n.nodes.filter((x) => x.kind === "zone")).toHaveLength(1);
    expect(n.edges).toHaveLength(6);
    expect(n.edges.every((e) => e.src && e.dst && e.label && e.text)).toBe(true);
    expect(n.nodes.find((x) => x.id === "n_search")!.parent).toBe("g_tools");
    expect(n.nodes.find((x) => x.id === "n_vdb")!.parent).toBe("g_tools");
    expect(n.nodes.find((x) => x.id === "n_user")!.parent).toBeUndefined();
    expect(r.stats).toMatchObject({ nodes: 4, edges: 6, clusters: 1 });

    const g = mermaidEngine.geometry!(r);
    const els = g.elements;
    expect(els.filter((e) => e.type === "arrow")).toHaveLength(6);
    expect(els.filter((e) => e.type === "arrow" && e.startBinding && e.endBinding)).toHaveLength(6);
    expect(els.filter((e) => e.id.startsWith("edge-label-"))).toHaveLength(6);
    expect(els.filter((e) => e.id.startsWith("node-"))).toHaveLength(4);
    expect(els.find((e) => e.id === "zone-g-g_tools")).toBeDefined();
    expect(els.find((e) => e.id === "node-n_search")!.groupIds).toEqual(["group-g_tools"]);
    // translated to the origin: nothing at x < 0 or y < 0
    for (const e of els) {
      expect(e.x, e.id).toBeGreaterThanOrEqual(0);
      expect(e.y, e.id).toBeGreaterThanOrEqual(0);
    }
    expect(g.rulesSkipped).toEqual(expect.arrayContaining(["label-stored-offset", "text-exceeds-inscribed"]));
    expect(g.rulesSkipped).not.toContain("text-overflow");
    expect(() => analyzeScene({ elements: els })).not.toThrow();
  });

  it("shapes: diamond, ellipse and rectangle follow the drawn shape", async (ctx) => {
    const r = await draw(need(ctx), fixture("a.mmd"));
    const byId = new Map(mermaidEngine.geometry!(r).elements.map((e) => [e.id, e]));
    expect(byId.get("node-B")!.type).toBe("diamond");
    expect(byId.get("node-D")!.type).toBe("ellipse");
    expect(byId.get("node-A")!.type).toBe("rectangle");
    expect(r.neutral!.nodes.find((n) => n.id === "C")!.parent).toBe("Backend");
  });

  it("edge routes end on the node borders (not the centres) and match the drawn path", async (ctx) => {
    const r = await draw(need(ctx), "flowchart TD\n  A[One] --> B[Two]\n  A --> C[Three]\n  B --> D[Four]\n  C --> D\n  D --> A\n");
    const boxes = new Map(r.neutral!.nodes.map((n) => [n.id, n.box]));
    for (const e of r.neutral!.edges) {
      const [s, d] = [boxes.get(e.src)!, boxes.get(e.dst)!];
      const first = e.poly[0]!;
      const last = e.poly[e.poly.length - 1]!;
      const onBorder = (b: { x: number; y: number; w: number; h: number }, p: [number, number]) =>
        Math.min(Math.abs(p[0] - b.x), Math.abs(p[0] - b.x - b.w), Math.abs(p[1] - b.y), Math.abs(p[1] - b.y - b.h)) < 8;
      expect(onBorder(s, first), `${e.id} start`).toBe(true);
      expect(onBorder(d, last), `${e.id} end`).toBe(true);
    }
  });

  it("every edge end of a fan-out sits on its node's border and the head is drawn from the recorded end", async (ctx) => {
    const src = `flowchart LR
  H[Hub] --> A
  H --> B
  H --> C
  H --> D
`;
    const r = await draw(need(ctx), src);
    const hub = r.neutral!.nodes.find((n) => n.id === "H")!.box;
    for (const e of r.neutral!.edges) {
      const first = e.poly[0]!;
      expect(first[0], e.id).toBeCloseTo(hub.x + hub.w, 0); // right side of the hub
      expect(first[1], e.id).toBeGreaterThan(hub.y);
      expect(first[1], e.id).toBeLessThan(hub.y + hub.h);
      expect(first[1], e.id).not.toBeCloseTo(hub.y + hub.h / 2, 3); // not the centre: ends are spread
    }
    // all four starts differ
    expect(new Set(r.neutral!.edges.map((e) => e.poly[0]![1])).size).toBe(4);
  });

  it("a cylinder end lies on the box side after snapping, so the checker finds no sunk arrowhead", async (ctx) => {
    const src = `flowchart LR
  A1 --> DB[(Store)]
  A2 --> DB
  A3 --> DB
  A4 --> DB
  A5 --> DB
`;
    const r = await draw(need(ctx), src);
    const db = r.neutral!.nodes.find((n) => n.id === "DB")!;
    expect(db.shape).toBe("cylinder");
    for (const e of r.neutral!.edges) expect(e.poly[e.poly.length - 1]![0], e.id).toBeCloseTo(db.box.x, 1);
    const codes = analyzeScene({ elements: mermaidEngine.geometry!(r).elements }).findings.map((x) => x.code);
    expect(codes).not.toContain("arrowhead-inside-node");
    expect(codes).not.toContain("arrow-detached");
  });

  it("underscored ids and edge labels resolve to their nodes", async (ctx) => {
    const r = await draw(need(ctx), "flowchart LR\n  A_1 -->|go| B_2\n  B_2 --> A_1\n");
    expect(r.neutral!.edges.map((e) => [e.src, e.dst])).toEqual([["A_1", "B_2"], ["B_2", "A_1"]]);
    expect(r.neutral!.edges[0]!.text).toBe("go");
  });

  it("all translation goldens: ends bound, and no overlap, intrusion or detached-arrow findings", async (ctx) => {
    const b = need(ctx);
    const files = readdirSync(goldens).filter((f) => f.endsWith(".mmd"));
    for (let i = 0; i < files.length; i += 4) {
      await Promise.all(
        files.slice(i, i + 4).map(async (f) => {
          const r = await draw(b, golden(f));
          expect(r.neutral!.edges.filter((e) => !e.src || !e.dst), f).toEqual([]);
          const g = mermaidEngine.geometry!(r);
          const codes = analyzeScene({ elements: g.elements }).findings.map((x) => x.code);
          for (const bad of ["node-overlap", "zone-intrusion", "arrow-detached", "arrow-through-node"]) expect(codes, `${f}: ${bad}`).not.toContain(bad);
        }),
      );
    }
  }, 120_000);

  it("sequence: participants and messages, no lifeline edges", async (ctx) => {
    const r = await draw(need(ctx), fixture("sequence.mmd"));
    const n = r.neutral!;
    expect(n.nodes.map((x) => x.id).sort()).toEqual(["A", "B"]);
    expect(n.edges.map((e) => [e.src, e.dst, e.text])).toEqual([["A", "B", "Hello"], ["B", "A", "Hi"], ["A", "B", "ping"]]);
    const g = mermaidEngine.geometry!(r);
    expect(g.rulesSkipped).toEqual(expect.arrayContaining(["arrow-crossings", "route-ratio", "text-overflow"]));
    expect(g.elements.filter((e) => e.type === "arrow")).toHaveLength(3);
    expect(r.stats.extra).toMatchObject({ participants: 2, messages: 3 });
  });

  it("class, er and state diagrams bind their edges", async (ctx) => {
    const b = need(ctx);
    const cls = await draw(b, fixture("class.mmd"));
    expect(cls.neutral!.edges.map((e) => [e.src, e.dst])).toEqual([["Animal", "Dog"]]);
    const er = await draw(b, fixture("er.mmd"));
    expect(er.neutral!.edges.map((e) => [e.src, e.dst, e.text])).toEqual([["CUSTOMER", "ORDER", "places"], ["ORDER", "LINE_ITEM", "contains"]]);
    expect(er.stats.extra.tables).toBe(3);
    const st = await draw(b, fixture("state.mmd"));
    expect(st.neutral!.edges).toHaveLength(4);
    expect(st.neutral!.edges.every((e) => e.src && e.dst)).toBe(true);
    for (const r of [cls, er, st]) expect(mermaidEngine.geometry!(r).rulesSkipped).toContain("arrow-crossings");
  });

  it("gitGraph, mindmap and timeline are aggregate-only: counts, no elements, every rule skipped", async (ctx) => {
    const b = need(ctx);
    for (const [file, kind] of [["gitgraph.mmd", "gitgraph"], ["mindmap.mmd", "mindmap"], ["timeline.mmd", "timeline"]] as const) {
      const r = await draw(b, fixture(file));
      expect(r.kind).toBe(kind);
      const g = mermaidEngine.geometry!(r);
      expect(g.elements, file).toEqual([]);
      expect(g.rulesSkipped, file).toEqual(Object.keys(RULES));
      expect(r.stats.width, file).toBeGreaterThan(0);
    }
  });

  it("the drawing is determined by the source: geometry matches across fresh pages", async (ctx) => {
    const b = need(ctx);
    const src = golden("day-cicd-pipeline-DOWN.mmd");
    const one = await draw(b, src);
    const two = await draw(b, src);
    expect(two.neutral).toEqual(one.neutral);
    expect(two.stats).toEqual(one.stats);
  });
});
