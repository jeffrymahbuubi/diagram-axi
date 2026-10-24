// Agent-choice eval, level 1 (plan 2026-10-24-skill-engine-selection, item C): deterministic, no model.
// Ground truth lives in test/skill-eval/tasks.json. Here we check that
//   - the router and the kind table really produce each task's expected engine (so the label is not a guess),
//   - each reference .exd is a faithful picture of its prompt and fails exactly the measure it claims,
//   - SKILL.md still contains the cue text each task relies on,
//   - the L2 scorer and packet writer (scripts/skill-eval.mjs) behave.
// L2 itself (three tool-less agents answering the packets) is manual: see scripts/skill-eval.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { detectKind, detectSource, type SourceType } from "../src/engines/detect.js";
import { failures, measureGraph, route, type Kind, type Target } from "../src/engines/route.js";
import { lint } from "../src/lint/rules.js";
import {
  PACKET_SIZE,
  effectiveEngine,
  emit,
  extOf,
  formatReport,
  loadTasks,
  parseAnswers,
  questions,
  scoreAll,
  scoreTask,
  splitPackets,
} from "../scripts/skill-eval.mjs";

interface Task {
  id: string;
  category: "kind" | "readme" | "fit" | "outgrow" | "hand" | "trap";
  prompt: string;
  expect: { engine: string; ext: string; flags: string[]; alsoOk?: { ext: string }[] };
  kind?: Kind;
  target?: Target;
  ref?: string;
  measure?: "busy" | "parallel" | "long-label" | "cross-group" | "large" | "dense";
  intent?: string;
  cue: string;
  label_source: string;
}
interface TasksFile {
  bar: { pass: number; total: number; perfectCategories: string[] };
  tasks: Task[];
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const file: TasksFile = loadTasks();
const tasks = file.tasks;
const skill = readFileSync(join(HERE, "..", "skills", "diagram-axi", "SKILL.md"), "utf8");
const DEFAULT = { defaultEngine: "excalidraw" } as const;

const refOf = (t: Task): string => readFileSync(join(HERE, "skill-eval", "ref", t.ref as string), "utf8");
const graphOf = (t: Task) => parse(refOf(t)).graph;

/** What the router tells an agent to do: apply the suggestion if there is one. */
function routed(t: Task): string {
  const r = route(graphOf(t), { ...DEFAULT, ...(t.target ? { target: t.target } : {}) });
  return r.suggestion ?? r.engine;
}

/** The answer a perfect agent gives (first alternative of every accepted flag). */
function canonical(t: Task) {
  const flags = t.expect.flags.map((s) => s.split("|")[0]).join(" ");
  return { engine: t.expect.engine, file: `${t.id}${t.expect.ext}`, flags };
}

// ---- structure -------------------------------------------------------------------------------

describe("tasks.json", () => {
  it("has 24 tasks in the planned categories", () => {
    expect(tasks).toHaveLength(24);
    const count = (c: string) => tasks.filter((t) => t.category === c).length;
    expect({ kind: count("kind"), readme: count("readme"), fit: count("fit"), outgrow: count("outgrow"), hand: count("hand"), trap: count("trap") }).toEqual({
      kind: 7,
      readme: 3,
      fit: 4,
      outgrow: 6,
      hand: 2,
      trap: 2,
    });
    expect(new Set(tasks.map((t) => t.id)).size).toBe(24);
    expect(file.bar).toEqual({ pass: 22, total: 24, perfectCategories: ["kind", "readme"] });
  });

  it("covers the 7 diagram kinds, once each", () => {
    expect(tasks.filter((t) => t.category === "kind").map((t) => t.kind).sort()).toEqual(["class", "erd", "gitgraph", "mindmap", "sequence", "state", "timeline"]);
  });

  it("has a label_source and cue for every task", () => {
    for (const t of tasks) {
      expect(t.label_source.length, t.id).toBeGreaterThan(10);
      expect(t.cue.length, t.id).toBeGreaterThan(5);
    }
  });

  it("prompts never name an engine (hand-edit tasks may say Excalidraw, the user's own wish)", () => {
    for (const t of tasks) {
      expect(t.prompt, t.id).not.toMatch(/\b(d2|mermaid)\b/i);
      if (t.category !== "hand") expect(t.prompt, t.id).not.toMatch(/excalidraw/i);
    }
  });

  it("every ref .exd is used by a task, and every ref task has its file", () => {
    const used = tasks.filter((t) => t.ref).map((t) => t.ref as string);
    for (const r of used) expect(existsSync(join(HERE, "skill-eval", "ref", r)), r).toBe(true);
    expect(readdirSync(join(HERE, "skill-eval", "ref")).sort()).toEqual([...used].sort());
    expect(used).toHaveLength(14); // readme 2, fit 4, outgrow 6, hand 2
  });

  it("expect is self-consistent: file + flags select the expected engine", () => {
    for (const t of tasks) {
      const c = canonical(t);
      expect(effectiveEngine(c.file, c.flags), t.id).toBe(t.expect.engine);
      for (const a of t.expect.alsoOk ?? []) expect(effectiveEngine(`x${a.ext}`, ""), `${t.id} alsoOk ${a.ext}`).toBe(t.expect.engine);
      expect(scoreTask(t, c).pass, t.id).toBe(true);
    }
  });
});

// ---- kind tasks: kind table and detection ----------------------------------------------------

const D2_SAMPLE: Partial<Record<Kind, string>> = {
  sequence: "s: {\n  shape: sequence_diagram\n  a -> b: hi\n}\n",
  class: "c: {\n  shape: class\n  +run(): void\n}\n",
  erd: "t: {\n  shape: sql_table\n  id: int\n}\n",
};
const MMD_SAMPLE: Partial<Record<Kind, string>> = {
  sequence: "sequenceDiagram\n  A->>B: hi\n",
  class: "classDiagram\n  class A\n",
  erd: "erDiagram\n  A ||--o{ B : has\n",
  state: "stateDiagram-v2\n  [*] --> A\n",
  timeline: "timeline\n  2021 : start\n",
  gitgraph: "gitGraph\n  commit\n",
  mindmap: "mindmap\n  root((x))\n",
};

describe("kind tasks (kind table)", () => {
  for (const t of tasks.filter((x) => x.kind)) {
    it(`${t.id}: ${t.kind} -> ${t.expect.engine} ${t.expect.ext}`, () => {
      const r = route(t.kind as Kind, { ...DEFAULT, ...(t.target ? { target: t.target } : {}) });
      expect(r.engine).toBe(t.expect.engine);
      expect(r.suggestion).toBeUndefined();
      // The file the agent should write belongs to that engine and holds that kind.
      expect(detectSource(`x${t.expect.ext}`)?.engine).toBe(t.expect.engine);
      const sample = (t.expect.ext === ".d2" ? D2_SAMPLE : MMD_SAMPLE)[t.kind as Kind] as string;
      expect(sample, `${t.id}: no sample for ${t.expect.ext}`).toBeTruthy();
      const type: SourceType = t.expect.ext === ".d2" ? "d2" : "mmd";
      expect(detectKind(type, sample).kind).toBe(t.kind);
    });
  }

  it("the README target beats the kind row (sequence and ER go to mermaid, not d2)", () => {
    expect(route("sequence", { ...DEFAULT }).engine).toBe("d2");
    expect(route("sequence", { ...DEFAULT, target: "markdown" }).engine).toBe("mermaid");
    expect(route("erd", { ...DEFAULT }).engine).toBe("d2");
    expect(route("erd", { ...DEFAULT, target: "github" }).engine).toBe("mermaid");
  });
});

// ---- graph tasks: route() over the reference .exd --------------------------------------------

const MEASURE_FAILS: Record<NonNullable<Task["measure"]>, (f: { prefix: string; text: string }) => boolean> = {
  busy: (f) => f.prefix === "busy",
  parallel: (f) => f.text.includes("parallel"),
  "long-label": (f) => f.prefix === "text",
  "cross-group": (f) => f.prefix === "cross-linked",
  large: (f) => f.prefix === "large",
  dense: (f) => f.prefix === "dense" && f.text.includes("edges"),
};
const MEASURE_LINT: Record<NonNullable<Task["measure"]>, string> = {
  busy: "busy-node",
  parallel: "parallel-edges",
  "long-label": "long-label",
  "cross-group": "cross-group-edges",
  large: "many-nodes",
  dense: "dense-graph",
};

describe("graph tasks (router over the reference .exd)", () => {
  for (const t of tasks.filter((x) => x.ref)) {
    describe(t.id, () => {
      it("reference parses without errors", () => {
        expect(parse(refOf(t)).diagnostics.filter((d) => d.severity === undefined || d.severity === "error")).toEqual([]);
      });

      it(`reference fails ${t.measure ? "only the " + t.measure + " measure" : "no measure"}`, () => {
        const bad = failures(measureGraph(graphOf(t)));
        if (!t.measure) return expect(bad).toEqual([]);
        expect(bad.filter(MEASURE_FAILS[t.measure])).toHaveLength(1);
        expect(bad).toHaveLength(1);
      });

      it("check warns exactly when the router objects", () => {
        const codes = lint(graphOf(t)).map((d) => d.code as string);
        const all = Object.values(MEASURE_LINT);
        if (!t.measure) expect(codes.filter((c) => all.includes(c))).toEqual([]);
        else expect(codes).toContain(MEASURE_LINT[t.measure]);
      });

      it(`routes to ${t.expect.engine}`, () => {
        expect(routed(t)).toBe(t.expect.engine);
        if (t.expect.flags.some((s) => s.split("|").includes("--engine auto"))) {
          expect(route(graphOf(t), { ...DEFAULT, engine: "auto" }).engine).toBe(t.expect.engine);
        }
      });
    });
  }

  it("hand-edit tasks: the user's wish overrides the router (it suggests d2, the answer stays excalidraw)", () => {
    // Without the user's intent the router recommends d2 for these large/busy graphs. The expected answer is
    // excalidraw because the SKILL tells the agent to keep it "when the user must edit by hand"; `--target editable`
    // is the router's own spelling of that intent. The eval checks the agent honours it.
    for (const t of tasks.filter((x) => x.intent === "user-edit-by-hand")) {
      const plain = route(graphOf(t), { ...DEFAULT });
      expect(plain.suggestion, t.id).toBe("d2");
      expect(route(graphOf(t), { ...DEFAULT, target: "editable" }).engine, t.id).toBe(t.expect.engine);
      expect(t.expect.engine).toBe("excalidraw");
    }
  });

  it("README tasks: the markdown target overrides a d2 suggestion", () => {
    const hub = tasks.find((t) => t.id === "readme-hub") as Task;
    expect(route(graphOf(hub), { ...DEFAULT }).suggestion).toBe("d2");
    expect(route(graphOf(hub), { ...DEFAULT, target: "markdown" }).engine).toBe("mermaid");
  });

  it("every ref label (node and edge) appears in its prompt", () => {
    for (const t of tasks.filter((x) => x.ref)) {
      const prompt = t.prompt.toLowerCase();
      const g = graphOf(t);
      for (const label of [...g.nodes.map((n) => n.label), ...g.edges.flatMap((e) => (e.label ? [e.label] : []))]) {
        const flat = label.replace(/\s+/g, " ").toLowerCase();
        expect(prompt.includes(flat), `${t.id}: '${flat}' not in prompt`).toBe(true);
      }
    }
  });
});

// ---- SKILL.md carries the cues ---------------------------------------------------------------

describe("SKILL.md cues", () => {
  for (const t of tasks) it(`${t.id}: '${t.cue}'`, () => expect(skill).toContain(t.cue));
});

// ---- L2 machinery ----------------------------------------------------------------------------

describe("scorer", () => {
  const qs = questions(tasks);
  const answersFor = (pick: (t: Task) => ReturnType<typeof canonical>) => new Map(qs.map((q) => [q.qid, pick(q.task as Task)]));

  it("question ids are neutral and the packets hold 8 tasks each", () => {
    expect(qs.map((q) => q.qid)).toEqual(Array.from({ length: 24 }, (_, i) => `q${String(i + 1).padStart(2, "0")}`));
    const packets = splitPackets(qs);
    expect(packets.map((p: unknown[]) => p.length)).toEqual([PACKET_SIZE, PACKET_SIZE, PACKET_SIZE]);
  });

  it("a perfect answer set passes the bar", () => {
    const r = scoreAll(file, qs, answersFor(canonical));
    expect(r.pass).toBe(24);
    expect(r.ok).toBe(true);
    expect(formatReport(r)).toContain("result: PASS");
  });

  it("two misses still pass, three fail", () => {
    const wrong = new Set(["fit-cicd", "fit-etl", "out-dense"]);
    const bad = (n: number) => {
      const ids = [...wrong].slice(0, n);
      return answersFor((t) => (ids.includes(t.id) ? { engine: "mermaid", file: "x.mmd", flags: "" } : canonical(t)));
    };
    expect(scoreAll(file, qs, bad(2)).ok).toBe(true);
    expect(scoreAll(file, qs, bad(3)).ok).toBe(false);
  });

  it("one wrong kind or README answer fails even at 23/24", () => {
    for (const id of ["kind-erd", "readme-sequence"]) {
      const r = scoreAll(file, qs, answersFor((t) => (t.id === id ? { engine: "excalidraw", file: "x.exd", flags: "" } : canonical(t))));
      expect(r.pass).toBe(23);
      expect(r.ok, id).toBe(false);
    }
  });

  it("an .exd that never selects d2 does not count as d2, even when the engine column says d2", () => {
    const t = tasks.find((x) => x.id === "out-hub") as Task;
    expect(scoreTask(t, { engine: "d2", file: "g.exd", flags: "" }).pass).toBe(false);
    expect(scoreTask(t, { engine: "d2", file: "g.exd", flags: "--engine auto" }).pass).toBe(true);
    expect(scoreTask(t, { engine: "d2", file: "g.d2", flags: "" }).pass).toBe(true);
    expect(scoreTask(t, { engine: "excalidraw", file: "g.exd", flags: "" }).pass).toBe(false);
  });

  it("--engine auto is refused where the task does not accept it, and extras like --png are ignored", () => {
    const hand = tasks.find((x) => x.id === "hand-hub") as Task;
    expect(scoreTask(hand, { engine: "excalidraw", file: "b.exd", flags: "--png" }).pass).toBe(true);
    expect(scoreTask(hand, { engine: "excalidraw", file: "b.exd", flags: "--engine auto" }).pass).toBe(false);
    const readme = tasks.find((x) => x.id === "readme-flow") as Task;
    expect(scoreTask(readme, { engine: "mermaid", file: "r.exd", flags: "--target github --png" }).pass).toBe(true);
    expect(scoreTask(readme, { engine: "mermaid", file: "r.exd", flags: "" }).pass).toBe(false);
  });

  it("parses answer lines leniently and extOf maps .mermaid to .mmd", () => {
    const a = parseAnswers("Here you go\n- q01 | d2 | `a.d2` | -\n`q02 | mermaid | b.exd | --target markdown --png`\nq03|excalidraw|c.exd|-\n");
    expect([...a.keys()]).toEqual(["q01", "q02", "q03"]);
    expect(a.get("q01")).toEqual({ engine: "d2", file: "a.d2", flags: "" });
    expect(a.get("q02")?.flags).toBe("--target markdown --png");
    expect(extOf("docs/flow.mermaid")).toBe(".mmd");
  });
});

describe("emit and score CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-eval-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(HERE, "..", "scripts", "skill-eval.mjs");

  it("emit writes 3 packets with the skill, the prompts and no ground truth", () => {
    emit(dir);
    const packets = readdirSync(dir).filter((f) => /^packet-\d+\.md$/.test(f)).sort();
    expect(packets).toEqual(["packet-01.md", "packet-02.md", "packet-03.md"]);
    const text = packets.map((p) => readFileSync(join(dir, p), "utf8"));
    for (const p of text) {
      expect(p).toContain("# diagram-axi");
      expect(p).toContain("## Choose the engine");
      expect(p).toMatch(/q\d+ \| <engine> \| <file> \| <flags>/);
      expect(p).not.toContain("label_source");
      for (const t of tasks) expect(p, t.id).not.toContain(t.id);
      expect((p.match(/^### q\d+$/gm) ?? []).length).toBe(8);
    }
    for (const t of tasks) expect(text.filter((p) => p.includes(t.prompt))).toHaveLength(1);
  });

  it("score exits 0 on a perfect file and 1 on a wrong one", () => {
    const qs = questions(tasks);
    const lines = (wrong: boolean) =>
      qs
        .map(({ qid, task }) => {
          const c = canonical(task as Task);
          const bad = wrong && ["kind-erd", "fit-cicd", "out-hub", "out-dense"].includes(task.id);
          return bad ? `${qid} | mermaid | x.mmd | -` : `${qid} | ${c.engine} | ${c.file} | ${c.flags || "-"}`;
        })
        .join("\n");
    const run = (body: string) => {
      const d = mkdtempSync(join(tmpdir(), "skill-eval-score-"));
      try {
        writeFileSync(join(d, "answers-01.md"), body);
        return spawnSync(process.execPath, [script, "score", d], { encoding: "utf8" });
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    };
    const good = run(lines(false));
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("result: PASS");
    const badRun = run(lines(true));
    expect(badRun.status).toBe(1);
    expect(badRun.stdout).toContain("result: FAIL");
    expect(badRun.stdout).toContain("failures[4]");
  });

  it("score without answers is a usage error", () => {
    const d = mkdtempSync(join(tmpdir(), "skill-eval-empty-"));
    try {
      expect(spawnSync(process.execPath, [script, "score", d], { encoding: "utf8" }).status).toBe(2);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
