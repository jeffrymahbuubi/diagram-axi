// extract aggregate: filter -> focus -> cut -> roll-up -> cycles -> hubs -> stubs, on hand-written and synthetic RawGraphs.

import { describe, expect, it } from "vitest";
import { FocusNotFoundError, aggregate as aggregateIsolating, sccsOf, type AggregateOptions, type View } from "../src/extract/aggregate.js";
import type { RawGraph } from "../src/extract/types.js";
import { matchGlob } from "../src/extract/glob.js";
import { MAX_DEGREE, MAX_DEPTH } from "../src/lint/rules.js";
import { hubApp, raw, smallApp, synthetic, type EdgeSpec } from "./fixtures/extract/synthetic/graphs.js";

/** The cut, roll-up, filter and hub tests look at every box, so they run with the isolated ones kept; "isolated files and folders" covers the default. */
const aggregate = (g: RawGraph, o: AggregateOptions = {}): View => aggregateIsolating(g, { isolated: "show", ...o });

const groupDepth = (v: View, key: string | undefined): number => {
  let d = 0;
  for (let g = v.groups.find((x) => x.key === key); g; g = v.groups.find((x) => x.key === g?.parent)) d++;
  return d;
};

/** The count identities documented on ViewSummary.edges. */
function expectCountsAddUp(v: View): void {
  const { edges: e, files: f, nodes: n } = v.summary;
  expect(e.raw).toBe(e.filteredFiles + e.dangling + e.typeOnly + e.live);
  expect(e.live).toBe(e.outsideFocus + e.boundary + e.inFocus);
  expect(e.inFocus).toBe(e.self + e.rolled);
  expect(e.rolled).toBe(e.hubDropped + e.drawn);
  expect(v.edges.filter((x) => !x.stub).reduce((s, x) => s + x.weight, 0)).toBe(e.drawn);
  expect(f.total).toBe(f.generated + f.excluded + f.tests + f.kept);
  expect(n.visible).toBe(v.nodes.length);
  expect(n.files + n.dirs + n.rest + n.stubs + n.externals).toBe(n.visible);
  expect(v.nodes.filter((x) => x.kind === "file" || x.kind === "dir" || x.kind === "rest").reduce((s, x) => s + x.files, 0)).toBe(f.covered - v.summary.isolated.files);
  for (const x of v.edges.filter((y) => !y.stub)) expect(x.evidence.length).toBe(x.weight);
}

describe("synthetic 300-file graph (table test)", () => {
  const cases: Array<[string, AggregateOptions]> = [
    ["default", {}],
    ["max 10", { maxNodes: 10 }],
    ["max 40", { maxNodes: 40 }],
    ["max 3", { maxNodes: 3 }],
    ["types kept", { types: true }],
    ["flat", { group: "none" }],
    ["dir level", { level: "dir" }],
    ["externals count", { externals: "count" }],
    ["hubs shown", { hubs: "show" }],
    ["focus dir", { focus: "pkg03", depth: 1 }],
    ["focus file", { focus: "pkg05/s2/f3.ts", depth: 2, dir: "out" }],
  ];
  for (const seed of [1, 2, 3]) {
    for (const [name, opts] of cases) {
     for (const isolated of ["show", "hide"] as const) {
      it(`seed ${seed}, ${name}, isolated ${isolated}: budget respected, counts add up, depth <= ${MAX_DEPTH}`, () => {
        const g = synthetic(seed);
        g.externals = [{ name: "zod", count: 4, files: 3 }];
        const v = aggregate(g, { ...opts, isolated });
        const max = opts.maxNodes ?? 25;
        expect(v.nodes.length).toBeLessThanOrEqual(max);
        expect(v.summary.budget.exceeded).toBe(false);
        expectCountsAddUp(v);
        for (const x of v.groups) expect(groupDepth(v, x.key)).toBeLessThanOrEqual(MAX_DEPTH);
        for (const x of v.edges) (expect(v.nodes.some((n) => n.key === x.from)).toBe(true), expect(v.nodes.some((n) => n.key === x.to)).toBe(true));
        if (opts.group === "none") expect(v.groups).toEqual([]);
        // MAX_DEGREE holds unless the hubs were asked to be shown
        if (opts.hubs !== "show") {
          const deg = new Map<string, number>();
          for (const x of v.edges) (deg.set(x.from, (deg.get(x.from) ?? 0) + 1), deg.set(x.to, (deg.get(x.to) ?? 0) + 1));
          expect(Math.max(0, ...deg.values())).toBeLessThanOrEqual(MAX_DEGREE);
        }
      });
     }
    }
  }

  it("is deterministic", () => {
    expect(JSON.stringify(aggregate(synthetic(7)))).toBe(JSON.stringify(aggregate(synthetic(7))));
  });

  it("--level file shows every file and is not budgeted", () => {
    const v = aggregate(synthetic(1), { level: "file" });
    expect(v.nodes.filter((n) => n.kind === "file")).toHaveLength(300);
    expect(v.groups.every((g) => groupDepth(v, g.key) <= MAX_DEPTH)).toBe(true);
    expectCountsAddUp(v);
  });
});

