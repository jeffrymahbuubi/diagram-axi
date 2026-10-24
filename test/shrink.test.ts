// Shrinker + promotion (scripts/qa/shrink.mjs, signature.mjs, scripts/promote.mjs) with stub oracles: nothing here
// depends on the current layout engine, only on the built parser (dist/dsl/parser.js).

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without type declarations
import { emit, generate } from "../scripts/qa/gen.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { candidatesFromReport, promote } from "../scripts/promote.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { ddmin, shrink, shrinkCase } from "../scripts/qa/shrink.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { failureKey, modelHash, parseModel, signature } from "../scripts/qa/signature.mjs";

type Model = Record<string, any>;

const tmp: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "exd-shrink-test-"));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** 12 nodes, 24 edges, 2 zones, a title, styles and labels: the failure only needs a diamond with two parallel in-edges. */
function bigModel(): Model {
  const nodes: Model[] = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    label: `Node number ${i} with a long label`,
    shape: i === 7 ? "diamond" : i % 3 === 0 ? "ellipse" : "rect",
    ...(i % 2 ? { color: "blue" } : {}),
    flags: i % 4 === 0 ? ["dashed"] : [],
    ...(i < 4 ? { group: "g0" } : i < 7 ? { group: "g1" } : {}),
  }));
  const edges: Model[] = [];
  for (let i = 1; i < 12; i++) edges.push({ from: `n${i - 1}`, to: `n${i}`, arrow: i % 2 ? "dashed" : "solid", label: `step ${i}` });
  for (let i = 0; i < 12; i += 2) edges.push({ from: `n${i}`, to: `n${(i + 5) % 12}`, arrow: "dotted" });
  edges.push({ from: "n3", to: "n7", arrow: "both", label: "extra one" }, { from: "n3", to: "n7", arrow: "line" });
  return {
    title: "A big diagram",
    nodes,
    edges,
    groups: [
      { id: "g0", title: "Zone zero", color: "teal", flags: [], kind: "normal", depth: 1 },
      { id: "g1", title: "Zone one", flags: ["bold"], parent: "g0", kind: "normal", depth: 2 },
    ],
    merge: true,
    edgesFirst: true,
  };
}

/** Failure: some node (a diamond) has two or more incoming edges from the same source. Rename-safe. */
const parallelIntoDiamond = async (text: string): Promise<boolean> => {
  const m = await parseModel(text);
  if (!m) return false;
  const diamonds = new Set(m.nodes.filter((n: Model) => n.shape === "diamond").map((n: Model) => n.id));
  const seen = new Map<string, number>();
  for (const e of m.edges) if (diamonds.has(e.to)) seen.set(`${e.from}>${e.to}`, (seen.get(`${e.from}>${e.to}`) ?? 0) + 1);
  return [...seen.values()].some((n) => n >= 2);
};

describe("ddmin", () => {
  it("finds the 1-minimal failing subset", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const need = (keep: number[]) => keep.includes(3) && keep.includes(14);
    expect(await ddmin(items, async (k: number[]) => need(k))).toEqual([3, 14]);
  });
  it("tries the empty list first", async () => {
    expect(await ddmin([1, 2, 3], async () => true)).toEqual([]);
  });
});

