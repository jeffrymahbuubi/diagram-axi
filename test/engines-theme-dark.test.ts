// --theme dark: whatever sits on the dark canvas (edges, edge labels, zone titles) gets a light ink. D2 and Mermaid
// translations carry explicit inks, which the engines' dark themes cannot override. Browser-free: D2 renders in WASM.

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { D2_DARK_CANVAS, D2_DARK_INK, translateGraph } from "../src/engines/d2/translate.js";
import { disposeD2 } from "../src/engines/d2/wasm.js";
import { translate as translateMermaid } from "../src/engines/mermaid/translate.js";

afterAll(async () => {
  await disposeD2();
});

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const DSL = 'title "Pipeline"\ngroup z "Zone" :blue {\n  a[A]\n}\na -> b[B] : calls\nb -> c[C]\n';
const graph = () => parse(DSL).graph;

/** The drawing tags of the SVG body (style sheet and CDATA removed). */
function tags(svg: string): string[] {
  const body = svg.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  return body.match(/<(path|text|polygon|rect)\b[^>]*>/g) ?? [];
}
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const inkOf = (tag: string): string => (attr(tag, "stroke") ?? attr(tag, "fill") ?? "").toLowerCase();

describe("d2 dark translation", () => {
  it("light output is untouched by an explicit light theme and never uses the light ink", () => {
    expect(translateGraph(graph(), { theme: "light" }).source).toBe(translateGraph(graph()).source);
    expect(translateGraph(graph()).source).not.toContain(D2_DARK_INK);
  });

  it("dark: edges, edge labels and zone titles carry the light ink; node ink stays dark", () => {
    const src = translateGraph(graph(), { theme: "dark" }).source;
    expect(src).toContain(`a -> b: "calls" {\n  style.stroke: "${D2_DARK_INK}"\n  style.font-size: 14\n  style.font-color: "${D2_DARK_INK}"`);
    expect(src).toMatch(/b -> c:+ \{\n {2}style\.stroke: "#cdd6f4"/);
    expect(src).toMatch(/z: "Zone" \{[\s\S]*?style\.font-color: "#cdd6f4"/);
    expect(src).toMatch(/a: "A" \{[\s\S]*?style\.font-color: "#1e1e1e"/);
    expect(src.slice(src.indexOf("\na -> b"))).not.toContain("#1e1e1e");
  });
});

describe("d2 dark render (WASM, no browser)", () => {
  it("no connection or edge label is #1e1e1e, canvas is #1e1e2e, viewBox equals the light render's", async () => {
    const light = await renderD2(translateGraph(graph()).source, { theme: "light" });
    const dark = await renderD2(translateGraph(graph(), { theme: "dark" }).source, { theme: "dark" });

    const viewBoxes = (s: string): string[] => [...s.matchAll(/viewBox="([^"]*)"/g)].map((m) => m[1]!);
    expect(viewBoxes(dark.svg)).toEqual(viewBoxes(light.svg));
    expect([dark.width, dark.height]).toEqual([light.width, light.height]);

    const canvas = /<rect [^>]*fill="(#[0-9a-fA-F]{6})"[^>]*class=" fill-N7"/.exec(dark.svg)?.[1];
    expect(canvas?.toLowerCase()).toBe(D2_DARK_CANVAS);

    const all = tags(dark.svg);
    const connections = all.filter((t) => /class="connection/.test(t));
    expect(connections.length).toBeGreaterThanOrEqual(3); // 2 paths + the arrowhead
    for (const t of connections) {
      expect(inkOf(t), t).not.toBe("#1e1e1e");
      expect(contrast(inkOf(t), D2_DARK_CANVAS), t).toBeGreaterThanOrEqual(3);
    }

    // Edge label: the 14 px text.
    const label = all.find((t) => t.startsWith("<text") && /font-size:14px/.test(t));
    expect(label).toBeDefined();
    const labelInk = attr(label!, "fill")!.toLowerCase();
    expect(labelInk).toBe(D2_DARK_INK);
    expect(contrast(labelInk, D2_DARK_CANVAS)).toBeGreaterThanOrEqual(4.5);

    // A label can also sit on the zone fill; the zone title always does.
    const zone = all.find((t) => t.startsWith("<rect") && attr(t, "stroke") === "#868e96");
    const zoneFill = attr(zone!, "fill")!;
    expect(contrast(D2_DARK_INK, zoneFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(zoneFill, D2_DARK_CANVAS)).toBeGreaterThan(1.1); // the zone is still visible on the canvas
    const title = all.find((t) => t.startsWith("<text") && /font-size:16px/.test(t) && attr(t, "fill")?.toLowerCase() === D2_DARK_INK);
    expect(title).toBeDefined();

    // The only #1e1e1e text left is node text, which sits on a light pastel fill.
    for (const t of all.filter((x) => x.startsWith("<text") && attr(x, "fill")?.toLowerCase() === "#1e1e1e")) {
      expect(contrast("#1e1e1e", "#a5d8ff"), t).toBeGreaterThan(4.5);
    }
  });

  it("the light render still draws the edges in #1e1e1e", async () => {
    const light = await renderD2(translateGraph(graph()).source, { theme: "light" });
    const connections = tags(light.svg).filter((t) => /class="connection/.test(t));
    expect(connections.length).toBeGreaterThanOrEqual(3);
    for (const t of connections) expect(inkOf(t)).toBe("#1e1e1e");
  });
});

describe("mermaid dark translation", () => {
  it("light output keeps the dark line and white label chip; dark swaps them", () => {
    const light = translateMermaid(graph()).source;
    expect(translateMermaid(graph(), { theme: "light" }).source).toBe(light);
    expect(light).toContain('lineColor: "#1e1e1e"');
    expect(light).toContain('edgeLabelBackground: "#ffffff"');
    const dark = translateMermaid(graph(), { theme: "dark" }).source;
    expect(dark).toContain('lineColor: "#cdd6f4"');
    expect(dark).toContain('edgeLabelBackground: "#1e1e1e"');
    expect(contrast("#cdd6f4", "#1e1e1e")).toBeGreaterThanOrEqual(3);
  });
});
