// Agent-usefulness eval for `extract` (plan 2026-10-24-extract-plan.md section 5.4): deterministic checks of the
// question file and the scorer in scripts/extract-eval.mjs. No model, no network. `emit` needs the hono QA corpus
// (npm run qa:extract clones it) and is only exercised when that checkout exists.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadQuestions, norm, orderFor, parseAnswers, scoreAgent, scoreQuestion, sccs, trimSidecar, valueGraph } from "../scripts/extract-eval.mjs";

interface Q {
  id: string;
  repo: string;
  type: "one" | "number" | "set";
  entry: boolean;
  prompt: string;
  expected: number | string[];
}

const SCRIPT = fileURLToPath(new URL("../scripts/extract-eval.mjs", import.meta.url));
const qf = loadQuestions() as { bar: { pass: number; total: number; entryAllAgents: boolean }; sources: Record<string, unknown>; questions: Q[] };
const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "extract-eval-"));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The reply of a perfect agent: the first accepted answer for each question. */
const perfect = (qs: Q[]) =>
  qs
    .map((q) => `${q.id} | ${q.type === "number" ? q.expected : q.type === "one" ? (q.expected as string[])[0] : (q.expected as string[]).join("; ")}`)
    .join("\n");

describe("questions.json", () => {
  it("has 15 questions over self and hono with unique ids and the bar from the plan", () => {
    expect(qf.questions).toHaveLength(15);
    expect(new Set(qf.questions.map((q) => q.id)).size).toBe(15);
    expect(new Set(qf.questions.map((q) => q.repo))).toEqual(new Set(["self", "hono"]));
    expect(qf.bar).toEqual({ pass: 12, total: 15, entryAllAgents: true });
    expect(Object.keys(qf.sources).sort()).toEqual(["hono", "self"]);
  });

  it("every question is well formed and the where-to-start questions accept a listed set", () => {
    for (const q of qf.questions) {
      expect(["one", "number", "set"]).toContain(q.type);
      expect(q.prompt.length).toBeGreaterThan(10);
      if (q.type === "number") expect(Number.isInteger(q.expected)).toBe(true);
      else expect((q.expected as string[]).length).toBeGreaterThan(0);
    }
    const entry = qf.questions.filter((q) => q.entry);
    expect(entry.map((q) => q.repo).sort()).toEqual(["hono", "self"]);
    for (const q of entry) expect((q.expected as string[]).length).toBeGreaterThanOrEqual(2);
  });
});

describe("scorer", () => {
  it("normalizes spellings", () => {
    expect(norm("`src/commands/draw.ts`")).toBe("commands/draw.ts");
    expect(norm("./Router/")).toBe("router");
    expect(norm("layout/ (18 files)")).toBe("layout");
  });

  it("parses answer lines and ignores prose", () => {
    const m = parseAnswers("Here you go:\n- q01 | index.ts\n`q02 | 18`\n> Q03 | a; b\nnot an answer");
    expect([...m]).toEqual([
      ["q01", "index.ts"],
      ["q02", "18"],
      ["q03", "a; b"],
    ]);
  });

  it("scores the three answer types", () => {
    const one = { id: "q", type: "one", expected: ["index.ts", "commands/draw.ts"] };
    expect(scoreQuestion(one, "commands/draw.ts").pass).toBe(true);
    expect(scoreQuestion(one, "src/index.ts").pass).toBe(true);
    expect(scoreQuestion(one, "draw.ts").pass).toBe(true);
    expect(scoreQuestion(one, "cli/router.ts").pass).toBe(false);
    expect(scoreQuestion(one, "index.ts; draw.ts").pass).toBe(false);
    const num = { id: "q", type: "number", expected: 18 };
    expect(scoreQuestion(num, "18").pass).toBe(true);
    expect(scoreQuestion(num, "about 18 files").pass).toBe(true);
    expect(scoreQuestion(num, "17").pass).toBe(false);
    const set = { id: "q", type: "set", expected: ["render", "engines/cache.ts"] };
    expect(scoreQuestion(set, "engines/cache.ts; render/").pass).toBe(true);
    expect(scoreQuestion(set, "cache.ts, render").pass).toBe(true);
    expect(scoreQuestion(set, "render").pass).toBe(false);
    expect(scoreQuestion(set, "render; engines/cache.ts; layout").pass).toBe(false);
    expect(scoreQuestion(set, undefined).pass).toBe(false);
  });

  it("passes a perfect agent and fails one under the bar or missing an entry file", () => {
    const answers = parseAnswers(perfect(qf.questions));
    const good = scoreAgent(qf, answers);
    expect(good.pass).toBe(15);
    expect(good.ok).toBe(true);

    const wrong = new Map(answers);
    for (const q of qf.questions.slice(1, 5)) wrong.set(q.id, "nonsense");
    expect(scoreAgent(qf, wrong)).toMatchObject({ pass: 11, ok: false });

    const noEntry = new Map(answers);
    noEntry.set(qf.questions.find((q) => q.entry)!.id, "nonsense");
    const r = scoreAgent(qf, noEntry);
    expect(r.pass).toBe(14);
    expect(r.entryOk).toBe(false);
    expect(r.ok).toBe(false);

    const twelve = new Map(answers);
    for (const q of qf.questions.filter((x) => !x.entry).slice(0, 3)) twelve.set(q.id, "nonsense");
    expect(scoreAgent(qf, twelve)).toMatchObject({ pass: 12, ok: true });
  });

  it("score command: exit 0 for perfect answers, 1 when one agent is wrong, 2 without answers", () => {
    const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, "score", dir], { encoding: "utf8" });
    const dir = tmp();
    for (const n of ["01", "02", "03"]) writeFileSync(join(dir, `answers-${n}.md`), perfect(qf.questions) + "\n");
    const ok = run(dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("result: PASS");

    const bad = tmp();
    writeFileSync(join(bad, "answers-01.md"), perfect(qf.questions));
    writeFileSync(join(bad, "answers-02.md"), qf.questions.map((q) => `${q.id} | wrong`).join("\n"));
    const fail = run(bad);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain("result: FAIL");
    expect(fail.stdout).toContain("a2,0,15,no,FAIL");

    expect(run(tmp()).status).toBe(2);
  });
});