describe("shrink with a stub oracle", () => {
  it("reduces a big model to the known minimal core", async () => {
    const model = bigModel();
    expect(await parallelIntoDiamond(emit(model))).toBe(true);
    const r = await shrink({ model }, { oracle: parallelIntoDiamond });
    expect(r.reproduced).toBe(true);
    expect(r.exhausted).toBe(false);
    expect(r.calls).toBeLessThanOrEqual(400);
    expect(r.to).toEqual({ nodes: 2, edges: 2, groups: 0 });
    const min = r.model as Model;
    expect(min.title).toBeUndefined();
    expect(min.nodes.map((n: Model) => n.shape).sort()).toEqual(["diamond", "rect"]);
    expect(min.edges.every((e: Model) => e.arrow === "solid" && !e.label)).toBe(true);
    expect(min.nodes.every((n: Model) => !n.color && n.flags.length === 0)).toBe(true);
    expect(min.nodes.map((n: Model) => n.id)).toEqual(["a", "b"]);
    expect(await parallelIntoDiamond(r.text)).toBe(true);
    // the minimal text is tiny: the diamond declaration plus two edges
    expect(r.text.trim().split("\n").length).toBeLessThanOrEqual(4);
  });

  it("is deterministic", async () => {
    const a = await shrink({ model: bigModel() }, { oracle: parallelIntoDiamond });
    const b = await shrink({ model: bigModel() }, { oracle: parallelIntoDiamond });
    expect(a.text).toBe(b.text);
    expect(a.calls).toBe(b.calls);
    expect(a.steps).toEqual(b.steps);
  });

  it("shrinks parsed .exd text too, and never returns a larger repro", async () => {
    const text = emit(bigModel());
    const r = await shrink(text, { oracle: parallelIntoDiamond });
    expect(r.reproduced).toBe(true);
    expect(r.to.nodes).toBeLessThanOrEqual(r.from.nodes);
    expect(r.to).toEqual({ nodes: 2, edges: 2, groups: 0 });
  });

  it("honours the oracle-call budget and keeps the best repro so far", async () => {
    const r = await shrink({ model: bigModel() }, { oracle: parallelIntoDiamond, budget: 8 });
    expect(r.exhausted).toBe(true);
    expect(r.calls).toBe(8);
    expect(await parallelIntoDiamond(r.text)).toBe(true);
  });

  it("reports a non-reproducing input instead of shrinking it", async () => {
    const r = await shrink({ model: bigModel() }, { oracle: async () => false });
    expect(r.reproduced).toBe(false);
  });

  it("falls back to line-level ddmin when the re-emitted model stops reproducing", async () => {
    const text = "# note\nx[X]\ny[Y]\nz[Z]\nx -> y, z\ny -> z\n";
    // only the literal fan-out statement reproduces; the model re-emitted by emit() writes one edge per line
    const r = await shrink(text, { oracle: async (t: string) => t.includes("x -> y, z") });
    expect(r.reproduced).toBe(true);
    expect(r.fellBack).toBe(true);
    expect(r.text.trim()).toBe("x -> y, z");
  });
});

describe("signature", () => {
  const base = () => generate(1056367876, "multi-edge", {}).model as Model;

  it("is stable under id and label renames within a length class, and ignores colors and flags", () => {
    const m = base();
    const ids = new Map<string, string>(m.nodes.map((n: Model, i: number) => [n.id, `renamed-${i}`]));
    const alt: Model = {
      ...m,
      nodes: m.nodes.map((n: Model) => ({ ...n, id: ids.get(n.id), label: n.label.length === 1 ? "Q" : n.label.includes("\n") ? "a\nb" : n.label.length <= 12 ? "short" : "L".repeat(30), color: "red", flags: ["bold"] })),
      edges: m.edges.map((e: Model) => ({ ...e, from: ids.get(e.from), to: ids.get(e.to), ...(e.label ? { label: e.label.length === 1 ? "Z" : e.label.includes("\n") ? "p\nq" : e.label.length <= 12 ? "other" : "M".repeat(40) } : {}) })),
    };
    expect(modelHash(alt)).toBe(modelHash(m));
    expect(signature("cli-failure", alt)).toBe(signature("cli-failure", m));
    expect(signature("a", m)).not.toBe(signature("b", m));
  });

  it("changes with structure (an edge, a shape, a label class)", () => {
    const m = base();
    const h = modelHash(m);
    expect(modelHash({ ...m, edges: m.edges.slice(1) })).not.toBe(h);
    expect(modelHash({ ...m, nodes: m.nodes.map((n: Model, i: number) => (i ? n : { ...n, shape: n.shape === "diamond" ? "rect" : "diamond" })) })).not.toBe(h);
    expect(modelHash({ ...m, edges: m.edges.map((e: Model, i: number) => (i ? e : { ...e, label: e.label ? undefined : "x" })) })).not.toBe(h);
  });

  it("is the same for a model and the model parsed back from its text", async () => {
    const m = base();
    const back = await parseModel(emit(m));
    expect(modelHash(back)).toBe(modelHash(m));
  });

  it("tells cli-failure messages apart, ignoring numbers", () => {
    const f = (d: string) => ({ code: "cli-failure", detail: d });
    expect(failureKey(f("exit 1: error: unexpected failure: boom 12 | suggestion: x"))).toBe(failureKey(f("exit 1: error: unexpected failure: boom 7 | suggestion: y")));
    expect(failureKey(f("exit 1: error: unexpected failure: boom | suggestion: x"))).not.toBe(failureKey(f("exit 1: error: expected-token | suggestion: x")));
    expect(failureKey({ code: "node-overlap", detail: "anything" })).toBe("node-overlap");
  });
});

