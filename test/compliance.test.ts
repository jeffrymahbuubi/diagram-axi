// Compliance evidence tooling (plan 2026-10-23, section 4): the pure model fixers (scripts/qa/fixes.mjs), the
// filter-mode classification (scripts/qa/compliance.mjs) and its exit codes.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { lint } from "../src/lint/rules.js";
// @ts-expect-error plain .mjs module without type declarations
import { COUNTED, candidateCompliant, classify, summarizeRows } from "../scripts/qa/compliance.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { FIXERS, UNFIXABLE, diamondToRect, fixAll, mergeParallel, mergeReciprocal, shortenEdgeLabels } from "../scripts/qa/fixes.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { emit, generate } from "../scripts/qa/gen.mjs";
// @ts-expect-error plain .mjs module without type declarations
import { PROFILES } from "../scripts/qa/profiles.mjs";

type Model = { title?: string; nodes: any[]; edges: any[]; groups: any[]; merge: boolean; edgesFirst: boolean };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (id: string, shape = "rect", label = id.toUpperCase()) => ({ id, label, shape, flags: [] as string[] });
const edge = (from: string, to: string, label?: string, arrow = "solid") => ({ from, to, arrow, ...(label === undefined ? {} : { label }) });
const model = (nodes: any[], edges: any[]): Model => ({ nodes, edges, groups: [], merge: false, edgesFirst: false });

/** COUNTED lint codes of the text a model emits (and it must parse). */
function codesOf(m: Model): string[] {
  const r = parse(emit(m));
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return [...new Set(lint(r.graph).map((d) => d.code).filter((c) => COUNTED.includes(c)))];
}