describe("containment cut", () => {
  const files = ["x.ts", "a/f1.ts", "a/f2.ts", "a/f3.ts", "a/f4.ts", "b/g1.ts", "b/g2.ts", "b/g3.ts", "b/g4.ts", "c/h1.ts", "c/h2.ts"];
  const edges: EdgeSpec[] = [["x.ts", "a/f1.ts"], ["x.ts", "a/f2.ts"], ["x.ts", "a/f3.ts"], ["a/f4.ts", "x.ts"]];
  const open = (v: View): string[] => v.groups.map((g) => g.path).sort();

  it("expands by score (subtreeFiles * (1 + weightedDegree)), skipping what does not fit", () => {
    // scores: a = 4 * (1 + 4) = 20, b = 4, c = 2; start 4 nodes
    expect(open(aggregate(raw(files, edges), { maxNodes: 7 }))).toEqual(["a"]);
    expect(open(aggregate(raw(files, edges), { maxNodes: 8 }))).toEqual(["a", "c"]);
    expect(open(aggregate(raw(files, edges), { maxNodes: 11 }))).toEqual(["a", "b", "c"]);
    expect(open(aggregate(raw(files, edges), { maxNodes: 4 }))).toEqual([]);
  });

  it("breaks score ties by path", () => {
    const v = aggregate(raw(["a/1.ts", "a/2.ts", "b/1.ts", "b/2.ts"], []), { maxNodes: 3 });
    expect(v.groups.map((g) => g.path)).toEqual(["a"]);
  });

  it("labels collapsed directories with their file count", () => {
    const v = aggregate(raw(files, edges), { maxNodes: 4 });
    expect(v.nodes.map((n) => n.label)).toEqual(["a/ (4 files)", "b/ (4 files)", "c/ (2 files)", "x.ts"]);
  });

  it("compresses single-child directory chains into one node", () => {
    const v = aggregate(raw(["lib/a.ts", "app/main/java/com/x/A.ts", "app/main/java/com/x/B.ts"], [["lib/a.ts", "app/main/java/com/x/A.ts"]]), { maxNodes: 2 });
    const chain = v.nodes.find((n) => n.kind === "dir");
    expect(chain?.path).toBe("app/main/java/com/x");
    expect(chain?.label).toBe("app/main/java/com/x/ (2 files)");
  });

  it("starts below a root whose only child is a directory", () => {
    const v = aggregate(raw(["only/a.ts", "only/b.ts", "only/sub/c.ts", "only/sub/d.ts"], []), { maxNodes: 25 });
    expect(v.summary.effectiveRoot).toBe("only");
    expect(v.nodes.map((n) => n.label)).toContain("a.ts");
  });

  it("flattens groups deeper than MAX_DEPTH with path-prefixed labels", () => {
    const f = ["a/b/c/d/x.ts", "a/b/c/d/y.ts", "a/b/c/e/z.ts", "a/b/c/e/w.ts", "a/b/q/u.ts", "a/b/q/v.ts", "a/k/m.ts", "a/k/n.ts", "z.ts"];
    const v = aggregate(raw(f, [["z.ts", "a/b/c/d/x.ts"]]), { level: "file" });
    expect(Math.max(...v.groups.map((g) => groupDepth(v, g.key)))).toBe(MAX_DEPTH);
    const deep = v.nodes.find((n) => n.path === "a/b/c/d/x.ts");
    const grp = v.groups.find((g) => g.key === deep?.group);
    expect(groupDepth(v, grp?.key)).toBe(MAX_DEPTH);
    expect(deep?.label.endsWith("/x.ts")).toBe(true);
    expect(deep?.label).toBe(deep?.path.slice((grp?.path.length ?? 0) + 1));
  });

  it("--group none keeps no groups and labels with the path under the root", () => {
    const v = aggregate(raw(["layout/engine.ts", "layout/route.ts", "cli/args.ts", "cli/main.ts"], []), { group: "none", maxNodes: 2 });
    expect(v.groups).toEqual([]);
    expect(v.nodes.map((n) => n.label)).toEqual(["cli/ (2 files)", "layout/ (2 files)"]);
    const w = aggregate(raw(["layout/engine.ts", "layout/route.ts", "cli/args.ts", "cli/main.ts"], []), { group: "none", level: "file" });
    expect(w.nodes.map((n) => n.label)).toEqual(["cli/args.ts", "cli/main.ts", "layout/engine.ts", "layout/route.ts"]);
  });

  it("buckets an over-wide root into one '+N more files' node", () => {
    const f = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const e: EdgeSpec[] = [["f00.ts", "f01.ts"], ["f59.ts", "f01.ts"]];
    const v = aggregate(raw(f, e), { maxNodes: 25 });
    expect(v.nodes).toHaveLength(25);
    const rest = v.nodes.filter((n) => n.kind === "rest");
    expect(rest).toHaveLength(1);
    expect(rest[0]?.files).toBe(60 - 24);
    expectCountsAddUp(v);
  });

  it("--expand forces directories open even past the budget, and says so", () => {
    const v = aggregate(raw(files, edges), { maxNodes: 4, expand: ["b", "a"] });
    expect(open(v)).toEqual(["a", "b"]);
    expect(v.summary.budget.exceeded).toBe(true);
    expect(v.summary.warnings.some((w) => w.includes("over --max-nodes"))).toBe(true);
  });

  it("--expand reaches into nested directories (opening the ancestors)", () => {
    const v = aggregate(raw(["a/b/x.ts", "a/b/y.ts", "a/c/z.ts", "a/c/w.ts", "q.ts"], []), { maxNodes: 2, expand: ["a/b"] });
    expect(open(v)).toEqual(["a", "a/b"]);
  });

  it("--level dir never expands below depth 1", () => {
    const v = aggregate(synthetic(1), { level: "dir" });
    expect(v.groups).toEqual([]);
    expect(v.nodes.every((n) => n.kind === "dir" || n.kind === "rest")).toBe(true);
  });
});

