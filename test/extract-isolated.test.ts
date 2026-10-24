// extract aggregate, round 2 behaviour: isolated files and folders, the entry / focus marks, repeated labels, the automatic budget.

import { describe, expect, it } from "vitest";
import { aggregate as aggregateIsolating, type View } from "../src/extract/aggregate.js";
import type { RawGraph } from "../src/extract/types.js";
import { hubApp, raw, smallApp, synthetic, type EdgeSpec } from "./fixtures/extract/synthetic/graphs.js";

/** The aggregate tests above keep every box (`isolated: "show"`); here the default (isolated ones left out) is the subject. */
const aggregate = (g: RawGraph, o: Parameters<typeof aggregateIsolating>[1] = {}): View => aggregateIsolating(g, { isolated: "show", ...o });

/** The count identities documented on ViewSummary.edges. */
function expectCountsAddUp(v: View): void {
  const { edges: e, files: f, nodes: n } = v.summary;
  expect(e.raw).toBe(e.filteredFiles + e.dangling + e.typeOnly + e.live);
  expect(e.live).toBe(e.outsideFocus + e.boundary + e.inFocus);
  expect(e.inFocus).toBe(e.self + e.rolled);
  expect(e.rolled).toBe(e.hubDropped + e.drawn);
  expect(f.total).toBe(f.generated + f.excluded + f.tests + f.kept);
  expect(n.visible).toBe(v.nodes.length);
  expect(v.nodes.filter((x) => x.kind === "file" || x.kind === "dir" || x.kind === "rest").reduce((s, x) => s + x.files, 0)).toBe(f.covered - v.summary.isolated.files);
}