describe("promotion", () => {
  const fakeResult = (code: string, model: Model) => ({
    ok: true,
    code,
    dir: "DOWN",
    key: code,
    text: emit(model),
    model,
    signature: signature(code, model),
    calls: 5,
    steps: [],
    exhausted: false,
    fellBack: false,
    from: { nodes: 9, edges: 9, groups: 0 },
    to: { nodes: model.nodes.length, edges: model.edges.length, groups: model.groups.length },
  });
  const tiny = (extraEdge = false, shape = "rect"): Model => ({
    nodes: [{ id: "a", label: "A", shape, flags: [] }, { id: "b", label: "A", shape: "rect", flags: [] }],
    edges: [{ from: "a", to: "b", arrow: "solid" }, ...(extraEdge ? [{ from: "a", to: "b", arrow: "solid" }] : [])],
    groups: [],
    merge: false,
    edgesFirst: false,
  });
  const cand = (id: string, code = "node-overlap") => ({ case: `p/${id}`, profile: "p", seed: id, dir: "DOWN", code, text: `a -> b # ${id}\n` });

  it("dedups by signature, against the corpus and against files already promoted, and honours --promote-max", async () => {
    const corpusDir = tempDir();
    const outDir = tempDir();
    // a hand-written corpus file with the same structure as `tiny()`: any repro shaped like it is skipped
    const handFile = readdirSync(new URL("./qa/corpus/", import.meta.url)).find((f) => f.endsWith(".exd"))!;
    const handModel = (await parseModel(readFileSync(new URL(`./qa/corpus/${handFile}`, import.meta.url), "utf8"))) as Model;
    const byId: Record<string, Model> = { one: tiny(), dup: tiny(), two: tiny(true), three: tiny(false, "diamond"), hand: handModel, four: tiny(true, "ellipse") };
    const candidates = Object.keys(byId).map((id) => cand(id));
    const shrinkFn = async ({ text }: { text: string }) => fakeResult("node-overlap", byId[/# (\w+)/.exec(text)![1]!]!);
    const res = await promote({ candidates, outDir, corpusDir, max: 3, jobs: 2, shrinkFn, runSeed: 7 });
    const files = readdirSync(corpusDir).sort();
    expect(files).toHaveLength(3);
    expect(files.every((f: string) => /^fuzz-node-overlap-[0-9a-f]{8}\.exd$/.test(f))).toBe(true);
    expect(res.promoted.map((p: Model) => p.case)).toEqual(["p/one", "p/two", "p/three"]);
    const skipped = res.skipped.map((s: Model) => `${s.case}: ${s.reason}`).join("\n");
    expect(skipped).toMatch(/p\/dup.*already covered by fuzz-node-overlap-/);
    expect(skipped).not.toMatch(/p\/hand/); // not reached: the cap of 3 stops first
    expect(readdirSync(join(outDir, "shrunk"))).toEqual(files);
    for (const f of files) {
      const body = readFileSync(join(corpusDir, f), "utf8");
      expect(body.startsWith("# Fuzz repro (auto-promoted): node-overlap in DOWN; profile p, seed ")).toBe(true);
      expect(body).toMatch(/\n# Minimal: \d+ nodes, \d+ edges, \d+ groups\. signature node-overlap:[0-9a-f]{8}\n/);
    }
    // second run into the same corpus: everything is already there
    const again = await promote({ candidates: Object.keys(byId).slice(0, 3).map((id) => cand(id)), outDir, corpusDir, max: 3, jobs: 2, shrinkFn });
    expect(again.promoted).toHaveLength(0);
    expect(readdirSync(corpusDir)).toHaveLength(3);
  });

  it("skips a repro whose structure matches a hand-written corpus file", async () => {
    const corpusDir = tempDir();
    const handFile = readdirSync(new URL("./qa/corpus/", import.meta.url)).find((f) => f.endsWith(".exd"))!;
    const handModel = (await parseModel(readFileSync(new URL(`./qa/corpus/${handFile}`, import.meta.url), "utf8"))) as Model;
    const res = await promote({ candidates: [cand("hand")], outDir: tempDir(), corpusDir, max: 3, shrinkFn: async () => fakeResult("node-overlap", handModel) });
    expect(res.promoted).toHaveLength(0);
    expect(res.skipped[0].reason).toContain(`already covered by ${handFile}`);
    expect(readdirSync(corpusDir)).toHaveLength(0);
  });

  it("dry run writes only to shrunk/", async () => {
    const corpusDir = tempDir();
    const outDir = tempDir();
    const res = await promote({ candidates: [cand("one")], outDir, corpusDir, dryRun: true, shrinkFn: async () => fakeResult("node-overlap", tiny()) });
    expect(readdirSync(corpusDir)).toHaveLength(0);
    expect(readdirSync(join(outDir, "shrunk"))).toHaveLength(1);
    expect(res.lines[0]).toContain("dry run");
  });

  it("orders candidates: cli-failure first, then HARD codes by frequency, round-robin across failures", () => {
    const row = (profile: string, seed: number, nodes: number) => ({ case: `${profile}/${seed}`, dir: "DOWN", exit: 0, profile, seed, meta: { nodes, edges: nodes } });
    const find = (c: string, code: string, dir = "DOWN", severity = "hard", detail = "") => ({ case: c, dir, code, severity, elements: [], detail });
    const report = {
      cases: [row("p", 1, 9), row("p", 2, 5), row("p", 3, 7), row("p", 4, 3), row("p", 5, 4)],
      findings: [
        find("p/1", "node-overlap"), find("p/1", "node-overlap", "UP"), find("p/2", "node-overlap"), find("p/3", "node-overlap"),
        find("p/4", "cli-failure", "DOWN", "hard", "exit 1: error: unexpected failure: boom"),
        find("p/5", "text-overflow"), find("p/5", "route-ratio", "DOWN", "soft"),
      ],
    };
    expect(candidatesFromReport(report).map((c: Model) => `${c.case}:${c.code}`)).toEqual([
      "p/4:cli-failure",
      "p/2:node-overlap", // most frequent HARD code, smallest case first
      "p/5:text-overflow",
      "p/3:node-overlap",
      "p/1:node-overlap",
    ]);
    expect(candidatesFromReport(report).find((c: Model) => c.case === "p/1")!.dir).toBe("DOWN");
  });
});

describe("shrinkCase", () => {
  it("reports a clean diagram as not failing (no promotion material)", async () => {
    const r = await shrinkCase({ text: "a[A] -> b[B]\n", dirs: ["DOWN"] });
    expect(r.ok).toBe(false);
  });
});