describe("filters (nothing dropped silently)", () => {
  it("hides tests, generated paths and .d.ts, counting each", () => {
    const v = aggregate(smallApp());
    expect(v.summary.files).toMatchObject({ total: 15, tests: 2, generated: 2, kept: 11 });
    expect(v.hidden.tests).toEqual(["core/engine.test.ts", "test/engine.test.ts"]);
    expect(v.nodes.some((n) => n.path.includes("test"))).toBe(false);
    expect(v.summary.edges).toMatchObject({ raw: 23, filteredFiles: 3, typeOnly: 2 });
    expectCountsAddUp(v);
  });

  it("--tests keeps test files", () => {
    const v = aggregate(smallApp(), { tests: true });
    expect(v.summary.files.tests).toBe(0);
    expect(v.nodes.some((n) => n.path === "core/engine.test.ts")).toBe(true);
    expectCountsAddUp(v);
  });

  it("hides type-only edges by default, --types keeps them and marks the edge", () => {
    const hidden = aggregate(smallApp());
    expect(hidden.edges.some((e) => e.typeOnly)).toBe(false);
    const kept = aggregate(smallApp(), { types: true });
    const t = kept.edges.find((e) => e.to === "file:core/types.ts" && e.from === "file:core/engine.ts");
    expect(t).toMatchObject({ typeOnly: true, weight: 1 });
    expect(kept.summary.edges.typeOnly).toBe(0);
    expectCountsAddUp(kept);
  });

  it("--exclude and --include use globs and are counted", () => {
    expect(aggregate(smallApp(), { exclude: ["util", "cli/**"] }).summary.files.excluded).toBe(6);
    const inc = aggregate(smallApp(), { include: ["core/*.ts"] });
    expect(inc.nodes.map((n) => n.path).sort()).toEqual(["core/emit.ts", "core/engine.ts", "core/parse.ts", "core/types.ts"]);
    expectCountsAddUp(inc);
  });

  it("glob matcher", () => {
    expect(matchGlob("src/a/b.test.ts", "*.test.ts")).toBe(true);
    expect(matchGlob("src/gen/x.ts", "src/gen")).toBe(true);
    expect(matchGlob("src/gen/x.ts", "gen/**")).toBe(true);
    expect(matchGlob("src/generic/x.ts", "gen")).toBe(false);
    expect(matchGlob("a/b/c.ts", "a/*/c.ts")).toBe(true);
    expect(matchGlob("a/b/d/c.ts", "a/*/c.ts")).toBe(false);
    expect(matchGlob("a/b/d/c.ts", "a/**/c.ts")).toBe(true);
  });

  it("counts externals; count and show draw detached nodes", () => {
    expect(aggregate(smallApp()).nodes.some((n) => n.kind === "external")).toBe(false);
    const c = aggregate(smallApp(), { externals: "count" });
    expect(c.nodes.find((n) => n.kind === "external")?.label).toBe("npm (3 packages)");
    const s = aggregate(smallApp(), { externals: "show" });
    expect(s.nodes.filter((n) => n.kind === "external").map((n) => n.label)).toEqual(["@scope/pkg", "lodash", "zod"]);
    expect(s.summary.externals).toEqual({ packages: 3, builtins: 1, shown: 3 });
    expect(s.hidden.externals.map((x) => x.name)).toEqual(["@scope/pkg", "lodash", "zod"]);
  });

  it("reports unresolved and warnings", () => {
    const v = aggregate(smallApp());
    expect(v.summary.unresolved).toBe(1);
  });
});

