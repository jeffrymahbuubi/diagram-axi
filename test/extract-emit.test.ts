// extract emit: View -> .exd (ids, labels, keywords, dedupe), the sidecar, byte-compared goldens, lint and layout quality.
// Regenerate goldens with: UPDATE_GOLDEN=1 npx vitest run test/extract-emit.test.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qualityFor, hasHard } from "../src/commands/shared.js";
import { parse } from "../src/dsl/parser.js";
import { layout } from "../src/layout/dagre-layout.js";
import { MAX_LINE } from "../src/lint/rules.js";
import { lint } from "../src/lint/rules.js";
import { buildScene } from "../src/scene/build.js";
import { aggregate, type AggregateOptions } from "../src/extract/aggregate.js";
import { sidecar } from "../src/extract/sidecar.js";
import { cutLine, toExd } from "../src/extract/to-exd.js";
import type { RawGraph } from "../src/extract/types.js";
import { hubApp, raw, smallApp, synthetic, type EdgeSpec } from "./fixtures/extract/synthetic/graphs.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "golden", "extract");
const ALLOWED = new Set(["cross-group-edges", "dense-graph"]);

function emit(g: RawGraph, o: AggregateOptions = {}) {
  const view = aggregate(g, o);
  const exd = toExd(view);
  return { view, exd, text: exd.text };
}

/** Parses the text and returns lint codes; asserts there are no parse errors or parser warnings. */
function lintCodes(text: string): string[] {
  const r = parse(text);
  expect(r.diagnostics).toEqual([]);
  return lint(r.graph).map((d) => d.code);
}

const goldens: Array<[string, () => RawGraph, AggregateOptions]> = [
  ["small", smallApp, {}],
  ["small-types-externals", smallApp, { types: true, externals: "count" }],
  ["small-focus", smallApp, { focus: "core/engine.ts", depth: 1 }],
  ["small-flat", smallApp, { group: "none" }],
  ["small-collapsed", smallApp, { maxNodes: 5 }],
  ["hubs", hubApp, { isolated: "show" }],
  ["hubs-folded", hubApp, {}],
  ["hubs-shown", hubApp, { hubs: "show" }],
  ["synthetic-300", () => synthetic(1), {}],
  ["synthetic-300-flat", () => synthetic(1), { group: "none", maxNodes: 15 }],
  ["synthetic-300-focus", () => synthetic(1), { focus: "pkg03/s1/f2.ts", depth: 2 }],
];

describe("goldens (byte-compared)", () => {
  for (const [name, make, opts] of goldens) {
    describe(name, () => {
      const { view, text } = emit(make(), opts);

      it("matches test/golden/extract/" + name + ".exd", () => {
        const file = join(GOLDEN, `${name}.exd`);
        if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
          mkdirSync(GOLDEN, { recursive: true });
          writeFileSync(file, text);
        }
        expect(text).toBe(readFileSync(file, "utf8"));
      });

      it("parses and lints clean except cross-group-edges / dense-graph", () => {
        // --hubs show restores the arrows into the hub, so busy-node is the expected, reported outcome there
        const bad = lintCodes(text).filter((c) => !ALLOWED.has(c) && !(name === "hubs-shown" && c === "busy-node"));
        expect(bad).toEqual([]);
      });

      it("uses LF only and is deterministic", () => {
        expect(text.includes("\r")).toBe(false);
        expect(emit(make(), opts).text).toBe(text);
      });

      it("keeps the view inside the node budget", () => {
        expect(view.nodes.length).toBeLessThanOrEqual(opts.maxNodes ?? 25);
      });

      it("has no HARD layout row (check-equivalent quality)", () => {
        const g = parse(text).graph;
        const rows = qualityFor(buildScene(g, layout({ graph: g, direction: "DOWN" })), g, "DOWN");
        expect(rows.filter((r) => r.severity === "hard")).toEqual([]);
        expect(hasHard(rows)).toBe(false);
      });
    });
  }
});

