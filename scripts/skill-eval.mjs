#!/usr/bin/env node
// Agent-choice eval, level 2 (plan 2026-10-24-skill-engine-selection, item C). Manual, never run in CI,
// and this script never calls a model: it only builds the prompts and scores the answers.
//
//   node scripts/skill-eval.mjs emit [--out out/skill-eval]    write packet-01..03.md (+ manifest.json)
//   node scripts/skill-eval.mjs score <answers-dir>            read answers-01..03.md, print TOON, exit 1 below the bar
//
// Run one tool-less subagent per packet, save its reply as answers-NN.md next to the packet, then score.
// Ground truth: test/skill-eval/tasks.json (checked deterministically by test/skill-eval.test.ts).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TASKS_PATH = join(ROOT, "test", "skill-eval", "tasks.json");
export const SKILL_PATH = join(ROOT, "skills", "diagram-axi", "SKILL.md");
export const PACKET_SIZE = 8;

export function loadTasks(path = TASKS_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---- packets ----------------------------------------------------------------------------------

/** FNV-1a: a stable shuffle key so packets mix categories and the question ids carry no hint. */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Tasks in packet order, each with its neutral question id: q01, q02, ... */
export function questions(tasks) {
  return [...tasks]
    .sort((a, b) => fnv(a.id) - fnv(b.id) || (a.id < b.id ? -1 : 1))
    .map((task, i) => ({ qid: `q${String(i + 1).padStart(2, "0")}`, task }));
}

/** Questions split into packets of PACKET_SIZE. */
export function splitPackets(qs) {
  const out = [];
  for (let i = 0; i < qs.length; i += PACKET_SIZE) out.push(qs.slice(i, i + PACKET_SIZE));
  return out;
}

export function renderPacket(skillText, entries, n, total) {
  const requests = entries.map((e) => `### ${e.qid}\n${e.task.prompt}`).join("\n\n");
  const first = entries[0].qid;
  return `# diagram-axi skill eval, packet ${n} of ${total}

You are a coding agent. The skill below is loaded in your context and you have no tools: you cannot run
commands or read files. For each user request, decide how you would draw it with diagram-axi, using only
the skill text. Assume you have already written the graph out in full and run \`check\` on it, so you know
what \`check\` would print for the diagram described.

## Skill (SKILL.md)

\`\`\`\`markdown
${skillText.trimEnd()}
\`\`\`\`

## Requests

${requests}

## Answer format

Reply with exactly one line per request and nothing else:

\`\`\`
${first} | <engine> | <file> | <flags>
\`\`\`

- engine: excalidraw, d2 or mermaid, the engine that ends up rendering the diagram.
- file: the source file you would write, with its extension (for example login.d2).
- flags: the routing flags you would pass to \`diagram-axi draw\` for that file (\`--engine <x>\`, \`--target <x>\`),
  or \`-\` if none. Leave out \`--png\`, \`--svg\` and \`--force\`.
`;
}

export function emit(outDir, tasksFile = loadTasks(), skillText = readFileSync(SKILL_PATH, "utf8")) {
  const qs = questions(tasksFile.tasks);
  const packets = splitPackets(qs);
  mkdirSync(outDir, { recursive: true });
  const files = packets.map((entries, i) => {
    const name = `packet-${String(i + 1).padStart(2, "0")}.md`;
    writeFileSync(join(outDir, name), renderPacket(skillText, entries, i + 1, packets.length));
    return { file: name, tasks: entries.length };
  });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(qs.map((q) => ({ qid: q.qid, id: q.task.id })), null, 2) + "\n");
  return files;
}

// ---- scoring ----------------------------------------------------------------------------------

const ANSWER = /^[\s>*\-`]*(q\d+)\s*\|\s*([A-Za-z0-9_-]+)\s*\|\s*([^|]+?)\s*\|\s*(.*?)[\s`]*$/i;

