// Mermaid layout tuning (U10): room for edge ends (sizing.ts), subgraph title places (titles.ts) and the
// translation of an empty group. The pure parts need no browser; the rest skip without one.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { parse } from "../src/dsl/parser.js";
import type { NeutralEdge, NeutralNode, NeutralScene } from "../src/engines/neutral.js";
import { mermaidEngine } from "../src/engines/mermaid/index.js";
import { MermaidPage, bundleUrl, launchBrowser, type MermaidBrowser } from "../src/engines/mermaid/page.js";
import { renderOn, type MermaidRenderResult } from "../src/engines/mermaid/render.js";
import { DEFAULT_SIZING, endSide, growNodes, roundStadiums, sideOf } from "../src/engines/mermaid/sizing.js";
import { alignTitles, moveTitles, segmentHitsBox } from "../src/engines/mermaid/titles.js";
import { moveLabels, placeLabels, samples } from "../src/engines/mermaid/labels.js";
import { esc, translate } from "../src/engines/mermaid/translate.js";
import { analyzeScene } from "../src/quality/analyze.js";
import { findBrowser } from "../src/render/browser.js";

const node = (id: string, x: number, y: number, w = 180, h = 47, kind: "node" | "zone" = "node"): NeutralNode => ({ id, kind, box: { x, y, w, h }, shape: "rectangle" });
const edge = (src: string, dst: string, poly: [number, number][], extra: Partial<NeutralEdge> = {}): NeutralEdge => ({ id: `${src}>${dst}`, src, dst, poly, ...extra });

