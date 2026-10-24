// U5: D2 / Mermaid / routing syntax slices. Budget + parse-shape checks only
// (no engine dependency yet; once U2/U3 land the examples should also be
// validated with their parsers).

import { describe, expect, it } from "vitest";
import { D2_SLICES, D2_TOPICS, renderD2Slice } from "../src/guide/d2-slices.js";
import { MERMAID_SLICES, MERMAID_TOPICS, renderMermaidSlice } from "../src/guide/mermaid-slices.js";
import { ROUTING_SLICE, renderRoutingSlice } from "../src/guide/routing-slice.js";
import { SLICE_TOKEN_BUDGET } from "../src/guide/slices.js";
import { DENSE_MIN_NODES, DENSE_RATIO, MANY_NODES, MAX_CROSS_GROUP, MAX_DEGREE, MAX_LINE, MAX_PARALLEL } from "../src/lint/rules.js";

const tokens = (s: string) => Math.ceil(s.length / 4);
const TOOLS = ["diagram-axi", "npx -y diagram-axi"];

const rendered: Array<{ id: string; render: (tool: string) => string | undefined }> = [
  ...D2_TOPICS.map((t) => ({ id: `d2 ${t}`, render: (tool: string) => renderD2Slice(t, tool) })),
  ...MERMAID_TOPICS.map((t) => ({ id: `mermaid ${t}`, render: (tool: string) => renderMermaidSlice(t, tool) })),
  { id: "routing", render: (tool: string) => renderRoutingSlice(tool) },
];

describe("engine syntax slices", () => {
  it("has the 11 planned slices", () => {
    expect(D2_TOPICS).toEqual(["sequence", "class", "erd", "style", "example"]);
    expect(MERMAID_TOPICS).toEqual(["state", "timeline", "gitgraph", "mindmap", "example"]);
    expect(ROUTING_SLICE.topic).toBe("routing");
    expect(rendered).toHaveLength(11);
  });

  for (const tool of TOOLS) {
    it.each(rendered)(`'$id' stays within the token budget (${tool})`, ({ render }) => {
      const out = render(tool) as string;
      expect(out).toBeDefined();
      expect(tokens(out)).toBeLessThanOrEqual(SLICE_TOKEN_BUDGET);
    });
  }

  it.each(rendered)("'$id' ends with a help[] block and substitutes the tool prefix", ({ render }) => {
    const out = render("diagram-axi") as string;
    expect(out).toMatch(/\nhelp\[\d+\]:\n( {2}.+\n?)+$/);
    expect(out).not.toContain("$ ");
    expect(out).toMatch(/^syntax: /);
  });

  it("unknown topics return undefined", () => {
    expect(renderD2Slice("bogus", "x")).toBeUndefined();
    expect(renderMermaidSlice("bogus", "x")).toBeUndefined();
  });
});