/** `q03 | d2 | login.d2 | -` lines -> Map qid -> {engine, file, flags}. Other lines are ignored. */
export function parseAnswers(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = ANSWER.exec(line);
    if (!m) continue;
    const flags = m[4].trim() === "-" ? "" : m[4].trim().replace(/`/g, "");
    out.set(m[1].toLowerCase(), { engine: m[2].toLowerCase(), file: m[3].trim().replace(/`/g, ""), flags });
  }
  return out;
}

/** Source extension of an answer's file (`.mermaid` is `.mmd`). */
export function extOf(file) {
  const e = extname(basename(file)).toLowerCase();
  return e === ".mermaid" ? ".mmd" : e;
}

/**
 * The engine a file plus flags really selects: `.d2` and `.mmd` pick their own; for `.exd`, `--engine`
 * wins, then `--target markdown|github` (mermaid) or `editable` (excalidraw), else the excalidraw default.
 * "auto" means the router's pick; undefined means an extension no engine reads.
 */
export function effectiveEngine(file, flags) {
  const ext = extOf(file);
  if (ext === ".d2") return "d2";
  if (ext === ".mmd") return "mermaid";
  if (ext !== ".exd") return undefined;
  const f = Array.isArray(flags) ? flags.join(" ") : flags;
  const engine = /--engine[= ]\s*([a-z0-9]+)/i.exec(f)?.[1]?.toLowerCase();
  if (engine) return engine;
  const target = /--target[= ]\s*([a-z]+)/i.exec(f)?.[1]?.toLowerCase();
  if (target === "markdown" || target === "github") return "mermaid";
  if (target === "editable") return "excalidraw";
  return "excalidraw";
}

/** `--engine auto` is acceptable only when the task's accepted flags list it. */
const autoAllowed = (task) => task.expect.flags.some((spec) => spec.split("|").includes("--engine auto"));

/** One task against one parsed answer (undefined = unanswered). */
export function scoreTask(task, answer) {
  const { expect } = task;
  if (!answer) return { pass: false, why: "no answer" };
  const why = [];
  if (answer.engine !== expect.engine) why.push(`engine ${answer.engine} != ${expect.engine}`);
  const ext = extOf(answer.file);
  const exts = [expect.ext, ...(expect.alsoOk ?? []).map((a) => a.ext)];
  if (!exts.includes(ext)) why.push(`ext ${ext || "none"} not in ${exts.join("|")}`);
  const eff = effectiveEngine(answer.file, answer.flags);
  const effOk = eff === expect.engine || (eff === "auto" && ext === ".exd" && autoAllowed(task));
  if (!effOk) why.push(`file+flags select ${eff ?? "nothing"}, expected ${expect.engine}`);
  return { pass: why.length === 0, why: why.join("; ") };
}

/** Score every task; `answers` is a Map qid -> answer, `qs` the questions() list. */
export function scoreAll(tasksFile, qs, answers) {
  const rows = qs.map(({ qid, task }) => {
    const answer = answers.get(qid);
    return { qid, task, answer, ...scoreTask(task, answer) };
  });
  const byCat = new Map();
  for (const r of rows) {
    const c = byCat.get(r.task.category) ?? { pass: 0, total: 0 };
    c.total++;
    if (r.pass) c.pass++;
    byCat.set(r.task.category, c);
  }
  const pass = rows.filter((r) => r.pass).length;
  const bar = tasksFile.bar;
  const perfect = bar.perfectCategories.map((c) => ({ category: c, ...(byCat.get(c) ?? { pass: 0, total: 0 }) }));
  const ok = pass >= bar.pass && perfect.every((p) => p.total > 0 && p.pass === p.total);
  return { rows, byCat, pass, total: rows.length, bar, perfect, ok };
}

const cell = (s) => String(s).replace(/,/g, ";");