describe("isolated files and folders", () => {
  const app = (): RawGraph =>
    raw(
      ["main.ts", "lib/a.ts", "lib/b.ts", "tools/x.ts", "tools/y.ts", "tools/z.ts", "docs/e1.ts", "docs/e2.ts", "lone.ts"],
      [["main.ts", "lib/a.ts"], ["lib/a.ts", "lib/b.ts"], ["tools/x.ts", "tools/y.ts"], ["docs/e1.ts", "docs/e2.ts"]],
    );

  it("a file with no edge is left out: no box, no budget, reported", () => {
    const v = aggregateIsolating(app(), { level: "file" });
    // docs/ and tools/ only import within themselves: isolated as folders, with their files
    expect(v.nodes.map((n) => n.path).sort()).toEqual(["lib/a.ts", "lib/b.ts", "main.ts"]);
    expect(v.summary.isolated.items).toEqual([{ path: "docs", kind: "dir", files: 2 }, { path: "lone.ts", kind: "file", files: 1 }, { path: "tools", kind: "dir", files: 3 }]);
    expect(v.summary.isolated.files).toBe(6);
    expectCountsAddUp(v);
  });

  it("a folder whose only edges are inside it is isolated as a whole and costs nothing", () => {
    const shown = aggregate(app(), { maxNodes: 5, level: "dir" });
    expect(shown.nodes.map((n) => n.key)).toContain("dir:docs");
    const v = aggregateIsolating(app(), { maxNodes: 5, level: "dir" });
    expect(v.nodes.map((n) => n.key)).toEqual(["dir:lib", "file:main.ts"]);
    expect(v.summary.isolated.items.map((i) => i.path)).toEqual(["docs", "lone.ts", "tools"]);
    expect(v.summary.isolated.items.find((i) => i.path === "docs")).toEqual({ path: "docs", kind: "dir", files: 2 });
    expect(v.summary.isolated.files).toBe(6);
    expectCountsAddUp(v);
  });

  it("freed budget goes to what is connected (a folder opens that was collapsed before)", () => {
    const files = ["main.ts", ...Array.from({ length: 12 }, (_, i) => `ex/e${i}.ts`), "lib/a.ts", "lib/b.ts", "lib/c.ts"];
    const edges: EdgeSpec[] = [["main.ts", "lib/a.ts"], ["lib/a.ts", "lib/b.ts"], ["lib/b.ts", "lib/c.ts"]];
    const before = aggregate(raw(files, edges), { maxNodes: 4 });
    const after = aggregateIsolating(raw(files, edges), { maxNodes: 4 });
    expect(before.nodes.some((n) => n.path === "lib/a.ts")).toBe(false);
    expect(after.nodes.filter((n) => n.kind === "file").map((n) => n.path)).toEqual(["lib/a.ts", "lib/b.ts", "lib/c.ts", "main.ts"]);
    expect(after.summary.isolated.files).toBe(12);
  });

  it("files whose only imports go to a hub are not isolated: their folder is folded into one box that points at the hub", () => {
    const v = aggregateIsolating(hubApp());
    expect(v.summary.isolated.files).toBe(0);
    expect(v.nodes.map((n) => n.key).sort()).toEqual(["dir:feat", "file:main.ts", "file:shared/ast.ts", "file:shared/util.ts"]);
    expect(v.edges.map((e) => [e.from, e.to, e.weight])).toContainEqual(["dir:feat", "file:shared/ast.ts", 12]);
    expect(v.summary.hubs).toEqual([]);
    expectCountsAddUp(v);
    // without folding (isolated: show) the same graph keeps every importer as a box and the hub loses its arrows
    const open = aggregateIsolating(hubApp(), { isolated: "show" });
    expect(open.nodes.find((n) => n.path === "shared/ast.ts")?.notes).toEqual(["used by 12"]);
  });

  it("a single file that only imports a hub stays a box (nothing is folded away)", () => {
    const users = Array.from({ length: 10 }, (_, i) => `u${i}.ts`);
    const g = raw(["hub.ts", "x.ts", "y.ts", ...users], [...users.map((u): EdgeSpec => [u, "hub.ts"]), ["x.ts", "y.ts"]]);
    const v = aggregateIsolating(g, { maxNodes: 25 });
    expect(v.nodes.filter((n) => n.kind === "file")).toHaveLength(13);
    expect(v.summary.hubs.map((h) => h.path)).toEqual(["hub.ts"]);
    expect(v.summary.isolated.files).toBe(0);
  });

  it("opens a big folder partially: its best children plus one `+N more files` box", () => {
    const files = ["main.ts", ...Array.from({ length: 40 }, (_, i) => `lib/f${String(i).padStart(2, "0")}.ts`)];
    const edges: EdgeSpec[] = Array.from({ length: 40 }, (_, i): EdgeSpec => [i < 5 ? "main.ts" : `lib/f${String(i % 5).padStart(2, "0")}.ts`, `lib/f${String((i + 1) % 40).padStart(2, "0")}.ts`]);
    const v = aggregateIsolating(raw(files, edges), { maxNodes: 12 });
    const rest = v.nodes.filter((n) => n.kind === "rest");
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ path: "lib", group: "grp:lib" });
    expect(rest[0]?.label).toMatch(/^\+\d+ more files$/);
    expect(v.nodes.length).toBeLessThanOrEqual(12);
    expect(v.groups.map((g) => g.path)).toEqual(["lib"]);
    expectCountsAddUp(v);
    const flat = aggregateIsolating(raw(files, edges), { maxNodes: 12, group: "none" });
    expect(flat.nodes.find((n) => n.kind === "rest")?.label).toMatch(/^lib\/ \+\d+ more files$/);
  });

  it("the --focus file's neighbours are the children a partially opened folder keeps", () => {
    const files = ["main.ts", ...Array.from({ length: 40 }, (_, i) => `lib/f${String(i).padStart(2, "0")}.ts`)];
    const edges: EdgeSpec[] = [["main.ts", "lib/f33.ts"], ["main.ts", "lib/f34.ts"], ...Array.from({ length: 30 }, (_, i): EdgeSpec => [`lib/f${String(i).padStart(2, "0")}.ts`, `lib/f${String(i + 1).padStart(2, "0")}.ts`])];
    const v = aggregateIsolating(raw(files, edges), { maxNodes: 12, focus: "main.ts", depth: 1 });
    expect(v.nodes.filter((n) => n.kind === "file").map((n) => n.path)).toEqual(expect.arrayContaining(["lib/f33.ts", "lib/f34.ts", "main.ts"]));
  });

  it("a graph without any edge is drawn whole; isolated: show keeps every box", () => {
    const g = raw(["a.ts", "b.ts", "c.ts"], []);
    expect(aggregateIsolating(g).nodes).toHaveLength(3);
    expect(aggregateIsolating(g).summary.isolated.files).toBe(0);
    const h = aggregateIsolating(app(), { isolated: "show", level: "file" });
    expect(h.nodes).toHaveLength(9);
    expect(h.summary.isolated).toEqual({ files: 0, items: [], more: 0 });
  });

  it("the --focus file is never dropped, even when its only edge goes into a hub", () => {
    const v = aggregateIsolating(hubApp(), { focus: "feat/u05.ts", depth: 1 });
    const f = v.nodes.find((n) => n.path === "feat/u05.ts");
    expect(f?.mark).toBe("focus");
    expect(v.edges.some((e) => e.from === "file:feat/u05.ts" && e.to === "file:shared/ast.ts")).toBe(true);
    expectCountsAddUp(v);
  });
});

