// U7: home view, syntax slices, SKILL.md. Spawns the built bin (pretest builds).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { MANY_NODES, MAX_DEGREE, MAX_DIAMOND_DEGREE, MAX_EDGE_WORDS, MAX_PARALLEL, lint } from "../src/lint/rules.js";
import { SLICES,SLICE_TOKEN_BUDGET, TOPICS, renderSlice } from "../src/guide/slices.js";
import { DESCRIPTION, DSL_TEASER, SKILL_DESCRIPTION, renderSkill, rootHelpText } from "../src/skill/content.js";
import { scanScenes } from "../src/commands/home.js";

const bin = fileURLToPath(new URL("../bin/diagram-axi.js", import.meta.url));
const run = (args: string[], cwd?: string) => spawnSync("node", [bin, ...args], { encoding: "utf8", cwd });
const tokens = (s: string) => Math.ceil(s.length / 4);

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "exd-guide-"));
  tmps.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const scene = (elements: unknown[]) => JSON.stringify({ type: "excalidraw", version: 2, elements });

describe("syntax slices", () => {
  for (const tool of ["diagram-axi", "npx -y diagram-axi"]) {
    it.each(["index", ...TOPICS])(`'%s' stays within the token budget (${tool})`, (topic) => {
      const out = renderSlice(topic, tool) as string;
      expect(tokens(out)).toBeLessThanOrEqual(SLICE_TOKEN_BUDGET);
    });
  }

  it.each(SLICES.filter((s) => s.example))("example of '$topic' parses with no diagnostics", (s) => {
    expect(parse(s.example as string).diagnostics).toEqual([]);
  });

  it("the index lists tips and its example is lint-clean", () => {
    expect(renderSlice("index", "diagram-axi")).toContain("tips");
    const tips = SLICES.find((s) => s.topic === "tips");
    expect(tips?.example).toBeDefined();
    const { graph, diagnostics } = parse(tips?.example as string);
    expect(diagnostics).toEqual([]);
    expect(lint(graph)).toEqual([]);
  });

  it("tips states the thresholds exported by the lint rules", () => {
    const out = renderSlice("tips", "diagram-axi") as string;
    expect(out).toContain(`<= ${MAX_PARALLEL} arrows per node pair`);
    expect(out).toContain(`<= ${MAX_DEGREE} arrows on one node`);
    expect(out).toContain(`<= ${MAX_DIAMOND_DEGREE} arrows`);
    expect(out).toContain(`edge labels <= ${MAX_EDGE_WORDS} words`);
    expect(out).toContain(`<= ~${MANY_NODES} nodes`);
    expect(out).toContain("quality:");
  });

  it("every slice ends with a help[] block", () => {
    for (const topic of ["index", ...TOPICS]) {
      const out = renderSlice(topic, "diagram-axi") as string;
      expect(out).toMatch(/\nhelp\[\d+\]:\n( {2}.+\n?)+$/);
    }
  });

  it("the home DSL teaser parses with no diagnostics", () => {
    expect(DSL_TEASER).toHaveLength(3);
    expect(parse(DSL_TEASER.join("\n")).diagnostics).toEqual([]);
  });

  it("documents what the parser does: fan-out, chains, aliases", () => {
    expect(parse("a[A], b[B] -> c[C], d[D]").graph.edges).toHaveLength(4);
    expect(parse("a[A] -> b[B] -> c[C]").graph.edges).toHaveLength(2);
    expect(parse("dir LR\na[A]").graph.direction).toBe("RIGHT");
    expect(parse("a(A\\nB)").graph.nodes[0]?.label).toBe("A\nB");
  });
});