describe("d2 examples (parse-shape)", () => {
  const balanced = (src: string) => {
    let depth = 0;
    for (const ch of src) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  };

  it.each(D2_SLICES)("'$topic' is non-empty, brace-balanced, tab-free source", (s) => {
    const src = s.example as string;
    expect(src.trim().length).toBeGreaterThan(0);
    expect(balanced(src)).toBe(true);
    expect(src).not.toContain("\t");
    expect(src).not.toMatch(/^\s*```/m);
  });

  it("sequence declares shape: sequence_diagram first and has messages", () => {
    const src = D2_SLICES.find((s) => s.topic === "sequence")?.example as string;
    expect(src.split("\n")[0]).toBe("shape: sequence_diagram");
    expect(src).toMatch(/\w+(\.\w+)? -> \w+(\.\w+)?: /);
  });

  it("class has a class shape with a method (key containing parentheses)", () => {
    const src = D2_SLICES.find((s) => s.topic === "class")?.example as string;
    expect(src).toContain("shape: class");
    expect(src).toMatch(/^\s+[+\-#]?\w+\(.*\)/m);
  });

  it("erd shows a sql_table example with PK/FK constraints and a column to column arrow", () => {
    const src = D2_SLICES.find((s) => s.topic === "erd")?.example as string;
    expect(src).toContain("shape: sql_table");
    expect(src).toContain("constraint: primary_key");
    expect(src).toContain("constraint: foreign_key");
    expect(src).toMatch(/^\w+\.\w+ -> \w+\.\w+$/m);
  });

  it("style documents layouts, sketch and near", () => {
    const s = D2_SLICES.find((x) => x.topic === "style");
    const text = [...(s?.rules ?? []), s?.example ?? ""].join("\n");
    for (const w of ["dagre", "elk", "tala", "sketch", "near", "layout-engine"]) expect(text).toContain(w);
  });
});

describe("mermaid examples (parse-shape)", () => {
  const first = (src: string) => src.split("\n")[0]?.trim();
  const byTopic = (t: string) => MERMAID_SLICES.find((s) => s.topic === t)?.example as string;

  it.each(MERMAID_SLICES)("'$topic' has a recognised header and space-only indentation", (s) => {
    const src = s.example as string;
    expect(first(src)).toMatch(/^(stateDiagram-v2|timeline|gitGraph|mindmap)$/);
    expect(src).not.toContain("\t");
    expect(src).not.toMatch(/^```/m);
  });

  it("topics use their own diagram type", () => {
    expect(first(byTopic("state"))).toBe("stateDiagram-v2");
    expect(first(byTopic("timeline"))).toBe("timeline");
    expect(first(byTopic("gitgraph"))).toBe("gitGraph");
    expect(first(byTopic("mindmap"))).toBe("mindmap");
  });

  it("gitgraph gives every commit and merge an explicit unique id", () => {
    const lines = byTopic("gitgraph").split("\n").map((l) => l.trim());
    const ids: string[] = [];
    for (const l of lines.filter((x) => /^(commit|merge)\b/.test(x))) {
      const m = /\bid: "([^"]+)"/.exec(l);
      expect(m, l).not.toBeNull();
      ids.push((m as RegExpExecArray)[1] as string);
    }
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(renderMermaidSlice("gitgraph", "x")).toContain("explicit id");
  });

  it("mindmap has exactly one root and consistent indentation", () => {
    const body = byTopic("mindmap").split("\n").slice(1).filter((l) => l.trim());
    const indents = body.map((l) => /^ */.exec(l)?.[0].length ?? 0);
    const min = Math.min(...indents);
    expect(indents.filter((n) => n === min)).toHaveLength(1);
    expect(indents[0]).toBe(min);
    for (let i = 1; i < indents.length; i++) expect((indents[i] as number) - (indents[i - 1] as number)).toBeLessThanOrEqual(2);
  });

  it("state transitions and braces are balanced", () => {
    const src = byTopic("state");
    expect(src.split("{").length).toBe(src.split("}").length);
    expect(src).toContain("[*] -->");
    expect(src).toContain("--> [*]");
  });

  it("timeline rows are 'period : event' under title/section", () => {
    const rows = byTopic("timeline").split("\n").slice(1).map((l) => l.trim());
    for (const r of rows) expect(r).toMatch(/^(title |section |.+ ?: .+|: .+)/);
  });

  it("example is a complete state diagram", () => {
    const src = byTopic("example");
    expect(first(src)).toBe("stateDiagram-v2");
    expect(src).toContain("-->");
  });
});

describe("routing slice", () => {
  it("covers the KTD4 rules and the exact thresholds", () => {
    const out = renderRoutingSlice("diagram-axi");
    for (const w of ["--engine", "--target markdown", "editable", "sequence", "mindmap", "suggest d2", "--engine auto"]) {
      expect(out).toContain(w);
    }
  });

  it("states the thresholds the router and lints share", () => {
    const out = renderRoutingSlice("diagram-axi");
    expect(out).toContain(`<= ${MANY_NODES} nodes`);
    expect(out).toContain(`edges <= ${DENSE_RATIO} x nodes`);
    expect(out).toContain(`starts at ${DENSE_MIN_NODES} nodes`);
    expect(out).toContain(`> ${MAX_PARALLEL} edges`);
    expect(out).toContain(`<= ${MAX_DEGREE} arrows`);
    expect(out).toContain(`<= ${MAX_CROSS_GROUP} cross-group edges`);
    expect(out).toContain(`no label line > ${MAX_LINE} chars`);
    expect(out).not.toContain("1.5 x");
  });
});
