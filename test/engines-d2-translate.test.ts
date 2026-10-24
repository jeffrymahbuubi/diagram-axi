// D2 translation choices made with the QA checker (U10): zone title corner and size, edge label size, label wrapping.

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { translateGraph } from "../src/engines/d2/translate.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { disposeD2 } from "../src/engines/d2/wasm.js";

afterAll(async () => {
  await disposeD2();
});

const translate = (dsl: string): string => translateGraph(parse(dsl).graph).source;

describe("label wrapping", () => {
  it("breaks a long edge label at spaces, keeping every word", () => {
    const src = translate("a -> b : this edge label is far too long for one line\n");
    const label = /a -> b: "([^"]*)"/.exec(src)![1]!;
    expect(label).toContain("\\n");
    expect(label.replace(/\\n/g, " ")).toBe("this edge label is far too long for one line");
    for (const line of label.split("\\n")) expect(line.length).toBeLessThanOrEqual(14);
  });

  it("leaves a short label and a long unbreakable word whole", () => {
    expect(translate("a -> b : short one\n")).toContain('a -> b: "short one"');
    expect(translate("a -> b : internationalization_configuration\n")).toContain('"internationalization_configuration"');
  });

  it("wraps node labels at 20 chars and zone titles at 12", () => {
    const src = translate('group g "A rather long group title here" {\n  n[Authentication gateway service]\n}\n');
    expect(src).toContain('g: "A rather\\nlong group\\ntitle here"');
    expect(src).toContain('n: "Authentication\\ngateway service"');
  });

  it("keeps explicit line breaks and wraps each line on its own", () => {
    const src = translate("n[short\\nthis second line is rather long indeed]\n");
    const label = /n: "([^"]*)"/.exec(src)![1]!;
    expect(label.startsWith("short\\nthis second line")).toBe(true);
    for (const line of label.split("\\n")) expect(line.length).toBeLessThanOrEqual(20);
  });
});

describe("zone titles and edge label size", () => {
  const src = translate('group g "Zone" {\n  a[A]\n}\nb[B]\na -> b : go\nb -> a\n');

  it("zone titles sit top-left at 16 px", () => {
    expect(src).toMatch(/g: "Zone" \{\n {2}label\.near: top-left\n {2}style\.font-size: 16\n/);
  });

  it("labelled edges get 14 px text in the node-label ink, unlabelled edges none", () => {
    expect(src).toMatch(/g\.a -> b: "go" \{\n {2}style\.stroke: "#1e1e1e"\n {2}style\.font-size: 14\n {2}style\.font-color: "#1e1e1e"\n/);
    expect(src).toMatch(/b -> g\.a: \{\n {2}style\.stroke: "#1e1e1e"\n\}/);
  });

  it("the translation compiles, and the zone title lies inside its zone and is small", async () => {
    const r = await renderD2(src, { layout: "elk" });
    const zone = r.neutral!.nodes.find((n) => n.id === "g")!;
    const title = r.neutral!.labels.find((l) => l.ownerId === "g")!;
    expect(title.box.x).toBeGreaterThanOrEqual(zone.box.x);
    expect(title.box.x + title.box.w).toBeLessThanOrEqual(zone.box.x + zone.box.w);
    expect(title.box.y).toBeGreaterThanOrEqual(zone.box.y);
    expect(title.box.h).toBeLessThan(28);
  });
});