describe("sizing: room for edge ends", () => {
  it("reads the side from the way the route runs, so a diamond's end deep inside its box still counts on its side", () => {
    const box = { x: 100, y: 100, w: 184, h: 184 };
    // leaves a diamond's lower-left outline (point well inside the box) going down: the bottom side
    expect(endSide(box, [[150, 230], [150, 330], [20, 330]], "start")).toBe("S");
    // arrives travelling right: it meets the left side
    expect(endSide(box, [[0, 150], [60, 150], [130, 150]], "end")).toBe("W");
    // arrives travelling up: the bottom side; leaves going up: the top
    expect(endSide(box, [[150, 400], [150, 250]], "end")).toBe("S");
    expect(endSide(box, [[150, 130], [150, 0]], "start")).toBe("N");
    // no usable segment: nearest side of the box
    expect(endSide(box, [[100, 150], [100, 150.2]], "start")).toBe("W");
  });

  it("names the side of the box a point is nearest to", () => {
    const box = { x: 100, y: 100, w: 180, h: 47 };
    expect(sideOf(box, [100, 120])).toBe("W");
    expect(sideOf(box, [280, 120])).toBe("E");
    expect(sideOf(box, [150, 100])).toBe("N");
    expect(sideOf(box, [150, 147])).toBe("S");
  });

  it("grows a hub whose side is too short for its edge ends: height for a left or right side", () => {
    const hub = node("hub", 0, 100);
    const scene: NeutralScene = {
      nodes: [hub, ...[0, 1, 2, 3, 4, 5].map((i) => node(`w${i}`, 400, i * 80))],
      edges: [0, 1, 2, 3, 4, 5].map((i) => edge("hub", `w${i}`, [[180, 110 + i * 5], [300, 110 + i * 5], [300, 20 + i * 80], [400, 20 + i * 80]])),
      labels: [],
    };
    const grown = growNodes(scene, {})!;
    // 6 arrowless ends: 2 x 14 + 5 x 12 = 88 px; the node is 47 px, its label box was 17 px: 17 + 41
    expect(grown.hub!.h).toBeCloseTo(47 - 30 + (2 * 22 + 5 * 12 - 47), 1);
    expect(grown.hub!.w).toBeUndefined();
    // the workers have one end each: untouched
    expect(Object.keys(grown)).toEqual(["hub"]);
  });

  it("width for a top or bottom side, and arrowheads need more room than arrowless ends", () => {
    const sink = node("sink", 200, 300, 80, 47);
    const scene: NeutralScene = {
      nodes: [sink, node("a", 0, 0), node("b", 150, 0), node("c", 300, 0)],
      edges: [
        edge("a", "sink", [[90, 47], [205, 300]], { endArrow: true }),
        edge("b", "sink", [[230, 47], [230, 300]], { endArrow: true }),
        edge("c", "sink", [[390, 47], [250, 300]], { endArrow: true }),
      ],
      labels: [],
    };
    const grown = growNodes(scene, {})!;
    expect(grown.sink!.w).toBeCloseTo(80 - 30 + (2 * 22 + 2 * 20.5 - 80), 1);
    expect(grown.sink!.h).toBeUndefined();
    const noHeads: NeutralScene = { ...scene, edges: scene.edges.map((e) => ({ ...e, endArrow: false })) };
    expect(growNodes(noHeads, {})).toBeUndefined(); // 2 x 14 + 2 x 12 = 52 < 80
  });

  it("two edges between the same nodes on one side get the pair spacing", () => {
    const scene: NeutralScene = {
      nodes: [node("a", 0, 0), node("b", 300, 0)],
      edges: [edge("a", "b", [[180, 10], [300, 10]]), edge("b", "a", [[300, 36], [180, 36]], { startArrow: false, endArrow: true })],
      labels: [],
    };
    const grown = growNodes(scene, {})!;
    // east side of a: 2 ends, one with a head, same pair: 2 x 14 + 1 x 22 = 50 > 47
    expect(grown.a!.h).toBeCloseTo(47 - 30 + (2 * 22 + DEFAULT_SIZING.pair - 47), 1);
  });

  it("a self-loop needs the side divided by k + 1 (ELK's loop ports), and a grown node is not grown again", () => {
    const n = node("n", 100, 100);
    const loop = edge("n", "n", [[100, 118], [70, 118], [70, 126], [100, 126]], { endArrow: true });
    const scene: NeutralScene = { nodes: [n], edges: [loop], labels: [] };
    const grown = growNodes(scene, {})!;
    expect(grown.n!.h).toBeCloseTo(47 - 30 + (2 * 22 + 3 * 20.5 - 47), 1);
    // after the re-render the node is big enough: nothing more to grow
    const big: NeutralScene = { nodes: [node("n", 100, 100, 180, 110)], edges: [loop], labels: [] };
    expect(growNodes(big, grown)).toBeUndefined();
  });

  it("grows a node whose label is wider than it (a cylinder is 135 px wide whatever its text)", () => {
    const cyl = node("c", 0, 0, 135, 71);
    const scene: NeutralScene = { nodes: [cyl], edges: [], labels: [{ ownerId: "c", box: { x: 5, y: 20, w: 148, h: 17 }, text: "a long cylinder label" }] };
    const grown = growNodes(scene, {})!;
    expect(grown.c!.w).toBeCloseTo(135 - 30 + (148 + DEFAULT_SIZING.fit - 135), 1);
    expect(growNodes({ ...scene, labels: [{ ownerId: "c", box: { x: 5, y: 20, w: 100, h: 17 }, text: "short" }] }, {})).toBeUndefined();
  });

  it("keeps what an earlier pass asked for and adds the shortfall", () => {
    const hub = node("hub", 0, 100, 180, 60);
    const scene: NeutralScene = {
      nodes: [hub, ...[0, 1, 2, 3, 4, 5].map((i) => node(`w${i}`, 400, i * 80))],
      edges: [0, 1, 2, 3, 4, 5].map((i) => edge("hub", `w${i}`, [[180, 110 + i * 5], [300, 110 + i * 5], [300, 20 + i * 80], [400, 20 + i * 80]])),
      labels: [],
    };
    const again = growNodes(scene, { hub: { h: 30 } })!;
    expect(again.hub!.h).toBeCloseTo(30 + (2 * 22 + 5 * 12 - 60), 1);
  });
});

