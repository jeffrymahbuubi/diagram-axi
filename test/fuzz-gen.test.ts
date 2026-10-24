// Fuzz generator (scripts/qa/gen.mjs + profiles.mjs + prng.mjs) and the fuzz CLI plumbing (scripts/fuzz.mjs).
// Layout quality is NOT tested here: only that generation is deterministic, always parses with the real parser,
// stays inside each profile's size bounds, and that --emit-only / report gating behave.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
// @ts-expect-error plain .mjs module without type declarations
import { emit, generate } from "../scripts/qa/gen.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { hash32, makeRng } from "../scripts/qa/prng.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { DEFAULT_PROFILES, PROFILES, PROFILE_ORDER } from "../scripts/qa/profiles.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FUZZ = join(ROOT, "scripts", "fuzz.mjs");
const seeds = (n: number, salt = 0): number[] => Array.from({ length: n }, (_, i) => hash32(salt, i));
const profiles: string[] = PROFILE_ORDER;

const outDirs: string[] = [];
const outDir = (name: string) => {
  const rel = `out/fuzz-test-${name}-${process.pid}`;
  outDirs.push(join(ROOT, rel));
  return rel;
};
afterAll(() => outDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const runFuzz = (args: string[]) => spawnSync(process.execPath, [FUZZ, ...args], { cwd: ROOT, encoding: "utf8" });

describe("prng", () => {
  it("is deterministic and hash32 mixes its parts", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
    expect(hash32(1, 0)).toBe(hash32(1, 0));
    expect(hash32(1, 0)).not.toBe(hash32(1, 1));
    expect(hash32(1, 0)).not.toBe(hash32(2, 0));
  });
  it("int is inclusive and shuffle is a permutation", () => {
    const r = makeRng(7);
    const seen = new Set(Array.from({ length: 400 }, () => r.int(3, 5)));
    expect([...seen].sort()).toEqual([3, 4, 5]);
    expect(r.shuffle([1, 2, 3, 4, 5, 6]).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("determinism", () => {
  it.each(profiles)("%s: same seed gives identical text, different seeds differ", (p) => {
    const texts = seeds(30).map((s) => generate(s, p).text);
    expect(seeds(30).map((s) => generate(s, p).text)).toEqual(texts);
    expect(new Set(texts).size).toBeGreaterThan(20);
  });
  it("the profile is part of the stream", () => {
    expect(generate(5, "dense").text).not.toBe(generate(5, "tiny").text);
  });
  it("never writes a dir line (the runner sets the direction)", () => {
    for (const p of profiles) for (const s of seeds(40, 1)) expect(generate(s, p).text).not.toMatch(/^\s*dir(ection)?\b/m);
  });
});

describe("validity (real parser)", () => {
  it.each(profiles)("%s: 1000 cases parse with 0 errors and the edge sequence survives emit()", (p) => {
    for (const [i, s] of seeds(1000, 2).entries()) {
      const g = generate(s, p);
      const r = parse(g.text);
      const errors = r.diagnostics.filter((d) => d.severity === "error");
      if (errors.length) throw new Error(`${p}/${s}: line ${errors[0]!.line}: ${errors[0]!.message}\n${g.text}`);
      expect(r.graph.nodes.length).toBe(g.model.nodes.length);
      expect(r.graph.edges.length).toBe(g.model.edges.length);
      if (i < 150) {
        const key = (e: { from: string; to: string; arrow: string }) => `${e.from}>${e.to}:${e.arrow}`;
        expect(r.graph.edges.map(key)).toEqual(g.model.edges.map(key));
      }
    }
  });
  it("emit() is idempotent on the model", () => {
    const g = generate(123, "groups-nested");
    expect(emit(g.model)).toBe(g.text);
  });
  it("ids are unique, never reserved, and groups share the namespace", () => {
    for (const p of profiles) {
      for (const s of seeds(60, 3)) {
        const g = generate(s, p);
        const ids = [...g.model.nodes.map((n: { id: string }) => n.id), ...g.model.groups.map((x: { id: string }) => x.id)];
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(["dir", "direction", "title", "group"]).not.toContain(id);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
      }
    }
  });
});

describe("size bounds per profile", () => {
  it.each(profiles)("%s", (p) => {
    const P = PROFILES[p];
    for (const s of seeds(300, 4)) {
      const m = generate(s, p).meta;
      expect(m.nodes).toBeGreaterThanOrEqual(P.nodes[0]);
      expect(m.nodes).toBeLessThanOrEqual(P.nodes[1]);
      expect(m.edges).toBeLessThanOrEqual(P.maxEdges);
      expect(m.groups).toBeLessThanOrEqual(P.groups.max);
      expect(m.maxDepth).toBeLessThanOrEqual(Math.max(P.groups.depth, 0));
    }
  });
  it("profile character: multi-edge pairs repeat, hubs have a wide hub, stress-60 is large, tiny can be a single node", () => {
    const meta = (p: string, n = 80) => seeds(n, 5).map((s) => generate(s, p).meta);
    expect(meta("multi-edge").every((m: { maxParallel: number }) => m.maxParallel >= 2)).toBe(true);
    expect(meta("multi-edge").some((m: { maxParallel: number }) => m.maxParallel >= 5)).toBe(true);
    expect(meta("groups-nested").some((m: { maxDepth: number }) => m.maxDepth >= 2)).toBe(true);
    expect(meta("tiny").some((m: { nodes: number }) => m.nodes === 1)).toBe(true);
    expect(meta("stress-60", 20).every((m: { nodes: number }) => m.nodes >= 50)).toBe(true);
    const hubDegree = seeds(60, 6).map((s) => {
      const g = generate(s, "hubs");
      const deg = new Map<string, number>();
      for (const e of g.model.edges as { from: string; to: string }[]) for (const id of [e.from, e.to]) deg.set(id, (deg.get(id) ?? 0) + 1);
      return Math.max(...deg.values());
    });
    expect(Math.max(...hubDegree)).toBeGreaterThanOrEqual(8);
  });
  it("covers self-loops, multiline labels, all four shapes and all five arrow kinds across profiles", () => {
    const texts = profiles.flatMap((p) => seeds(80, 7).map((s) => generate(s, p).text)).join("\n");
    expect(texts).toMatch(/\b(\w[\w-]*) (-->|->|<->|--|-\.->) \1\b/);
    expect(texts).toContain("\\n");
    for (const sym of ["->", "-->", "-.->", "--", "<->"]) expect(texts).toContain(` ${sym} `);
    for (const open of ["[(", "{", "("]) expect(texts).toContain(open);
  });
});

describe("rtl", () => {
  const RTL = /[֐-ۿ̀-ͯ‍]/u;
  it("default profiles never contain RTL / combining / ZWJ text", () => {
    for (const p of DEFAULT_PROFILES as string[]) for (const s of seeds(100, 8)) expect(generate(s, p).text).not.toMatch(RTL);
  });
  it("unicode-rtl does, and is report-only", () => {
    expect(PROFILES["unicode-rtl"].gated).toBe(false);
    expect(DEFAULT_PROFILES).not.toContain("unicode-rtl");
    expect(seeds(100, 9).some((s) => RTL.test(generate(s, "unicode-rtl").text))).toBe(true);
  });
});

describe("gating metadata", () => {
  it("dense and stress-60 are report-only, everything else gated", () => {
    expect(profiles.filter((p) => !PROFILES[p].gated).sort()).toEqual(["dense", "stress-60", "unicode-rtl"]);
  });
});

describe("fuzz cli", () => {
  it("--emit-only writes .exd files and draws nothing", () => {
    const out = outDir("emit");
    const r = runFuzz(["--emit-only", "--count", "3", "--profile", "tiny,hubs", "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("fuzz: emitted");
    expect(r.stdout).toContain("cases: 6");
    const all = (p: string) => readdirSync(join(ROOT, out, p));
    expect(all("tiny")).toHaveLength(3);
    expect(all("hubs")).toHaveLength(3);
    const files = [...all("tiny"), ...all("hubs")];
    expect(files.every((f) => f.endsWith(".exd"))).toBe(true);
    expect(existsSync(join(ROOT, out, "report.json"))).toBe(false);
    const text = readFileSync(join(ROOT, out, "tiny", all("tiny")[0]!), "utf8");
    expect(text.startsWith("# fuzz case: tiny/")).toBe(true);
    expect(parse(text).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
  it("is reproducible: same seed gives the same files", () => {
    const a = outDir("repa");
    const b = outDir("repb");
    runFuzz(["--emit-only", "--seed", "9", "--count", "4", "--profile", "labels-heavy", "--out", a]);
    runFuzz(["--emit-only", "--seed", "9", "--count", "4", "--profile", "labels-heavy", "--out", b]);
    const read = (d: string) => readdirSync(join(ROOT, d, "labels-heavy")).map((f) => [f, readFileSync(join(ROOT, d, "labels-heavy", f), "utf8").replace(/\r/g, "")]);
    expect(read(a)).toEqual(read(b));
  });
  it("rejects unknown flags, unknown profiles and rtl-only profiles without --rtl with exit 2", () => {
    expect(runFuzz(["--nope"]).status).toBe(2);
    expect(runFuzz(["--profile", "nope"]).status).toBe(2);
    const rtl = runFuzz(["--profile", "unicode-rtl", "--emit-only", "--out", outDir("rtl")]);
    expect(rtl.status).toBe(2);
    expect(rtl.stdout).toContain("--rtl");
  });
  it("accepts the shrinker flags (--emit-only never draws, so nothing is shrunk or promoted)", () => {
    const r = runFuzz(["--emit-only", "--count", "1", "--profile", "tiny", "--shrink", "--promote", "--promote-max", "3", "--out", outDir("ign")]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("promote:");
    const bad = runFuzz(["--emit-only", "--promote-max", "many"]);
    expect(bad.status).toBe(2);
  });
  it("a draw run reports per-profile gating and writes the report schema", () => {
    const out = outDir("draw");
    const r = runFuzz(["--count", "2", "--profile", "tiny,dense", "--dirs", "DOWN", "--jobs", "2", "--out", out, "--keep-passing", "--bar", "0"]);
    expect([0, 1]).toContain(r.status);
    expect(r.stdout).toMatch(/profiles\[2\]\{profile,renders,passed,pass_rate,top_code\}:/);
    expect(r.stdout).toContain("report_only: dense");
    const report = JSON.parse(readFileSync(join(ROOT, out, "report.json"), "utf8"));
    expect(report.summary.renders).toBe(4);
    expect(report.summary.gatedRenders).toBe(2);
    expect(report.profiles.map((p: { profile: string; gated: boolean }) => [p.profile, p.gated])).toEqual([["tiny", true], ["dense", false]]);
    expect(report.cases[0]).toMatchObject({ profile: "tiny", dir: "DOWN" });
    expect(typeof report.cases[0].seed).toBe("number");
    expect(report.cases[0].meta).toHaveProperty("nodes");
    expect(existsSync(join(ROOT, out, "failures.toon"))).toBe(true);
    // --gate-all brings dense into the gated count
    const all = runFuzz(["--count", "2", "--profile", "tiny,dense", "--dirs", "DOWN", "--out", out, "--gate-all", "--bar", "0"]);
    expect(all.stdout).toContain("report_only: none");
    expect(JSON.parse(readFileSync(join(ROOT, out, "report.json"), "utf8")).summary.gatedRenders).toBe(4);
  });
});