describe("roll-up", () => {
  it("sums raw edges per ordered pair, drops self edges, keeps both directions", () => {
    const v = aggregate(
      raw(["a/1.ts", "a/2.ts", "b/1.ts", "b/2.ts"], [["a/1.ts", "b/1.ts"], ["a/2.ts", "b/1.ts"], ["b/1.ts", "a/1.ts"], ["a/1.ts", "a/2.ts"]]),
      { maxNodes: 2 },
    );
    expect(v.nodes.map((n) => n.key)).toEqual(["dir:a", "dir:b"]);
    expect(v.edges.map((e) => [e.from, e.to, e.weight])).toEqual([["dir:a", "dir:b", 2], ["dir:b", "dir:a", 1]]);
    expect(v.summary.edges.self).toBe(1);
    expectCountsAddUp(v);
  });

  it("marks edges dynamic only when every constituent is dynamic", () => {
    const v = aggregate(raw(["a.ts", "b.ts", "c.ts"], [["a.ts", "b.ts", { dyn: true }], ["a.ts", "c.ts", { dyn: true }], ["a.ts", "c.ts"]]), { level: "file" });
    expect(v.edges.map((e) => [e.to, e.dynamic])).toEqual([["file:b.ts", true], ["file:c.ts", false]]);
  });
});

describe("hubs", () => {
  it("drops incoming edges of a node with degree > MAX_DEGREE and labels it", () => {
    const v = aggregate(hubApp());
    const hub = v.nodes.find((n) => n.path === "shared/ast.ts");
    expect(hub?.notes).toEqual(["used by 12"]);
    expect(hub?.color).toBe("yellow");
    expect(v.edges.some((e) => e.to === hub?.key)).toBe(false);
    expect(v.summary.hubs).toEqual([{ key: "file:shared/ast.ts", path: "shared/ast.ts", usedBy: 12, uses: 0, shown: 0 }]);
    expect(v.summary.edges.hubDropped).toBe(12);
    expect(v.hidden.hubEdges).toHaveLength(12);
    expectCountsAddUp(v);
  });

  it("--hubs show restores the edges", () => {
    const v = aggregate(hubApp(), { hubs: "show" });
    expect(v.edges.filter((e) => e.to === "file:shared/ast.ts")).toHaveLength(12);
    expect(v.summary.edges.hubDropped).toBe(0);
    expect(v.summary.hubsShown).toBe(true);
    expectCountsAddUp(v);
  });

  it("caps an outgoing fan-out at MAX_DEGREE and says how many uses are hidden", () => {
    const targets = Array.from({ length: 12 }, (_, i) => `t/t${String(i).padStart(2, "0")}.ts`);
    const v = aggregate(raw(["main.ts", ...targets], targets.map((t, i): EdgeSpec => ["main.ts", t, { line: i + 1 }])));
    const main = v.nodes.find((n) => n.path === "main.ts");
    expect(main?.notes).toEqual([`${12 - MAX_DEGREE} uses hidden`]);
    expect(v.edges).toHaveLength(MAX_DEGREE);
    expect(v.summary.edges.hubDropped).toBe(12 - MAX_DEGREE);
    expectCountsAddUp(v);
  });
});

describe("cycles", () => {
  it("colors members of a strongly connected component red and lists them", () => {
    const v = aggregate(smallApp());
    expect(v.sccs).toEqual([["file:core/emit.ts", "file:core/parse.ts"]]);
    expect(v.summary.cycles).toEqual([["core/emit.ts", "core/parse.ts"]]);
    expect(v.nodes.filter((n) => n.color === "red").map((n) => n.path)).toEqual(["core/emit.ts", "core/parse.ts"]);
  });

  it("tarjan finds 3-cycles and nested components, ignores DAGs and self loops", () => {
    expect(sccsOf(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "a"], ["c", "d"]])).toEqual([["a", "b", "c"]]);
    expect(sccsOf(["a", "b", "c"], [["a", "b"], ["b", "c"]])).toEqual([]);
    expect(sccsOf(["a"], [["a", "a"]])).toEqual([]);
    expect(sccsOf(["a", "b", "c", "d"], [["a", "b"], ["b", "a"], ["c", "d"], ["d", "c"], ["b", "c"]])).toEqual([["a", "b"], ["c", "d"]]);
  });
});