describe("titles: where a subgraph title goes", () => {
  const zone = node("g", 0, 0, 300, 200, "zone");
  const label = (x: number) => ({ ownerId: "g", box: { x, y: 1, w: 80, h: 22 }, text: "Title" });

  it("segment against box: through and inside count, touching and missing do not", () => {
    const b = { x: 10, y: 10, w: 20, h: 20 };
    expect(segmentHitsBox([20, 0], [20, 50], b)).toBe(true);
    expect(segmentHitsBox([12, 12], [14, 14], b)).toBe(true);
    expect(segmentHitsBox([0, 20], [50, 20], b)).toBe(true);
    expect(segmentHitsBox([10, 0], [10, 50], b)).toBe(false); // along the border
    expect(segmentHitsBox([40, 0], [40, 50], b)).toBe(false);
    expect(segmentHitsBox([0, 0], [8, 8], b)).toBe(false);
  });

  it("moves a title that an edge crosses in the middle to the left side", () => {
    // an edge entering at x = 150 (the middle) crosses a centred title: left is free
    const scene: NeutralScene = { nodes: [zone], edges: [edge("a", "b", [[150, -30], [150, 120]])], labels: [label(110)] };
    expect(alignTitles(scene)).toEqual({ g: [-104, 0] }); // box x 110 -> 6 (frame side + 6)
  });

  it("goes right when the left and the middle are crossed", () => {
    const both: NeutralScene = { nodes: [zone], edges: [edge("a", "b", [[40, -30], [40, 120]]), edge("c", "d", [[150, -30], [150, 120]])], labels: [label(110)] };
    expect(alignTitles(both)).toEqual({ g: [104, 0] }); // box x 110 -> 300 - 80 - 6 = 214
  });

  it("falls back to the bottom of the frame when every top place is crossed, if no node is in the way", () => {
    // an edge along the whole top crosses all three top places; the bottom-left place (y = 200 - 22 - 3) is free
    const all: NeutralScene = { nodes: [zone], edges: [edge("a", "b", [[-10, 10], [310, 10]])], labels: [label(110)] };
    expect(alignTitles(all)).toEqual({ g: [-104, 174] });
    // a node in the bottom band: left, middle and right of the bottom all collide, so the title stays crossed at the top
    const blocked: NeutralScene = { ...all, nodes: [zone, node("n", 10, 170, 280, 25)] };
    expect(alignTitles(blocked)).toEqual({ g: [-104, 0] }); // the left top place, the first of the equally crossed
  });

  it("leaves a title alone when the frame has no room for it to move", () => {
    const narrow = node("g", 0, 0, 90, 200, "zone");
    const scene: NeutralScene = { nodes: [narrow], edges: [edge("a", "b", [[45, -30], [45, 120]])], labels: [label(5)] };
    expect(alignTitles(scene)).toBeUndefined();
  });
});