describe("model fixers", () => {
  it("mergeParallel: 4 edges on one pair become one with the labels joined by newline", () => {
    const m = model([node("a"), node("b")], [edge("a", "b", "x"), edge("a", "b", "y"), edge("a", "b"), edge("a", "b", "z")]);
    expect(codesOf(m)).toEqual(["parallel-edges"]);
    const fixed = mergeParallel(m);
    expect(fixed.edges).toEqual([{ from: "a", to: "b", arrow: "solid", label: "x\ny\nz" }]);
    expect(codesOf(fixed)).toEqual([]);
  });

  it("mergeParallel: both directions give a two-headed arrow; other pairs and self-loops are untouched", () => {
    const m = model([node("a"), node("b"), node("c")], [edge("a", "b", "p"), edge("b", "a", "q"), edge("a", "b", "r"), edge("b", "c", "k"), edge("c", "c", "loop")]);
    const fixed = mergeParallel(m);
    expect(fixed.edges.map((e: any) => `${e.from}>${e.to}:${e.arrow}:${e.label}`)).toEqual(["a>b:both:p\nq\nr", "b>c:solid:k", "c>c:solid:loop"]);
    expect(codesOf(fixed)).toEqual([]);
  });

  it("mergeReciprocal: same label (or none) collapses to <->; different labels stay", () => {
    const same = model([node("a"), node("b")], [edge("a", "b", "ok"), edge("b", "a", "ok")]);
    expect(codesOf(same)).toEqual(["reciprocal-pair"]);
    const fixed = mergeReciprocal(same);
    expect(fixed.edges).toEqual([{ from: "a", to: "b", arrow: "both", label: "ok" }]);
    expect(codesOf(fixed)).toEqual([]);
    const bare = mergeReciprocal(model([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]));
    expect(bare.edges).toHaveLength(1);
    const diff = model([node("a"), node("b")], [edge("a", "b", "ok"), edge("b", "a", "fail")]);
    expect(mergeReciprocal(diff).edges).toHaveLength(2);
  });

  it("shortenEdgeLabels: wordy and over-30-char lines are cut to the first 3 words; short lines stay", () => {
    const m = model([node("a"), node("b"), node("c")], [edge("a", "b", "validate the payload against schema"), edge("b", "c", "ok\nretry the request now please"), edge("a", "c", "fine")]);
    expect(codesOf(m)).toEqual(["wordy-edge-label"]);
    const fixed = shortenEdgeLabels(m);
    expect(fixed.edges.map((e: any) => e.label)).toEqual(["validate the payload", "ok\nretry the request", "fine"]);
    expect(codesOf(fixed)).toEqual([]);
    const long = shortenEdgeLabels(model([node("a"), node("b")], [edge("a", "b", "Supercalifragilisticexpialidocious authentication")]));
    expect(codesOf(long)).toEqual([]);
  });

  it("diamondToRect: only diamonds with more than 4 edges change shape", () => {
    const leaves = ["l1", "l2", "l3", "l4", "l5"];
    const m = model([node("t", "diamond"), node("d", "diamond"), ...leaves.map((l) => node(l))], [...leaves.map((l) => edge("t", l)), edge("d", "l1"), edge("d", "l2")]);
    expect(codesOf(m)).toEqual(["diamond-hub"]);
    const fixed = diamondToRect(m);
    expect(fixed.nodes.map((n: any) => `${n.id}:${n.shape}`).slice(0, 2)).toEqual(["t:rect", "d:diamond"]);
    expect(codesOf(fixed)).toEqual([]);
  });

  it("fixAll clears every fixable code at once and never mutates its input", () => {
    const m = model(
      [node("a"), node("b"), node("c", "diamond"), node("d", "rect", "x".repeat(30) + " " + "y".repeat(30)), node("e"), node("f"), node("g")],
      [edge("a", "b", "one two three four"), edge("a", "b", "x"), edge("a", "b", "y"), edge("c", "a"), edge("c", "e"), edge("c", "f"), edge("c", "g"), edge("c", "d", "ok"), edge("d", "c", "ok")],
    );
    const before = JSON.stringify(m);
    expect(codesOf(m).sort()).toEqual(["diamond-hub", "long-label", "parallel-edges", "reciprocal-pair", "wordy-edge-label"].sort());
    const fixed = fixAll(m);
    expect(JSON.stringify(m)).toBe(before);
    expect(codesOf(fixed)).toEqual([]);
    expect(fixed.nodes.find((n: any) => n.id === "d").label.split("\n").every((l: string) => l.length <= 40)).toBe(true);
  });

  it("each fixer clears its own code on generated fuzz models (zero new-code warnings for that rule)", () => {
    let checked = 0;
    for (const profile of ["multi-edge", "hubs", "realistic-medium"]) {
      for (let seed = 1; seed <= 25; seed++) {
        const g = generate(seed, profile, { rtl: PROFILES[profile].rtl });
        const before = new Set(lint(parse(g.text).graph).map((d) => d.code));
        for (const [code, fix] of Object.entries(FIXERS) as [string, (m: Model) => Model][]) {
          if (!before.has(code)) continue;
          expect(codesOf(fix(g.model)), `${profile}/${seed} ${code}`).not.toContain(code);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("the unfixable list matches COUNTED codes and has no fixer", () => {
    for (const code of UNFIXABLE) {
      expect(COUNTED).toContain(code);
      expect(Object.keys(FIXERS)).not.toContain(code);
    }
  });
});

// ---- filter mode ----

const fuzzCase = (profile: string, seed: number, dir: string, hard: number) => ({ case: `${profile}/${seed}`, dir, profile, seed, hard });
const finding = (c: { case: string }, dir: string, code: string, detail: string, severity = "soft") => ({ case: c.case, dir, code, severity, elements: [], detail });

/** Seeds of a profile whose generated text is compliant / violating under the real lint. */
function seedsBy(profile: string, want: "compliant" | "violating", n: number): number[] {
  const out: number[] = [];
  for (let seed = 1; out.length < n && seed < 500; seed++) {
    const g = generate(seed, profile, { rtl: PROFILES[profile].rtl });
    const bad = lint(parse(g.text).graph).some((d) => COUNTED.includes(d.code));
    if (bad === (want === "violating")) out.push(seed);
  }
  return out;
}

describe("filter-mode classification", () => {
  const deps = {
    lint,
    parse,
    textOf: (profile: string, seed: number) => generate(seed, profile, { rtl: PROFILES[profile].rtl }).text,
    modelOf: (profile: string, seed: number) => generate(seed, profile, { rtl: PROFILES[profile].rtl }).model,
  };
  const [good1, good2] = seedsBy("realistic-small", "compliant", 2) as [number, number];
  const [bad1, bad2] = seedsBy("multi-edge", "violating", 2) as [number, number];

  /** compliant cases: 2 x 2 dirs, 0 HARD; violating: 2 x 2 dirs, one HARD render with 40 crossings. */
  const report = (violatorHard: number) => {
    const cases = [
      fuzzCase("realistic-small", good1, "DOWN", 0), fuzzCase("realistic-small", good1, "RIGHT", 0),
      fuzzCase("realistic-small", good2, "DOWN", 0), fuzzCase("realistic-small", good2, "RIGHT", 0),
      fuzzCase("multi-edge", bad1, "DOWN", violatorHard), fuzzCase("multi-edge", bad1, "RIGHT", 0),
      fuzzCase("multi-edge", bad2, "DOWN", 0), fuzzCase("multi-edge", bad2, "RIGHT", 0),
    ];
    const findings = [
      finding(cases[0]!, "DOWN", "arrow-crossings", "2 crossing(s), e.g. edge-1xedge-2"),
      finding(cases[2]!, "DOWN", "route-ratio", "3 arrow(s) take a long detour"),
      finding(cases[4]!, "DOWN", "arrow-crossings", "40 crossing(s), e.g. edge-3xedge-4"),
      finding(cases[6]!, "DOWN", "aspect-ratio", "5.1:1"),
    ];
    return { cases, findings };
  };

  it("splits renders by lint class and joins HARD / crossings / route-ratio / aspect findings", () => {
    const rows = classify([report(1)], deps);
    expect(rows).toHaveLength(8);
    const s = summarizeRows(rows);
    expect(s.classes.map((c: any) => [c.class, c.renders, c.hard])).toEqual([["compliant", 4, 0], ["violating", 4, 1]]);
    expect(s.classes[0]).toMatchObject({ hard_rate: "0.00%", avg_crossings: "0.5", route_ratio_rate: "25.00%", aspect_rate: "0.00%" });
    expect(s.classes[1]).toMatchObject({ hard_rate: "25.00%", avg_crossings: "10.0", aspect_rate: "25.00%" });
    expect(s.byRule.find((r: any) => r.rule === "parallel-edges" || r.rule === "reciprocal-pair" || r.rule === "wordy-edge-label")).toBeTruthy();
    expect(s.holds).toBe(true);
  });

  it("the claim fails when violators are no worse than compliant inputs", () => {
    const s = summarizeRows(classify([report(0)], deps));
    expect(s.classes[1].hard).toBe(0);
    expect(s.holds).toBe(false);
  });

  it("rejects a report without profile/seed", () => {
    expect(() => classify([{ cases: [{ case: "x", dir: "DOWN", hard: 0 }], findings: [] }], deps)).toThrow(/not a fuzz report/);
  });

  it("candidateCompliant mirrors the plan's section 0 thresholds", () => {
    const base = () => model([node("a"), node("b")], [edge("a", "b", "ok")]);
    expect(candidateCompliant(base())).toBe(true);
    expect(candidateCompliant(model([node("a"), node("b")], [edge("a", "b", "twenty-five chars long label")]))).toBe(false);
    expect(candidateCompliant(model([node("a"), node("b")], [edge("a", "b", "x"), edge("b", "a", "x")]))).toBe(false);
    expect(candidateCompliant({ ...base(), groups: [{ id: "g", title: "t".repeat(25), depth: 1 }] })).toBe(false);
  });
});

describe("compliance cli", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(join(ROOT, d), { recursive: true, force: true })));
  const [good] = seedsBy("realistic-small", "compliant", 1) as [number];
  const [bad] = seedsBy("multi-edge", "violating", 1) as [number];

  const cli = (args: string[], tag: string) => {
    const out = `out/compliance-test-${tag}-${process.pid}`;
    dirs.push(out);
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "qa", "compliance.mjs"), ...args, "--out", out], { cwd: ROOT, encoding: "utf8" });
    return { ...r, out };
  };
  const writeReport = (tag: string, violatorHard: number): string => {
    const cases = [
      { case: `realistic-small/${good}`, dir: "DOWN", profile: "realistic-small", seed: good, hard: 0 },
      { case: `multi-edge/${bad}`, dir: "DOWN", profile: "multi-edge", seed: bad, hard: violatorHard },
    ];
    const findings = [{ case: cases[1]!.case, dir: "DOWN", code: "arrow-crossings", severity: "soft", elements: [], detail: "30 crossing(s), e.g. edge-1xedge-2" }];
    const rel = `out/compliance-test-report-${tag}-${process.pid}`;
    dirs.push(rel);
    const file = join(ROOT, rel, "report.json");
    mkdirSync(join(ROOT, rel), { recursive: true });
    writeFileSync(file, JSON.stringify({ cases, findings }));
    return file;
  };

  it("exit 0 and a TOON summary when the claim holds, exit 1 when it fails", () => {
    const holds = cli(["--report", writeReport("a", 2)], "a");
    expect(holds.status).toBe(0);
    expect(holds.stdout).toMatch(/^compliance: 2 renders \(2 cases\)\nclaim: holds/);
    expect(holds.stdout).toContain("classes[2]{class,renders,hard,hard_rate,avg_crossings,route_ratio_rate,aspect_rate}:");
    expect(JSON.parse(readFileSync(join(ROOT, holds.out, "report.json"), "utf8")).summary.holds).toBe(true);
    expect(cli(["--report", writeReport("b", 0)], "b").status).toBe(1);
  });

  it("exit 2 on usage errors", () => {
    expect(cli([], "c").status).toBe(2);
    expect(cli(["--report", join(ROOT, "no-such-report.json")], "d").status).toBe(2);
    expect(cli(["--report", writeReport("e", 1), "--bogus"], "e").status).toBe(2);
    expect(cli(["--report", writeReport("f", 1), "--profile", "nope"], "f").status).toBe(2);
  });
});
