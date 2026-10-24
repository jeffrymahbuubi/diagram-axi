// Authoring eval (scripts/skill-author.mjs): deterministic tests, no model and no browser.
// Fixture task folders are built in a temp dir; the scorer runs with fake cli deps, plus two folders that go through
// the real built cli (an .exd drawn with the default excalidraw engine needs no browser).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  deriveEngine,
  findSource,
  formatReport,
  isPng,
  loadTasks,
  missingLabels,
  normText,
  parseReport,
  prepare,
  renderPacket,
  scoreAll,
  scoreTask,
  splitPackets,
  visionPacket,
} from "../scripts/skill-author.mjs";

interface Task {
  id: string;
  prompt: string;
  input?: { copy: string };
  expect: { engine: string; allowedEngines?: string[]; kind?: string; minNodes: number; maxNodes: number; mustContain: string[]; files: string[] };
}
interface Deps {
  check: (source: string) => Promise<{ exit: number; errors: number; warnings: number; detail?: string }>;
  analyze: (a: { source: string; engine: string; taskDir: string }) => Promise<{ ok: boolean; error?: string; nodes: number; hard: number; soft: number }>;
}

const file = loadTasks() as { bar: { pass: number; total: number }; tasks: Task[] };
const tasks = file.tasks;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture-bytes")]);

const roots: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "skill-author-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const put = (dir: string, name: string, body: string | Buffer): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
};

const okDeps = (over: Partial<{ nodes: number; hard: number; warnings: number }> = {}): Deps => ({
  check: async () => ({ exit: 0, errors: 0, warnings: over.warnings ?? 0 }),
  analyze: async () => ({ ok: true, nodes: over.nodes ?? 9, hard: over.hard ?? 0, soft: 0 }),
});

describe("tasks.json", () => {
  it("has 12 unique, well-formed tasks and a 10/12 bar", () => {
    expect(tasks).toHaveLength(12);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(12);
    expect(file.bar).toEqual({ pass: 10, total: 12 });
    for (const t of tasks) {
      expect(t.prompt.length, t.id).toBeGreaterThan(60);
      expect(["excalidraw", "d2", "mermaid"]).toContain(t.expect.engine);
      expect(t.expect.minNodes, t.id).toBeLessThanOrEqual(t.expect.maxNodes);
      expect(t.expect.mustContain.length, t.id).toBeGreaterThan(2);
      expect(t.expect.files, t.id).toContain(".png");
    }
  });

  it("covers the requested mix of engines and kinds", () => {
    const count = (e: string) => tasks.filter((t) => t.expect.engine === e).length;
    expect(count("excalidraw")).toBe(5);
    expect(count("mermaid")).toBe(2);
    expect(tasks.filter((t) => t.expect.kind === "sequence")).toHaveLength(2);
    expect(tasks.filter((t) => t.expect.kind === "erd")).toHaveLength(1);
    expect(tasks.filter((t) => t.expect.kind === "state")).toHaveLength(1);
    expect(tasks.filter((t) => t.input?.copy === "src")).toHaveLength(1);
  });

  it("never names the DSL syntax in a prompt", () => {
    for (const t of tasks) expect(t.prompt, t.id).not.toMatch(/\.exd|\bdsl\b|\bdiagram-axi\b|shape:|stateDiagram|-->|->/i);
  });
});

describe("packets and prepare", () => {
  it("deals every task into exactly one of 4 packets", () => {
    const packets = splitPackets(tasks);
    expect(packets).toHaveLength(4);
    expect(packets.map((p: Task[]) => p.length)).toEqual([3, 3, 3, 3]);
    expect(packets.flat().map((t: Task) => t.id).sort()).toEqual(tasks.map((t) => t.id).sort());
  });

  it("writes work folders, the input copy and packets with the full skill text", () => {
    const out = tmp();
    const repo = tmp();
    put(join(repo, "src"), "a.ts", "export const a = 1;\n");
    const skill = "# SKILL\nrun npx -y diagram-axi draw x.exd\n";
    const files = prepare(out, { skillText: skill, repoRoot: repo });
    expect(files).toHaveLength(4);
    for (const t of tasks) expect(existsSync(join(out, t.id)), t.id).toBe(true);
    expect(readFileSync(join(out, "learn-codebase", "src", "a.ts"), "utf8")).toContain("export const a");
    const packet = readFileSync(join(out, "packet-01.md"), "utf8");
    expect(packet).toContain(skill.trim());
    expect(packet).toContain(`/bin/diagram-axi.js`);
    expect(packet).toContain("Work only inside");
    expect(packet).toContain("<engine> | <source file> | <png file> | <attempts>");
    expect(packet).toContain(tasks[0].prompt);
    expect(packet).not.toContain(tasks[1].prompt);
  });

  it("refuses to overwrite a used task folder without force", () => {
    const out = tmp();
    const repo = tmp();
    put(join(repo, "src"), "a.ts", "x");
    prepare(out, { skillText: "s", repoRoot: repo });
    put(join(out, "web-arch"), "work.exd", "a[A]\n");
    expect(() => prepare(out, { skillText: "s", repoRoot: repo })).toThrow(/not empty/);
    prepare(out, { skillText: "s", repoRoot: repo, force: true });
    expect(existsSync(join(out, "web-arch", "work.exd"))).toBe(false);
  });

  it("mentions the input folder only for the task that has one", () => {
    const text = renderPacket({ skillText: "s", tasks, n: 1, total: 1, outDir: "/o", repoRoot: "/r" });
    expect(text.match(/already contains/g)).toHaveLength(1);
  });
});