describe("labels: a free spot on the edge's own route", () => {
  it("samples a polyline every step px, ends included, with the distance walked", () => {
    const pts = samples([[0, 0], [20, 0], [20, 10]], 10);
    expect(pts.map((p) => [p[0], p[1], p[2]])).toEqual([[0, 0, 0], [10, 0, 10], [20, 0, 20], [20, 10, 30]]);
  });

  const lbl = (x: number, y: number) => ({ x, y, w: 60, h: 20 });
  it("moves a label that sits on another edge to a free spot of its own route", () => {
    // edge a (vertical, x = 200) has its label at the crossing with edge b (horizontal, y = 100); the route runs 0..300
    const a = edge("a", "b", [[200, 0], [200, 300]], { label: lbl(170, 90), text: "x" });
    const b = edge("c", "d", [[0, 100], [400, 100]]);
    const scene: NeutralScene = { nodes: [node("a", 160, -50, 80, 40), node("b", 160, 310, 80, 40), node("c", -100, 80, 80, 40), node("d", 410, 80, 80, 40)], edges: [a, b], labels: [] };
    const moved = placeLabels(scene)!;
    const at = moved[a.id]!;
    expect(at[0]).toBe(200); // stays on the route
    expect(Math.abs(at[1] - 100)).toBeGreaterThanOrEqual(10); // clear of the crossing edge (half the label height)
    expect(at[1]).toBeGreaterThanOrEqual(18); // and of the route's ends
    // nothing collides: nothing moves
    expect(placeLabels({ ...scene, edges: [{ ...a, label: lbl(170, 200) }, b] })).toBeUndefined();
  });

  it("keeps a label of an edge inside its subgraph inside it", () => {
    const zone = node("z", 0, 0, 260, 300, "zone");
    const inner = (id: string, y: number): NeutralNode => ({ ...node(id, 100, y, 60, 30), parent: "z" });
    // the label hangs out of the frame (x 230..290) on a route at x = 260-ish; a spot on the horizontal part is inside
    const e = edge("p", "q", [[130, 30], [130, 150], [250, 150], [250, 250]], { label: lbl(225, 140), text: "wide" });
    const scene: NeutralScene = { nodes: [zone, inner("p", 0), inner("q", 250)], edges: [e], labels: [] };
    const at = placeLabels(scene)![e.id]!;
    expect(at[0] - 30).toBeGreaterThanOrEqual(2);
    expect(at[0] + 30).toBeLessThanOrEqual(258);
  });

  it("turns the move into the translate read from the svg", () => {
    const e = edge("a", "b", [[200, 0], [200, 300]], { label: lbl(170, 90), text: "x" });
    const scene: NeutralScene = { nodes: [], edges: [{ ...e, id: "L_a_b_0" }], labels: [] };
    const svg = '<g class="edgeLabels"><g class="edgeLabel" transform="translate(324, 425.5)"><g class="label" data-id="L_a_b_0" transform="translate(0, -10)"></g></g></g>';
    // center moves from (200, 100) to (200, 160): the translate follows by (0, 60)
    expect(moveLabels(scene, svg, { L_a_b_0: [200, 160] })).toEqual({ L_a_b_0: [324, 485.5] });
    expect(moveLabels(scene, svg, undefined)).toBeUndefined();
  });
});

describe("moveTitles and roundStadiums", () => {
  it("turns the shifts into label translates read from the svg of the measured render", () => {
    const zone = node("g_a", 0, 0, 300, 200, "zone");
    const scene: NeutralScene = { nodes: [zone], edges: [edge("a", "b", [[150, -30], [150, 120]])], labels: [{ ownerId: "g_a", box: { x: 110, y: 1, w: 80, h: 22 }, text: "T" }] };
    const svg = '<g class="clusters"><g class="cluster " id="dax-g_b"><rect x="0" y="0"></rect><g class="cluster-label" transform="translate(5, 7)"></g></g><g class="cluster c_x" id="dax-g_a" data-look="classic"><rect x="0"></rect><g class="cluster-label " transform="translate(115.5, 0)"></g></g></g>';
    expect(moveTitles(svg, "dax", alignTitles(scene))).toEqual({ g_a: [11.5, 0] });
    // a frame too narrow for the title to move: nothing to do
    expect(moveTitles(svg, "dax", alignTitles({ ...scene, nodes: [node("g_a", 0, 0, 90, 200, "zone")] }))).toBeUndefined();
  });

  it("declares the nodes that had to grow as rounded rectangles, not stadiums", () => {
    const src = ['  n_a(["Alpha"]):::c_blue', '  n_b(["Beta"])', '  n_c["Gamma"]', "  n_a --> n_b", ""].join("\n");
    expect(roundStadiums(src, ["n_a"])).toBe(['  n_a("Alpha"):::c_blue', '  n_b(["Beta"])', '  n_c["Gamma"]', "  n_a --> n_b", ""].join("\n"));
    expect(roundStadiums(src, ["n_a", "n_b", "n_c", "bad id"])).toContain('n_b("Beta")');
  });
});

