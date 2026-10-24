// Per-engine QA harness (U8): scripts/qa/engines.mjs, drawCase / buildReport engine paths, scripts/qa.mjs and
// scripts/fuzz.mjs with --engine, and the native corpus (test/qa/native). The excalidraw path is guarded by shape:
// its report gains no field. D2 tests run anywhere (WASM); Mermaid tests skip without a browser.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser } from "../src/render/browser.js";
// @ts-expect-error plain .mjs module without type declarations
import { LAYOUTS, checkEngineArgs, commonSkipped, engineArgs, isEngine, maskFindings, nativeSuite, svgProblem } from "../scripts/qa/engines.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { SUITES, buildReport, drawCase, summarize, suitesFor } from "../scripts/qa/run.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NATIVE = join(ROOT, "test", "qa", "native");
const QA = join(ROOT, "scripts", "qa.mjs");
const FUZZ = join(ROOT, "scripts", "fuzz.mjs");

const tmp = mkdtempSync(join(tmpdir(), "qa-engines-"));
const outDirs: string[] = [];
const outRel = (name: string): string => {
  const rel = `out/qa-engines-test-${name}-${process.pid}`;
  outDirs.push(join(ROOT, rel));
  return rel;
};
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  outDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const node = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: "utf8" });
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const GRAPH = "# kind: graph\na[Start] -> b[Check] : go\nb -> c[Done] : ok\nb -> a : retry\n";
const hardOf = (r: { findings: { severity: string }[] }) => r.findings.filter((f) => f.severity === "hard");

interface CaseResult {
  exit: number;
  kind?: string;
  rulesSkipped?: string[];
  geometry?: string;
  stats: unknown;
  findings: { code: string; severity: string; detail: string }[];
}

const drawGraph = (engine: string, name: string, extra: Record<string, unknown> = {}): Promise<CaseResult> => {
  const out = join(tmp, `${engine}-${name}`);
  mkdirSync(out, { recursive: true });
  return drawCase({ name, dir: "DOWN", text: GRAPH, group: "t" }, { outDir: out, png: false, engine, ...extra });
};

// ---- helpers (no rendering) ----