describe("report lines and helpers", () => {
  it("parses report lines, tolerating bullets, backticks and prose", () => {
    const m = parseReport("Done.\nweb-arch | excalidraw | arch.exd | arch.png | 2\n- `login-flow | d2 | l.d2 | l.png | 5`\nnot | a | line\n");
    expect([...m.keys()]).toEqual(["web-arch", "login-flow"]);
    expect(m.get("web-arch")).toEqual({ engine: "excalidraw", source: "arch.exd", png: "arch.png", attempts: 2 });
    expect(m.get("login-flow")?.attempts).toBe(5);
  });

  it("matches labels case-insensitively with alternatives and _/- as spaces", () => {
    const src = "# Postgres only in a comment\nlb[Load Balancer] -> api[API]\nusers_table: {}\n";
    expect(missingLabels(src, ["load balancer|lb", "api", "users table", "postgres", "redis|cache"])).toEqual(["postgres", "redis|cache"]);
    expect(normText("%% hidden\n// hidden\nShown_text")).toBe("shown text");
  });

  it("detects PNGs by signature, the source by report or newest file, the engine by outputs", () => {
    const d = tmp();
    put(d, "a.png", PNG);
    put(d, "fake.png", "not a png at all");
    expect(isPng(join(d, "a.png"))).toBe(true);
    expect(isPng(join(d, "fake.png"))).toBe(false);
    put(d, "one.exd", "a[A]\n");
    put(d, "two.d2", "a: A\n");
    expect(findSource(d, "one.exd")).toBe(join(d, "one.exd"));
    expect(findSource(d, "./nope.exd")).toBeDefined();
    expect(deriveEngine(join(d, "two.d2"), "mermaid")).toBe("d2");
    expect(deriveEngine(join(d, "one.exd"), "mermaid")).toBe("mermaid");
    put(d, "one.excalidraw", "{}");
    expect(deriveEngine(join(d, "one.exd"), "mermaid")).toBe("excalidraw");
  });
});