describe("translate: label escaping", () => {
  it("keeps # as it is, and breaks an entity-shaped #35; with a zero-width space", () => {
    expect(esc("issue #5")).toBe("issue #5");
    expect(esc("see #35; now")).toBe("see #​35; now");
  });

  it("turns quotes and backticks into characters svg text can show; & < > stay entities", () => {
    expect(esc('say "hi" ("x")')).toBe("say “hi” (“x”)");
    expect(esc("`code`")).toBe("ˋcodeˋ");
    expect(esc("a & b <c>\nnext")).toBe("a #amp; b #lt;c#gt;<br>next");
  });
});

describe("translate: an empty group", () => {
  it("gets a hidden node, so Mermaid draws a frame", () => {
    const src = 'dir RIGHT\ngroup g "Nothing here" {\n}\na[A]\n';
    const parsed = parse(src);
    const { source, losses } = translate(parsed.graph);
    expect(losses.map((l) => l.code)).toEqual(["empty-group"]);
    expect(source).toMatch(/subgraph g_g \["Nothing here"\]\n {4}eg_g\[" "\]\n {2}end/);
    expect(source).toContain("style eg_g fill:none,stroke:none");
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

const hard = (r: MermaidRenderResult): string[] =>
  analyzeScene({ elements: mermaidEngine.geometry!(r).elements }).findings.filter((f) => f.severity === "hard").map((f) => f.code);

describe("mermaid layout tuning (browser)", () => {
  it("labels with #, quotes, & and < draw as typed (no literal entity text)", async (ctx) => {
    const src = ["dir RIGHT", "a[A #5]", "b[B]", 'a --> b : "issue #5"', 'b --> a : "say \\"hi\\" #35; & <b>"', ""].join("\n");
    const parsed = parse(src);
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const r = await draw(need(ctx), translate(parsed.graph).source);
    const drawn = r.neutral!.edges.map((e) => e.text);
    expect(drawn[0]).toBe("issue #5");
    expect(drawn[1]).toBe("say “hi” #​35; & <b>");
    expect(r.svg).not.toMatch(/&amp;(#35|quot|num);/);
  }, 60_000);

  it("a fan-out of 8 to the right gives the hub room: ends 10+ px apart, no collinear or crowded finding", async (ctx) => {
    const workers = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `  H --> W${i}`).join("\n");
    const r = await draw(need(ctx), `flowchart LR\n${workers}\n`);
    const hub = r.neutral!.nodes.find((n) => n.id === "H")!.box;
    expect(hub.h).toBeGreaterThan(47 * 2);
    const ys = r.neutral!.edges.map((e) => e.poly[0]![1]).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(10);
    expect(hard(r)).toEqual([]);
  }, 60_000);

  it("a self-loop leaves its node by 20+ px and spans 16+ px", async (ctx) => {
    const r = await draw(need(ctx), "flowchart TD\n  A[Worker] -->|retry| A\n  B[Src] --> A\n");
    expect(hard(r)).toEqual([]);
    const loop = r.neutral!.edges.find((e) => e.src === "A" && e.dst === "A")!;
    expect(loop.poly.length).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("an empty subgraph is drawn as a frame inside the canvas", async (ctx) => {
    const { source } = translate(parse('dir DOWN\ngroup g "Empty" {\n}\na[A]\nb[B]\na -> b\n').graph);
    const r = await draw(need(ctx), source);
    const zone = r.neutral!.nodes.find((n) => n.id === "g_g")!;
    expect(zone.box.h).toBeGreaterThan(20);
    expect(zone.box.x).toBeGreaterThanOrEqual(0);
    expect(hard(r)).toEqual([]);
  }, 60_000);

  it("a subgraph title steps aside for an edge that would cross it", async (ctx) => {
    const src = "flowchart TD\n  X[Outside] --> A\n  subgraph G [Pool]\n    A[Inner]\n  end\n";
    const r = await draw(need(ctx), src);
    expect(hard(r)).not.toContain("zone-title-crossed");
  }, 60_000);
});