describe("engine helpers", () => {
  it("masks findings of skipped rules and keeps the rest", () => {
    const f = [{ code: "node-overlap" }, { code: "label-stored-offset" }, { code: "text-exceeds-inscribed" }];
    expect(maskFindings(f, ["label-stored-offset", "text-exceeds-inscribed"])).toEqual([{ code: "node-overlap" }]);
    expect(maskFindings(f, [])).toHaveLength(3);
  });

  it("commonSkipped is the intersection, sorted; empty for no lists", () => {
    expect(commonSkipped([["b", "a", "c"], ["c", "b"], ["b", "c", "x"]])).toEqual(["b", "c"]);
    expect(commonSkipped([])).toEqual([]);
  });

  it("isEngine is false for excalidraw and undefined", () => {
    expect([isEngine("d2"), isEngine("mermaid"), isEngine("excalidraw"), isEngine(undefined)]).toEqual([true, true, false, false]);
  });

  it("validates engine and layout together", () => {
    expect(checkEngineArgs("d2", "tala")).toBeUndefined();
    expect(checkEngineArgs("mermaid", "elk")).toBeUndefined();
    expect(checkEngineArgs("excalidraw", undefined)).toBeUndefined();
    expect(checkEngineArgs("nope", undefined)?.msg).toContain("unknown engine");
    expect(checkEngineArgs("mermaid", "tala")?.suggestion).toContain("dagre|elk");
    expect(checkEngineArgs("excalidraw", "elk")?.msg).toContain("does not apply");
    expect(LAYOUTS.d2).toEqual(["dagre", "elk", "tala"]);
  });

  it("builds the engine draw args", () => {
    expect(engineArgs("d2", undefined)).toEqual(["--engine", "d2", "--svg", "--geometry-json"]);
    expect(engineArgs("mermaid", "dagre")).toEqual(["--engine", "mermaid", "--layout", "dagre", "--svg", "--geometry-json"]);
  });

  it("only engine runs get the native suite; excalidraw keeps its two suites", () => {
    expect(suitesFor("excalidraw").map((s: { suite: string }) => s.suite)).toEqual(["corpus", "fuzz-corpus"]);
    expect(suitesFor("d2").map((s: { suite: string }) => s.suite)).toEqual(["corpus", "fuzz-corpus", "native-d2"]);
    expect(nativeSuite("mermaid")).toMatchObject({ suite: "native-mermaid", ext: ".mmd", native: true });
    expect(SUITES).toHaveLength(2);
  });

  it("svgProblem reports missing, empty and non-svg files", () => {
    const base = join(tmp, "svgcheck");
    expect(svgProblem(base)).toContain("missing");
    writeFileSync(`${base}.svg`, "");
    expect(svgProblem(base)).toContain("empty");
    writeFileSync(`${base}.svg`, "<html></html>");
    expect(svgProblem(base)).toContain("not an svg");
    writeFileSync(`${base}.svg`, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(svgProblem(base)).toBeNull();
  });
});

// ---- native corpus ----

describe("native corpus", () => {
  const files = readdirSync(NATIVE).sort();
  const kindOf = (f: string): string => /^# kind: (\w+)|^%% kind: (\w+)/m.exec(readFileSync(join(NATIVE, f), "utf8"))?.slice(1).find(Boolean) as string;

  it("has 14 files, two per kind, each declaring its kind and matching its engine's extension", () => {
    expect(files).toHaveLength(14);
    const perKind = new Map<string, string[]>();
    for (const f of files) perKind.set(kindOf(f), [...(perKind.get(kindOf(f)) ?? []), f]);
    expect([...perKind.keys()].sort()).toEqual(["class", "erd", "gitgraph", "mindmap", "sequence", "state", "timeline"]);
    for (const list of perKind.values()) expect(list).toHaveLength(2);
    for (const f of files) {
      const k = kindOf(f);
      expect(f.endsWith(["sequence", "class", "erd"].includes(k) ? ".d2" : ".mmd")).toBe(true);
      expect(f.startsWith(`${k}-`)).toBe(true);
    }
  });

  it.each(files.filter((f) => f.endsWith(".d2")))("d2 %s renders with no HARD finding and the engine mask", async (f) => {
    const out = join(tmp, "native-d2");
    mkdirSync(out, { recursive: true });
    const r: CaseResult = await drawCase({ name: f.replace(/\.d2$/, ""), dir: "NATIVE", file: join(NATIVE, f), native: true, group: "native-d2" }, { outDir: out, png: false, engine: "d2" });
    expect(r.exit).toBe(0);
    expect(r.kind).toBe(kindOf(f));
    expect(hardOf(r), JSON.stringify(hardOf(r))).toEqual([]);
    // sequence / class / ERD are not graph-routed: the crossing and route rules are masked
    expect(r.rulesSkipped).toContain("arrow-crossings");
    expect(r.rulesSkipped).toContain("label-stored-offset");
  });
});

// ---- D2 (WASM, no browser) ----

describe("drawCase with the d2 engine", () => {
  it("reads the sidecar scene, applies rules_skipped and reports kind and geometry", async () => {
    const r = await drawGraph("d2", "g");
    expect(r.exit).toBe(0);
    expect(r.kind).toBe("graph");
    expect(r.geometry).toBe("neutral");
    expect(r.rulesSkipped).toEqual(expect.arrayContaining(["label-stored-offset", "text-exceeds-inscribed"]));
    expect(r.stats).toBeTruthy();
    const masked = new Set(r.rulesSkipped);
    expect(r.findings.some((f) => masked.has(f.code))).toBe(false);
    expect(hardOf(r), JSON.stringify(hardOf(r))).toEqual([]);
  });

  it("passes --layout through (dagre differs from elk only in geometry, both render)", async () => {
    const r = await drawGraph("d2", "gl", { layout: "dagre" });
    expect(r.exit).toBe(0);
    const sidecar = JSON.parse(readFileSync(join(tmp, "d2-gl", "gl-DOWN.geometry.json"), "utf8"));
    expect(sidecar.layout).toBe("dagre");
  });

  it("an unreadable source is a cli-failure, not a crash", async () => {
    const out = join(tmp, "d2-bad");
    mkdirSync(out, { recursive: true });
    const r: CaseResult = await drawCase({ name: "bad", dir: "NATIVE", text: "a -> {{{", group: "t" }, { outDir: out, png: false, engine: "d2" });
    expect(r.findings.map((f) => f.code)).toContain("cli-failure");
  });
});

describe("report shape", () => {
  const fake = [{ case: "x", dir: "DOWN", group: "corpus", exit: 0, stdout: "", findings: [], stats: null, kind: "graph", rulesSkipped: ["b", "a"], geometry: "neutral" }];
  const base = (extra: Record<string, unknown>) => buildReport({ results: fake, sum: summarize(fake), files: 1, png: false, ...extra });

  it("engine reports gain engine, layout, rules_skipped and per-case fields", () => {
    const rep = base({ engine: "d2", layout: "elk" });
    expect(rep.engine).toBe("d2");
    expect(rep.layout).toBe("elk");
    expect(rep.rules_skipped).toEqual(["a", "b"]);
    expect(rep.summary).toMatchObject({ engine: "d2", layout: "elk", renders: 1, passRate: 100 });
    expect(rep.cases[0]).toMatchObject({ kind: "graph", rules_skipped: ["a", "b"], geometry: "neutral" });
  });

  it("the excalidraw report gains nothing (KTD8 regression guard)", () => {
    for (const rep of [base({}), base({ engine: "excalidraw" })]) {
      expect(Object.keys(rep)).toEqual(["summary", "rules", "byCode", "cases", "findings"]);
      expect(Object.keys(rep.summary)).toEqual(["files", "renders", "png", "hard", "soft", "passed", "passRate"]);
      expect(Object.keys(rep.cases[0])).toEqual(["case", "dir", "exit", "stats", "hard", "soft", "stdout"]);
    }
  });
});

// ---- the cli scripts ----

describe("scripts/qa.mjs", () => {
  it("--engine d2 runs the shared corpus plus the native suite and writes an engine report", () => {
    const out = outRel("qa-d2");
    const r = node(QA, ["--engine", "d2", "--only", "sequence", "--dirs", "DOWN", "--out", out, "--jobs", "2"]);
    expect(r.stdout).toContain("engine: d2");
    expect(r.stdout).toContain("native-d2");
    expect([0, 1]).toContain(r.status);
    const rep = readJson(`${out}/report.json`);
    expect(rep.engine).toBe("d2");
    expect(rep.rules_skipped).toEqual(expect.arrayContaining(["label-stored-offset"]));
    expect(rep.suites.map((s: { suite: string }) => s.suite)).toEqual(["corpus", "fuzz-corpus", "native-d2"]);
    const native = rep.suites.find((s: { suite: string }) => s.suite === "native-d2");
    expect(native.renders).toBe(2);
    expect(rep.cases.filter((c: { dir: string }) => c.dir === "NATIVE")).toHaveLength(2);
    expect(rep.cases[0]).toHaveProperty("rules_skipped");
  }, 120_000);

  it("the default engine report keeps the excalidraw shape and two suites", () => {
    const out = outRel("qa-x");
    const r = node(QA, ["--only", "day-cache-aside", "--dirs", "DOWN", "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("engine:");
    const rep = readJson(`${out}/report.json`);
    expect(rep.engine).toBeUndefined();
    expect(rep.rules_skipped).toBeUndefined();
    expect(rep.suites.map((s: { suite: string }) => s.suite)).toEqual(["corpus", "fuzz-corpus"]);
    expect(rep.cases[0]).not.toHaveProperty("kind");
  }, 120_000);

  it("rejects an unknown engine and a layout the engine lacks with exit 2", () => {
    expect(node(QA, ["--engine", "nope"]).status).toBe(2);
    const r = node(QA, ["--engine", "mermaid", "--layout", "tala"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("suggestion: use --layout dagre|elk");
    expect(node(QA, ["--layout", "elk"]).status).toBe(2);
  });
});

describe("scripts/fuzz.mjs", () => {
  it("--engine d2 writes out/fuzz-d2-s<seed> style reports with engine fields", () => {
    const out = outRel("fuzz-d2");
    const r = node(FUZZ, ["--engine", "d2", "--seed", "3", "--count", "1", "--profile", "tiny", "--dirs", "DOWN", "--jobs", "2", "--out", out]);
    expect([0, 1]).toContain(r.status);
    expect(r.stdout).toContain("engine: d2");
    const rep = readJson(`${out}/report.json`);
    expect(rep.engine).toBe("d2");
    expect(rep.summary).toMatchObject({ seed: 3, engine: "d2" });
    expect(rep.profiles[0]).toMatchObject({ profile: "tiny" });
    expect(rep.cases[0]).toMatchObject({ profile: "tiny", geometry: "neutral" });
  }, 120_000);

  it("--shrink and --promote are refused for engine runs", () => {
    const r = node(FUZZ, ["--engine", "d2", "--shrink"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("excalidraw-only");
  });

  it("documents the held-out protocol in the script header", () => {
    const head = readFileSync(FUZZ, "utf8").split("\n").slice(0, 40).join("\n");
    expect(head).toMatch(/Held-out protocol/);
    expect(head).toMatch(/seeds 3 and 4/i);
  });
});

// ---- Mermaid (browser) ----

describe("mermaid engine", () => {
  let browserOk = false;
  beforeAll(async () => {
    try {
      await findBrowser();
      browserOk = true;
    } catch {
      browserOk = false;
    }
  });

  it("graph: sidecar scene, mask and kind", async (ctx) => {
    if (!browserOk) ctx.skip("no browser installed");
    const r = await drawGraph("mermaid", "g");
    expect(r.exit).toBe(0);
    expect(r.kind).toBe("graph");
    expect(r.rulesSkipped).toEqual(expect.arrayContaining(["label-stored-offset", "text-exceeds-inscribed"]));
    expect(r.findings.some((f) => f.code === "label-stored-offset")).toBe(false);
  }, 120_000);

  it("native sources: state keeps overlap rules, timeline has no geometry and still passes on render success", async (ctx) => {
    if (!browserOk) ctx.skip("no browser installed");
    const out = join(tmp, "native-mmd");
    mkdirSync(out, { recursive: true });
    const draw = (f: string): Promise<CaseResult> => drawCase({ name: f, dir: "NATIVE", file: join(NATIVE, `${f}.mmd`), native: true, group: "native-mermaid" }, { outDir: out, png: false, engine: "mermaid" });
    const state = await draw("state-order");
    expect(state.exit).toBe(0);
    expect(state.kind).toBe("state");
    expect(hardOf(state), JSON.stringify(hardOf(state))).toEqual([]);
    expect(state.rulesSkipped).toContain("arrow-crossings");
    const tl = await draw("timeline-company");
    expect(tl.exit).toBe(0);
    expect(tl.kind).toBe("timeline");
    expect(hardOf(tl)).toEqual([]);
  }, 120_000);
});