describe("graph helpers", () => {
  it("finds strongly connected components and ignores type-only, test and self edges", () => {
    expect(sccs(["a", "b", "c", "d"], [["a", "b"], ["b", "a"], ["b", "c"], ["c", "d"]])).toEqual([["a", "b"]]);
    const raw = {
      files: [{ path: "a.ts", test: false }, { path: "b.ts", test: false }, { path: "a.test.ts", test: true }],
      edges: [
        { from: "a.ts", to: "b.ts", typeOnly: false },
        { from: "b.ts", to: "a.ts", typeOnly: true },
        { from: "a.test.ts", to: "a.ts", typeOnly: false },
        { from: "a.ts", to: "a.ts", typeOnly: false },
      ],
    };
    const g = valueGraph(raw);
    expect(g.files).toEqual(["a.ts", "b.ts"]);
    expect(g.edges).toHaveLength(1);
  });

  it("rotates the question order per agent without losing any", () => {
    const ids = qf.questions.map((q) => q.id);
    for (const a of [0, 1, 2]) expect(orderFor(qf.questions, a).map((q: Q) => q.id).sort()).toEqual([...ids].sort());
    expect(orderFor(qf.questions, 0)[0].id).not.toBe(orderFor(qf.questions, 1)[0].id);
  });

  it("trims a sidecar to ids, paths and counts (no line evidence)", () => {
    const text = trimSidecar({
      meta: { root: "src", stats: { files: 2, edges: 1 } },
      nodes: { f_a: { path: "a.ts", kind: "file" }, d_b: { path: "b", kind: "dir", files: 3 } },
      edges: [{ from: "f_a", to: "d_b", weight: 2, typeOnly: false, dynamic: false, evidence: [{ path: "a.ts", line: 1 }] }],
      hidden: { externals: [{ name: "zod" }], tests: ["a.test.ts"], hubEdges: [], sccs: [] },
    });
    const j = JSON.parse(text);
    expect(j.nodes).toEqual({ f_a: "a.ts file", d_b: "b dir 3 files" });
    expect(j.edges).toEqual(["f_a -> d_b x2"]);
    expect(text).not.toContain("evidence");
  });
});

describe("emit", () => {
  const corpus = fileURLToPath(new URL("../out/extract-corpus", import.meta.url));
  const hasHono = existsSync(corpus) && readdirSync(corpus).some((d) => d.startsWith("hono@") && existsSync(join(corpus, d, ".git")));
  it.skipIf(!hasHono)("writes three packets that carry every question and both repos' views", () => {
    const dir = tmp();
    const r = spawnSync(process.execPath, [SCRIPT, "emit", "--out", dir], { encoding: "utf8", timeout: 120000 });
    expect(r.status).toBe(0);
    for (const n of ["01", "02", "03"]) {
      const text = readFileSync(join(dir, `packet-${n}.md`), "utf8");
      for (const q of qf.questions) expect(text).toContain(`### ${q.id} (repo ${q.repo})`);
      expect(text).toContain("## Repo `self`");
      expect(text).toContain("## Repo `hono`");
      expect(text).not.toMatch(/[\\/]_work[\\/]/);
    }
  });
});