describe("ids", () => {
  it("prefixes and sanitizes ids, avoiding the parser keywords", () => {
    const { exd } = emit(raw(["dir.ts", "title.ts", "group/direction.ts", "group/x-y.ts"], [["dir.ts", "title.ts"]]), { level: "file", isolated: "show" });
    const ids = [...exd.ids.values(), ...exd.groupIds.values()];
    expect(ids.sort()).toEqual(["f_dir_ts", "f_group_direction_ts", "f_group_x_y_ts", "f_title_ts", "g_group"]);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(["dir", "direction", "title", "group"]).not.toContain(id);
    }
  });

  it("dedupes colliding ids with _2, _3 in a stable order", () => {
    const { exd, text } = emit(raw(["a-b.ts", "a_b.ts", "a.b.ts"], [["a-b.ts", "a_b.ts"], ["a_b.ts", "a.b.ts"]]), { level: "file" });
    expect([...exd.ids.values()]).toEqual(["f_a_b_ts", "f_a_b_ts_2", "f_a_b_ts_3"]);
    expect(lintCodes(text)).toEqual([]);
  });

  it("keeps ids unique across groups and nodes", () => {
    const { exd } = emit(raw(["a/b.ts", "a/c.ts", "a_b.ts"], [["a_b.ts", "a/b.ts"]]), { level: "file", isolated: "show" });
    const all = [...exd.ids.values(), ...exd.groupIds.values()];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("labels", () => {
  it("uses the basename in a group and 'dir/ (N files)' for a collapsed directory", () => {
    const { text } = emit(smallApp(), { maxNodes: 5 });
    expect(text).toContain("[cli/ (3 files)]");
    expect(text).toContain("[index.ts]");
  });

  it("cuts long labels to MAX_LINE keeping the file name (and the file count suffix)", () => {
    const long = "very/long/directory/name/that/keeps/going/on/and/on/file.ts";
    const cut = cutLine(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_LINE);
    expect(cut.startsWith("very/")).toBe(true);
    expect(cut.endsWith(".../file.ts")).toBe(true);
    // the case that read '...chmark/hooks-benchmark-async-await.js' before
    const bench = cutLine("examples/benchmark/hooks-benchmark-async-await.js");
    expect(bench).toBe("exampl.../hooks-benchmark-async-await.js");
    expect(bench.length).toBeLessThanOrEqual(MAX_LINE);
    const dir = cutLine("deeply/nested/package/structure/with/many/parts/ (12 files)");
    expect(dir.length).toBeLessThanOrEqual(MAX_LINE);
    expect(dir.endsWith("parts/ (12 files)")).toBe(true);
    expect(dir.startsWith("deeply/")).toBe(true);
    // a name that alone is too long is cut in the middle, both ends survive
    const wide = cutLine(`pkg/${"w".repeat(30)}-middle-${"z".repeat(30)}.config.ts`);
    expect(wide.length).toBeLessThanOrEqual(MAX_LINE);
    expect(wide).toContain("...");
    expect(wide.startsWith("pkg/")).toBe(true);
    expect(wide.endsWith(".config.ts")).toBe(true);
    expect(cutLine("short/name.ts")).toBe("short/name.ts");
    const { text } = emit(raw([`${"d".repeat(60)}/a.ts`, `${"d".repeat(60)}/b.ts`, "x.ts"], [["x.ts", `${"d".repeat(60)}/a.ts`]]), { level: "file", group: "none" });
    expect(lintCodes(text)).toEqual([]);
  });

  it("shields brackets and a leading paren in file names", () => {
    const { text } = emit(raw(["app/[id].tsx", "app/(group).ts", "app/b\\c.ts"], [["app/[id].tsx", "app/(group).ts"]]), { level: "file", isolated: "show" });
    expect(text).toContain("<id>.tsx");
    expect(lintCodes(text)).toEqual([]);
    const g = parse(text).graph;
    expect(g.nodes.find((n) => n.label.includes("group"))?.shape).toBe("rect");
  });

  it("writes hub notes as a second label line and colors cycles and hubs", () => {
    const { text, view } = emit(hubApp(), { isolated: "show" });
    expect(text).toContain("[ast.ts\\nused by 12] :yellow");
    const g = parse(text).graph;
    expect(g.nodes.find((n) => n.label.startsWith("ast.ts"))?.label).toBe("ast.ts\nused by 12");
    expect(view.summary.cycles).toEqual([["feat/u00.ts", "feat/u01.ts"]]);
    expect(g.nodes.filter((n) => n.color === "red")).toHaveLength(2);
  });

  it("title reports the files drawn by the view (isolated files are not in it)", () => {
    expect(emit(smallApp(), { isolated: "show" }).text.split("\n")[0]).toBe('title "imports: src (11 of 15 files)"');
    expect(emit(smallApp()).text.split("\n")[0]).toBe('title "imports: src (10 of 15 files)"');
  });
});

describe("edges", () => {
  it("uses x<N> labels, dashed for dynamic-only and dotted for kept type-only edges", () => {
    const { text } = emit(smallApp(), { types: true, level: "file" });
    expect(text).toMatch(/f_core_parse_ts <-> f_core_emit_ts|f_core_parse_ts -> f_core_emit_ts : x2/);
    expect(text).toMatch(/f_core_emit_ts --> f_util_fmt_ts/);
    expect(text).toMatch(/f_core_engine_ts -\.-> f_core_types_ts/);
  });

  it("merges a reciprocal pair with the same arrow and label into one <->", () => {
    const { text } = emit(raw(["a.ts", "b.ts"], [["a.ts", "b.ts"], ["b.ts", "a.ts"]]));
    expect(text).toContain("f_a_ts <-> f_b_ts"); // DSL reading order: the pair is listed under its lower source
    expect(text.match(/f_a_ts|f_b_ts/g)).toHaveLength(4);
    expect(lintCodes(text)).toEqual([]);
  });

  it("keeps both arrows when weights differ", () => {
    const { text } = emit(raw(["a.ts", "b.ts"], [["a.ts", "b.ts"], ["a.ts", "b.ts"], ["b.ts", "a.ts"]]));
    expect(text).toContain("f_a_ts -> f_b_ts : x2");
    expect(text).toContain("f_b_ts -> f_a_ts");
  });

  it("emits nodes inside their group body and edges after all groups", () => {
    const { text } = emit(smallApp());
    const lines = text.split("\n");
    const firstEdge = lines.findIndex((l) => / (->|-->|<->|-\.->|--) /.test(l));
    const lastBrace = lines.lastIndexOf("}");
    expect(firstEdge).toBeGreaterThan(lastBrace);
    expect(text).toMatch(/group g_cli "cli\/" \{\n  f_cli_args_ts\[args\.ts\]/);
  });

  it("a stub goes above an anchor that mostly imports (its arrows already run below) and below one that is mostly imported", () => {
    const g = raw(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], [["a.ts", "b.ts"], ["a.ts", "c.ts"], ["a.ts", "d.ts"], ["b.ts", "e.ts"]]);
    const { text } = emit(g, { focus: "b.ts", depth: 1 });
    expect(text).toContain("s_file_a_ts -- f_a_ts");
    expect(text).not.toContain("f_a_ts -- s_file_a_ts");
  });

  it("stub nodes are ellipses joined to their anchor by a plain line", () => {
    const { text, exd } = emit(raw(["n/a.ts", "n/b.ts", "n/c.ts", "n/d.ts"], [["n/a.ts", "n/b.ts"], ["n/b.ts", "n/c.ts"], ["n/c.ts", "n/d.ts"]]), { focus: "n/b.ts", depth: 1 });
    expect(text).toContain("s_file_n_c_ts(... +1 more)");
    expect(text).toContain("f_n_c_ts -- s_file_n_c_ts");
    expect(text).toContain("f_n_b_ts[b.ts\\nfocus] :green");
    expect(exd.ids.get("stub:file:n/c.ts")).toBe("s_file_n_c_ts");
    expect(lintCodes(text)).toEqual([]);
  });
});

describe("sidecar", () => {
  const g = smallApp();
  g.meta = { ...g.meta, rev: "a".repeat(40), dirty: false };
  const view = aggregate(g, { types: true, externals: "count" });
  const exd = toExd(view);
  const map = sidecar(view, exd, g);

  it("follows the schema and keeps a fixed key order", () => {
    expect(Object.keys(map)).toEqual(["schema", "meta", "nodes", "edges", "hidden"]);
    expect(Object.keys(map.meta)).toEqual(["root", "langs", "rev", "dirty", "extractor", "stats"]);
    expect(Object.keys(map.hidden)).toEqual(["externals", "tests", "hubEdges", "sccs", "isolated"]);
    expect(map.meta.stats).toEqual({ files: 15, edges: 23, unresolved: 1 });
    expect(map.hidden.tests).toEqual(["core/engine.test.ts", "test/engine.test.ts"]);
    expect(map.hidden.externals).toEqual([{ name: "@scope/pkg", edges: 1, files: 1 }, { name: "lodash", edges: 2, files: 2 }, { name: "zod", edges: 3, files: 2 }]);
    expect(JSON.stringify(sidecar(view, exd, g))).toBe(JSON.stringify(map));
  });

  it("maps every exd id to a path, and every edge endpoint is a node", () => {
    for (const id of exd.ids.values()) expect(map.nodes[id]).toBeDefined();
    for (const id of exd.groupIds.values()) expect(map.nodes[id]?.kind).toBe("group");
    expect(map.nodes["f_core_engine_ts"]).toEqual({ path: "core/engine.ts", kind: "file", loc: 10 });
    for (const e of map.edges) (expect(map.nodes[e.from]).toBeDefined(), expect(map.nodes[e.to]).toBeDefined());
  });

  it("every edge carries evidence (path, line) and its weight", () => {
    const e = map.edges.find((x) => x.from === "f_core_parse_ts" && x.to === "f_core_emit_ts");
    expect(e).toMatchObject({ weight: 2, typeOnly: false, dynamic: false, evidence: [{ path: "core/parse.ts", line: 40 }, { path: "core/parse.ts", line: 14 }].sort((a, b) => a.line - b.line) });
    for (const x of map.edges) expect(x.evidence.length).toBeGreaterThan(0);
  });

  it("lists strongly connected components by exd id", () => {
    expect(map.hidden.sccs).toEqual([["f_core_emit_ts", "f_core_parse_ts"]]);
  });

  it("records edges removed for hubs and caps evidence", () => {
    const h = hubApp();
    const v = aggregate(h, { isolated: "show" });
    const m = sidecar(v, toExd(v), h, { maxEvidence: 1 });
    expect(m.hidden.hubEdges).toHaveLength(12);
    expect(m.hidden.hubEdges[0]).toEqual({ from: "f_feat_u00_ts", to: "f_shared_ast_ts", weight: 1 });
    const synth = synthetic(1);
    const sv = aggregate(synth);
    const sm = sidecar(sv, toExd(sv), synth, { maxEvidence: 2 });
    expect(sm.edges.every((x) => x.evidence.length <= 2)).toBe(true);
  });

  it("omits rev and dirty outside a repo", () => {
    const h = hubApp();
    const v = aggregate(h);
    expect(Object.keys(sidecar(v, toExd(v), h).meta)).toEqual(["root", "langs", "extractor", "stats"]);
  });
});

describe("an empty or tiny graph", () => {
  it("emits a parseable file for zero files", () => {
    const { text } = emit(raw([], []));
    expect(parse(text).diagnostics).toEqual([]);
  });
  it("a single edge", () => {
    const e: EdgeSpec[] = [["a.ts", "b.ts"]];
    expect(lintCodes(emit(raw(["a.ts", "b.ts"], e)).text)).toEqual([]);
  });
});