describe("scoreTask with fake cli deps", () => {
  const web = tasks.find((t) => t.id === "web-arch") as Task;
  const labels = "browser[Browser] -> cdn[CDN] -> lb[Load balancer] -> api[API]\napi -> db[(Postgres)]\napi -> r[(Redis)]\napi -> queue[Queue] -> worker[Worker]\n";

  it("passes a complete folder and keeps the attempts from the report", async () => {
    const out = tmp();
    put(join(out, "web-arch"), "arch.exd", labels);
    put(join(out, "web-arch"), "arch.excalidraw", "{}");
    put(join(out, "web-arch"), "arch.png", PNG);
    const row = await scoreTask(web, out, { engine: "excalidraw", source: "arch.exd", png: "arch.png", attempts: 3 }, okDeps({ warnings: 1 }));
    expect(row.why).toEqual([]);
    expect(row.pass).toBe(true);
    expect(row).toMatchObject({ engine: "excalidraw", warnings: 1, hard: 0, nodes: 9, nodesOk: true, attempts: 3 });
  });

  it("fails on HARD findings, wrong engine, missing labels, missing PNG and parse errors", async () => {
    const out = tmp();
    put(join(out, "web-arch"), "arch.exd", "browser[Browser] -> cdn[CDN]\n");
    put(join(out, "web-arch"), "arch.d2", "x: y\n");
    const bad: Deps = { check: async () => ({ exit: 1, errors: 2, warnings: 0, detail: "boom" }), analyze: async () => ({ ok: true, nodes: 2, hard: 2, soft: 0 }) };
    const row = await scoreTask(web, out, undefined, bad);
    expect(row.pass).toBe(false);
    const why = row.why.join(" | ");
    expect(why).toContain("engine d2");
    expect(why).toContain("check failed");
    expect(why).toContain("2 HARD");
    expect(why).toContain("missing labels:");
    expect(why).toContain("load balancer|lb");
    expect(why).toContain("no valid PNG");
    expect(why).toContain("missing output files: .excalidraw");
    expect(row.nodesOk).toBe(false);
  });

  it("accepts an allowed alternative engine and reports out-of-range nodes without failing", async () => {
    const out = tmp();
    const codebase = tasks.find((t) => t.id === "learn-codebase") as Task;
    put(join(out, "learn-codebase"), "imports.exd", 'group g "engines/" { a[commands] }\nb[layout]\nc[render]\n');
    put(join(out, "learn-codebase"), "imports.excalidraw", "{}");
    put(join(out, "learn-codebase"), "i.png", PNG);
    const row = await scoreTask(codebase, out, undefined, okDeps({ nodes: 3 }));
    expect(row.engine).toBe("excalidraw");
    expect(row.nodesOk).toBe(false);
    expect(row.pass).toBe(true);
  });

  it("scores an empty run 0/12 and applies the 10/12 bar", async () => {
    const out = tmp();
    const empty = await scoreAll(file, out, new Map(), okDeps());
    expect(empty).toMatchObject({ pass: 0, total: 12, ok: false });
    expect(empty.rows[0].why).toEqual(["no work product", "no PNG"]);
    expect(formatReport(empty)).toContain("pass: 0/12");
    expect(formatReport(empty)).toContain("result: FAIL");

    const fakeAll = (n: number): Deps => {
      let i = 0;
      return {
        check: async () => ({ exit: 0, errors: 0, warnings: 0 }),
        analyze: async () => ({ ok: true, nodes: 10, hard: i++ < 12 - n ? 1 : 0, soft: 0 }),
      };
    };
    for (const t of tasks) {
      const body = t.expect.mustContain.map((l) => l.split("|")[0]).join("\n");
      const ext = t.expect.engine === "d2" ? ".d2" : t.expect.engine === "mermaid" ? ".mmd" : ".exd";
      put(join(out, t.id), `diagram${ext}`, body);
      put(join(out, t.id), "diagram.png", PNG);
      put(join(out, t.id), "diagram.excalidraw", "{}");
    }
    const ten = await scoreAll(file, out, new Map(), fakeAll(10));
    expect(ten.pass).toBe(10);
    expect(ten.ok).toBe(true);
    expect(formatReport(ten)).toContain("result: PASS");
    const nine = await scoreAll(file, out, new Map(), fakeAll(9));
    expect(nine.pass).toBe(9);
    expect(nine.ok).toBe(false);
    expect(formatReport(nine)).toMatch(/failures\[3\]\{id,why\}/);
  });

  it("lists the PNGs in the vision packet with V1-V10", async () => {
    const out = tmp();
    put(join(out, "web-arch"), "arch.exd", labels);
    put(join(out, "web-arch"), "arch.png", PNG);
    const result = await scoreAll({ ...file, tasks: [web] }, out, new Map(), okDeps());
    const text = visionPacket(result.rows);
    expect(text).toContain("arch.png");
    expect(text).toContain("V10");
    expect(text).toContain("V-A1");
    expect(text).not.toContain("V-E1");
  });
});

describe("scoreTask through the real cli (excalidraw, no browser)", () => {
  const web = tasks.find((t) => t.id === "web-arch") as Task;
  const small = { ...web, expect: { ...web.expect, mustContain: ["browser", "cdn", "api"], minNodes: 3, maxNodes: 5, files: [".png"] } };

  it("passes a clean small diagram", { timeout: 60_000 }, async () => {
    const out = tmp();
    put(join(out, "web-arch"), "d.exd", "dir RIGHT\nbrowser[Browser] -> cdn[CDN] -> api[API]\n");
    put(join(out, "web-arch"), "d.png", PNG);
    const row = await scoreTask(small, out, { engine: "excalidraw", source: "d.exd", png: "d.png", attempts: 1 });
    expect(row.why).toEqual([]);
    expect(row).toMatchObject({ pass: true, parseOk: true, hard: 0, nodes: 3, nodesOk: true });
  });

  it("fails a source with a parse error", { timeout: 60_000 }, async () => {
    const out = tmp();
    put(join(out, "web-arch"), "d.exd", "browser[Browser] -> \n");
    put(join(out, "web-arch"), "d.png", PNG);
    const row = await scoreTask(small, out, undefined);
    expect(row.pass).toBe(false);
    expect(row.parseOk).toBe(false);
    expect(row.why.join(" ")).toMatch(/check failed/);
  });
});