describe("focus", () => {
  const chain = raw(["n/a.ts", "n/b.ts", "n/c.ts", "n/d.ts", "n/e.ts"], [["n/a.ts", "n/b.ts"], ["n/b.ts", "n/c.ts"], ["n/c.ts", "n/d.ts"], ["n/d.ts", "n/e.ts"]]);

  it("BFS to --depth both ways; unreached neighbours become '... +k more' stubs", () => {
    const v = aggregate(chain, { focus: "n/c.ts", depth: 1 });
    expect(v.nodes.filter((n) => n.kind === "file").map((n) => n.path)).toEqual(["n/b.ts", "n/c.ts", "n/d.ts"]);
    const stubs = v.nodes.filter((n) => n.kind === "stub");
    expect(stubs.map((s) => [s.label, s.path])).toEqual([["... +1 more", "n/b.ts"], ["... +1 more", "n/d.ts"]]);
    expect(v.edges.filter((e) => e.stub).map((e) => e.from)).toEqual(["file:n/b.ts", "file:n/d.ts"]);
    expect(v.nodes.find((n) => n.path === "n/c.ts")).toMatchObject({ color: "green", mark: "focus", notes: ["focus"] });
    expect(v.summary.edges).toMatchObject({ boundary: 2, inFocus: 2, outsideFocus: 0 });
    expect(v.summary.focus).toMatchObject({ reached: 3, files: 1 });
    expectCountsAddUp(v);
  });

  it("--dir out follows imports only and counts the rest as outside", () => {
    const v = aggregate(chain, { focus: "n/c.ts", depth: 1, dir: "out" });
    expect(v.nodes.filter((n) => n.kind === "file").map((n) => n.path)).toEqual(["n/c.ts", "n/d.ts"]);
    expect(v.nodes.filter((n) => n.kind === "stub")).toHaveLength(1);
    expect(v.summary.edges).toMatchObject({ boundary: 1, inFocus: 1, outsideFocus: 2 });
    expectCountsAddUp(v);
  });

  it("--dir in follows dependents; a deeper --depth reaches further and fewer stubs remain", () => {
    expect(aggregate(chain, { focus: "n/c.ts", depth: 5, dir: "in" }).nodes.filter((n) => n.kind === "file").map((n) => n.path)).toEqual(["n/a.ts", "n/b.ts", "n/c.ts"]);
    expect(aggregate(chain, { focus: "n/c.ts", depth: 5 }).nodes.some((n) => n.kind === "stub")).toBe(false);
  });

  it("focuses on a directory, and keeps stubs inside the budget", () => {
    const g = synthetic(1);
    const v = aggregate(g, { focus: "pkg03", depth: 1, maxNodes: 12 });
    expect(v.nodes.length).toBeLessThanOrEqual(12);
    expect(v.summary.focus?.files).toBe(25);
    expectCountsAddUp(v);
  });

  it("folds a stub into the label when the node has no edge budget left", () => {
    const mids = Array.from({ length: MAX_DEGREE }, (_, i) => `m${i}.ts`);
    const g = raw(["f.ts", "z.ts", "far.ts", ...mids], [...mids.map((m): EdgeSpec => ["f.ts", m]), ...mids.map((m): EdgeSpec => [m, "z.ts"]), ["z.ts", "far.ts"]]);
    const v = aggregate(g, { focus: "f.ts", depth: 2, dir: "out" });
    expect(v.nodes.some((n) => n.kind === "stub")).toBe(false);
    expect(v.nodes.find((n) => n.path === "z.ts")?.notes).toEqual(["... +1 more"]);
    expectCountsAddUp(v);
  });

  it("throws FocusNotFoundError for an unknown path", () => {
    expect(() => aggregate(chain, { focus: "nope" })).toThrow(FocusNotFoundError);
  });
});

describe("evidence", () => {
  it("every drawn edge is backed by raw edges (path and line)", () => {
    const v = aggregate(smallApp(), { types: true });
    for (const e of v.edges) {
      expect(e.evidence.length).toBeGreaterThan(0);
      for (const ev of e.evidence) expect(smallApp().edges.some((r) => r.from === ev.path && r.line === ev.line)).toBe(true);
    }
  });
});