/** TOON-style summary: per task, per category, overall. */
export function formatReport(result) {
  const { rows, byCat, pass, total, bar, perfect, ok } = result;
  const lines = [];
  lines.push(`tasks[${rows.length}]{id,category,expected,got,pass}:`);
  for (const r of rows) {
    const e = r.task.expect;
    const expected = `${e.engine} ${e.ext}${e.alsoOk ? "+" + e.alsoOk.map((a) => a.ext).join("+") : ""}`;
    const got = r.answer ? `${r.answer.engine} ${r.answer.file} ${r.answer.flags || "-"}` : "-";
    lines.push(`  ${cell(r.task.id)},${r.task.category},${cell(expected)},${cell(got)},${r.pass ? "yes" : "no"}`);
  }
  lines.push(`categories[${byCat.size}]{category,pass,total}:`);
  for (const [c, v] of byCat) lines.push(`  ${c},${v.pass},${v.total}`);
  const failed = rows.filter((r) => !r.pass);
  if (failed.length > 0) {
    lines.push(`failures[${failed.length}]{id,why}:`);
    for (const r of failed) lines.push(`  ${cell(r.task.id)},${cell(r.why)}`);
  }
  lines.push("overall:");
  lines.push(`  pass: ${pass}/${total}`);
  lines.push(`  bar: ">= ${bar.pass}/${bar.total} and 100% on ${bar.perfectCategories.join(", ")}"`);
  for (const p of perfect) lines.push(`  ${p.category}: ${p.pass}/${p.total}`);
  lines.push(`  result: ${ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

/** Read every answers-NN.md in `dir` into one Map qid -> answer. */
export function readAnswers(dir) {
  const files = readdirSync(dir).filter((f) => /^answers-\d+\.md$/.test(f)).sort();
  const answers = new Map();
  for (const f of files) for (const [k, v] of parseAnswers(readFileSync(join(dir, f), "utf8"))) answers.set(k, v);
  return { files, answers };
}

// ---- CLI --------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/skill-eval.mjs emit [--out <dir>]
       node scripts/skill-eval.mjs score <answers-dir>`;

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "emit") {
    const i = rest.indexOf("--out");
    const outDir = resolve(i >= 0 && rest[i + 1] ? rest[i + 1] : join(ROOT, "out", "skill-eval"));
    const files = emit(outDir);
    console.log(`packets[${files.length}]{file,tasks}:`);
    for (const f of files) console.log(`  ${f.file},${f.tasks}`);
    console.log(`out: ${outDir}`);
    console.log(`next: run one tool-less subagent per packet; save each reply as answers-NN.md in that folder, then: node scripts/skill-eval.mjs score ${outDir}`);
    return 0;
  }
  if (cmd === "score") {
    if (!rest[0]) {
      console.log(`error: score needs an answers directory\n${USAGE}`);
      return 2;
    }
    const dir = resolve(rest[0]);
    if (!existsSync(dir)) {
      console.log(`error: no such directory: ${dir}`);
      return 2;
    }
    const { files, answers } = readAnswers(dir);
    if (files.length === 0) {
      console.log(`error: no answers-NN.md files in ${dir}`);
      return 2;
    }
    const tasksFile = loadTasks();
    const qs = questions(tasksFile.tasks);
    // A manifest from `emit` pins the question order even if tasks.json changed since.
    const manifestPath = join(dir, "manifest.json");
    if (existsSync(manifestPath)) {
      const byId = new Map(tasksFile.tasks.map((t) => [t.id, t]));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.every((m) => byId.has(m.id))) qs.splice(0, qs.length, ...manifest.map((m) => ({ qid: m.qid, task: byId.get(m.id) })));
    }
    const result = scoreAll(tasksFile, qs, answers);
    console.log(`answers: ${files.join(", ")} (${answers.size} lines)`);
    console.log(formatReport(result));
    return result.ok ? 0 : 1;
  }
  console.log(`error: ${cmd ? `unknown command '${cmd}'` : "missing command"}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