describe("syntax command", () => {
  it("index exits 0 listing every topic", () => {
    const r = run(["syntax"]);
    expect(r.status).toBe(0);
    for (const t of TOPICS) expect(r.stdout).toContain(t);
    expect(r.stdout).toContain("help[");
  });

  it("serves a slice", () => {
    const r = run(["syntax", "edges"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("fan-out");
    expect(r.stderr).toBe("");
  });

  it("unknown topic exits 2 listing valid topics", () => {
    const r = run(["syntax", "bogus"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("error:");
    for (const t of TOPICS) expect(r.stdout).toContain(t);
  });
});

describe("home view", () => {
  it("empty directory: definitive empty state, teaser, help (AE5)", () => {
    const r = run([], tmp());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scenes: 0 .excalidraw files found under .");
    expect(r.stdout).toContain("dsl-teaser[3]:");
    expect(r.stdout).toContain("help[3]:");
    expect(r.stderr).toBe("");
  });

  it("lists a scene with its non-deleted element count", () => {
    const d = tmp();
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs", "arch.excalidraw"), scene([{ id: "a" }, { id: "b", isDeleted: true }, { id: "c", isDeleted: false }]));
    const r = run([], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/scenes\[1\]\{path,elements,modified\}:\n {2}docs\/arch\.excalidraw,2,\d{4}-\d\d-\d\dT\d\d:\d\dZ/);
    expect(r.stdout).toContain("inspect docs/arch.excalidraw");
  });

  it("skips node_modules, .git, dist, .claude and deep trees; reports unreadable scenes as -1", () => {
    const d = tmp();
    for (const skip of ["node_modules", ".git", "dist", ".claude"]) {
      mkdirSync(join(d, skip));
      writeFileSync(join(d, skip, "x.excalidraw"), scene([]));
    }
    mkdirSync(join(d, "a", "b", "c", "d", "e"), { recursive: true });
    writeFileSync(join(d, "a", "b", "c", "d", "ok.excalidraw"), scene([{ id: "1" }]));
    writeFileSync(join(d, "a", "b", "c", "d", "e", "too-deep.excalidraw"), scene([]));
    writeFileSync(join(d, "broken.excalidraw"), "{not json");
    const r = scanScenes(d);
    expect(r.scenes.map((s) => s.path).sort()).toEqual(["a/b/c/d/ok.excalidraw", "broken.excalidraw"]);
    expect(r.scenes.find((s) => s.path === "broken.excalidraw")?.elements).toBe(-1);
  });

  it("caps the list at 10 and reports the total", () => {
    const d = tmp();
    for (let i = 0; i < 12; i++) writeFileSync(join(d, `s${i}.excalidraw`), scene([]));
    const r = run([], d);
    expect(r.stdout).toContain("scenes[10 of 12 total]{path,elements,modified}:");
  });
});

describe("SKILL.md content", () => {
  const skill = renderSkill();
  it("triggers on diagram requests and states the golden path", () => {
    expect(skill).toMatch(/description: ".*excalidraw diagram/i);
    expect(skill).toMatch(/architecture diagram.*flowchart.*hand-drawn/i);
    expect(skill).toContain("npx -y diagram-axi syntax example");
    expect(skill).toContain("draw diagram.exd --png");
    expect(skill).toContain("inspect diagram.excalidraw");
  });
  it("stays within the 1,400 token budget (R11)", () => {
    expect(tokens(skill)).toBeLessThanOrEqual(1400);
  });
  it("teaches the engine choice: routing table, flags, native sources, slices", () => {
    expect(skill).toContain("## Choose the engine");
    expect(skill).toContain("--engine excalidraw|d2|mermaid");
    expect(skill).toContain("--engine auto");
    expect(skill).toContain("--target markdown");
    expect(skill).toContain("engine: suggest d2");
    expect(skill).toContain("syntax routing");
    expect(skill).toContain("engines install d2");
    expect(skill).toMatch(/.d2.*.mmd/);
  });
  it("lists known per-engine weaknesses and the suggest-d2 golden-path step", () => {
    expect(skill).toContain("## Known weaknesses");
    expect(skill).toContain("mid-word");
    expect(skill).toContain("--engine d2");
  });
  it("states README precedence, the keep-content d2 rule, --target editable, and no split-instead-of-d2 contradiction", () => {
    expect(skill).toContain("README/GitHub output wins over every other row");
    expect(skill).toContain("kept as is (all nodes, full labels) follow `engine: suggest d2`");
    expect(skill).toContain("--target editable");
    expect(skill).not.toContain("instead of switching engine");
  });
  it("mentions extract for learning a TS/JS codebase in at most 3 lines", () => {
    const lines = skill.split("\n").filter((l) => l.includes("extract"));
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(skill).toContain("npx -y diagram-axi extract src");
    expect(skill).toContain("`engine:` line");
    expect(skill).toContain("--focus <file>");
  });
  it("home and root help describe every engine command", () => {
    const help = rootHelpText();
    for (const c of ["draw", "render", "inspect", "check", "extract", "syntax", "engines"]) expect(help).toContain("  " + c + ",");
    expect(DESCRIPTION).toMatch(/Excalidraw, D2 or Mermaid/);
    expect(SKILL_DESCRIPTION).toMatch(/sequence.*Mermaid/);
  });
  it("embeds the example slice", () => {
    expect(skill).toContain(renderSlice("example", "npx -y diagram-axi"));
  });
});