describe("entry and focus marks", () => {
  const g = (): RawGraph =>
    raw(["index.ts", "a/index.ts", "b/index.ts", "a/x.ts", "b/y.ts"], [["index.ts", "a/index.ts"], ["index.ts", "b/index.ts"], ["a/index.ts", "a/x.ts"], ["b/index.ts", "b/y.ts"]]);

  it("marks the entry green with an `entry` line right after the name", () => {
    const v = aggregateIsolating(g(), { entry: "index.ts", level: "file" });
    const n = v.nodes.find((x) => x.path === "index.ts");
    expect(n).toMatchObject({ mark: "entry", color: "green", label: "index.ts", notes: ["entry"] });
    expect(v.nodes.filter((x) => x.mark).length).toBe(1);
  });

  it("marks the --focus file `focus`, or `entry` when it is the entry", () => {
    expect(aggregateIsolating(g(), { focus: "a/index.ts", depth: 1, level: "file" }).nodes.find((x) => x.path === "a/index.ts")?.notes).toEqual(["focus"]);
    const both = aggregateIsolating(g(), { focus: "index.ts", entry: "index.ts", depth: 1, level: "file" });
    expect(both.nodes.find((x) => x.path === "index.ts")?.notes).toEqual(["entry"]);
  });

  it("a hub or cycle-member entry is green too (never yellow or red) and keeps its `used by` info on the same line", () => {
    const users = Array.from({ length: 10 }, (_, i) => `u${i}.ts`);
    const g = raw(["entry.ts", "dep.ts", ...users], [...users.map((u): EdgeSpec => [u, "entry.ts"]), ["entry.ts", "dep.ts"]]);
    const hub = aggregateIsolating(g, { entry: "entry.ts", isolated: "show" });
    expect(hub.nodes.find((x) => x.path === "entry.ts")).toMatchObject({ color: "green", notes: ["entry, used by 10"] });
    const cyc = aggregateIsolating(hubApp(), { entry: "feat/u00.ts", isolated: "show" });
    expect(cyc.nodes.find((x) => x.path === "feat/u00.ts")).toMatchObject({ color: "green", mark: "entry" });
  });

  it("an entry with nothing drawn on it is not marked and not kept: no green box without an arrow", () => {
    const g = raw(["start.ts", "a.ts", "b.ts"], [["a.ts", "b.ts"]]);
    const v = aggregateIsolating(g, { entry: "start.ts" });
    expect(v.nodes.some((n) => n.mark)).toBe(false);
    expect(v.nodes.some((n) => n.path === "start.ts")).toBe(false);
    expect(v.summary.isolated.items).toEqual([{ path: "start.ts", kind: "file", files: 1 }]);
    // a hub whose arrows are all suppressed (no outgoing import) is not marked either
    expect(aggregateIsolating(hubApp(), { entry: "shared/ast.ts", isolated: "show" }).nodes.some((n) => n.mark)).toBe(false);
  });

  it("ignores an entry that was filtered out", () => {
    expect(aggregateIsolating(g(), { entry: "nope.ts" }).nodes.some((x) => x.mark)).toBe(false);
  });

  it("an entry inside a collapsed folder marks the folder box green and names the file", () => {
    const v = aggregateIsolating(g(), { entry: "a/x.ts", maxNodes: 3, level: "dir" });
    expect(v.nodes.find((x) => x.mark)).toMatchObject({ key: "dir:a", mark: "entry", color: "green", notes: ["entry: x.ts"] });
    expect(v.nodes.filter((x) => x.mark)).toHaveLength(1);
  });

  it("a --focus file inside a collapsed folder marks the folder box `focus: <file>`; the entry wins a shared box", () => {
    const f = aggregateIsolating(g(), { focus: "a/x.ts", depth: 2, maxNodes: 3, level: "dir" });
    expect(f.nodes.find((x) => x.mark)).toMatchObject({ key: "dir:a", mark: "focus", notes: ["focus: x.ts"] });
    const both = aggregateIsolating(g(), { focus: "a/x.ts", entry: "a/index.ts", depth: 2, maxNodes: 3, level: "dir" });
    expect(both.nodes.filter((x) => x.mark)).toHaveLength(1);
    expect(both.nodes.find((x) => x.mark)).toMatchObject({ mark: "entry", notes: ["entry: index.ts"] });
  });

  it("a hub folder holding the entry keeps its label at two lines: `entry: <file>, used by N`", () => {
    const users = Array.from({ length: 10 }, (_, i) => `u${i}.ts`);
    const files = ["core/main.ts", "core/util.ts", "dep.ts", ...users];
    const edges: EdgeSpec[] = [...users.map((u): EdgeSpec => [u, "core/main.ts"]), ["core/main.ts", "dep.ts"], ["core/util.ts", "dep.ts"]];
    const v = aggregateIsolating(raw(files, edges), { entry: "core/main.ts", level: "dir" });
    const box = v.nodes.find((x) => x.key === "dir:core");
    expect(box?.mark).toBe("entry");
    expect(box?.notes).toHaveLength(1);
    expect(box?.notes[0]).toMatch(/^entry: main\.ts, used by 10/);
  });

  it("an entry mark that would push the hub note past MAX_LINE gets its own line instead of a middle cut", () => {
    const users = Array.from({ length: 10 }, (_, i) => `u${i}.ts`);
    const files = ["core/a-very-long-entry-file-name.ts", "core/util.ts", "dep.ts", ...users];
    const edges: EdgeSpec[] = [...users.map((u): EdgeSpec => [u, "core/a-very-long-entry-file-name.ts"]), ["core/a-very-long-entry-file-name.ts", "dep.ts"], ["core/util.ts", "dep.ts"]];
    const v = aggregateIsolating(raw(files, edges), { entry: "core/a-very-long-entry-file-name.ts", level: "dir" });
    const box = v.nodes.find((x) => x.key === "dir:core");
    expect(box?.mark).toBe("entry");
    expect(box?.notes[0]).toBe("entry: a-very-long-entry-file-name.ts");
    expect(box?.notes[1]).toMatch(/^used by 10/);
    for (const line of box?.notes ?? []) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("keeps the entry in the view when the root has to be bucketed", () => {
    const f = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const e: EdgeSpec[] = [...f.slice(1, 9).map((x): EdgeSpec => ["f00.ts", x]), ...f.slice(10, 16).map((x): EdgeSpec => ["f39.ts", x])];
    const v = aggregateIsolating(raw(f, e), { maxNodes: 6, entry: "f39.ts" });
    expect(v.nodes.find((x) => x.path === "f39.ts")?.mark).toBe("entry");
  });
});

describe("labels that repeat", () => {
  it("adds the parent folder when several boxes would read `index.ts`", () => {
    const f = ["index.ts", "a/index.ts", "b/index.ts", "a/x.ts", "b/y.ts"];
    const e: EdgeSpec[] = [["index.ts", "a/index.ts"], ["index.ts", "b/index.ts"], ["a/index.ts", "a/x.ts"], ["b/index.ts", "b/y.ts"]];
    const v = aggregateIsolating(raw(f, e), { level: "file" });
    expect(v.nodes.filter((n) => n.path.endsWith("index.ts")).map((n) => n.label).sort()).toEqual(["a/index.ts", "b/index.ts", "index.ts"]);
  });

  it("goes up as far as needed (v3/core/index.ts vs v4/core/index.ts) and keeps the (N files) suffix of folders", () => {
    const f = ["v3/core/index.ts", "v4/core/index.ts", "v3/core/a.ts", "v4/core/b.ts", "v3/p/q/z.ts", "v3/p/q/w.ts", "v4/p/q/z.ts", "v4/p/q/w.ts"];
    const e: EdgeSpec[] = [["v3/core/index.ts", "v3/core/a.ts"], ["v4/core/index.ts", "v4/core/b.ts"], ["v3/core/a.ts", "v3/p/q/z.ts"], ["v4/core/b.ts", "v4/p/q/z.ts"]];
    const v = aggregateIsolating(raw(f, e), { level: "file", group: "none" });
    expect(new Set(v.nodes.map((n) => n.label)).size).toBe(v.nodes.length);
    const d = aggregateIsolating(raw(f, e), { level: "dir", maxNodes: 4 });
    const dirs = d.nodes.filter((n) => n.kind === "dir").map((n) => n.label);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe("automatic budget", () => {
  const ratio = (v: View): number => {
    const linked = new Set(v.edges.filter((e) => !e.stub).flatMap((e) => [e.from, e.to]));
    return v.edges.filter((e) => !e.stub).length / Math.max(1, linked.size);
  };

  it("a crowded view is cut again with a smaller budget when that lowers edges per box", () => {
    const plain = aggregateIsolating(synthetic(3));
    const auto = aggregateIsolating(synthetic(3), { autoBudget: true });
    expect(plain.summary.budget).toMatchObject({ max: 25, dense: false });
    expect(auto.summary.budget.dense).toBe(true);
    expect(auto.summary.budget.max).toBeLessThan(25);
    expect(auto.nodes.length).toBeLessThanOrEqual(auto.summary.budget.max);
    expect(ratio(auto)).toBeLessThan(ratio(plain) - 0.25);
    expectCountsAddUp(auto);
  });

  it("never drops below the floor of 12 and never makes the picture denser", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const plain = aggregateIsolating(synthetic(seed));
      const auto = aggregateIsolating(synthetic(seed), { autoBudget: true });
      expect(auto.summary.budget.max).toBeGreaterThanOrEqual(12);
      expect(ratio(auto)).toBeLessThanOrEqual(ratio(plain) + 1e-9);
      if (!auto.summary.budget.dense) expect(JSON.stringify(auto)).toBe(JSON.stringify(plain));
    }
  });

  it("is off without autoBudget (an explicit --max-nodes), with --expand and with a fixed --level", () => {
    expect(aggregateIsolating(synthetic(3), { maxNodes: 25 }).summary.budget.dense).toBe(false);
    expect(aggregateIsolating(synthetic(3), { autoBudget: true, expand: ["pkg01"] }).summary.budget.dense).toBe(false);
    expect(aggregateIsolating(synthetic(3), { autoBudget: true, level: "dir" }).summary.budget.dense).toBe(false);
  });

  it("small or sparse views are left alone", () => {
    const v = aggregateIsolating(smallApp(), { autoBudget: true });
    expect(v.summary.budget).toEqual({ max: 25, effective: v.summary.budget.effective, exceeded: false, dense: false });
  });
});
