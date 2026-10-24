#!/usr/bin/env node
// Authoring eval for the diagram-axi agent skill. Manual, never run in CI, and this script never calls a model:
// it builds the prompts and work folders, then scores what the agents left behind.
//
//   node scripts/skill-author.mjs prepare --out <dir> [--force]   work folders <dir>/<id>/ + packet-01..04.md
//   node scripts/skill-author.mjs score <dir>                     re-check every task folder, print TOON, exit 1 below the bar
//
// An agent gets only SKILL.md plus a shell. Run one agent per packet, save its final reply as answers-NN.md next
// to the packet, then score. Ground truth: test/skill-author/tasks.json. Scoring uses `check` and the quality
// analysis of a re-draw (no PNG needed); a PNG only has to exist. Also writes <dir>/vision-packet.md (optional
// V1-V10 review of the agents' PNGs) and <dir>/report.json.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHECKLIST } from "./qa/extract-packet.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TASKS_PATH = join(ROOT, "test", "skill-author", "tasks.json");
export const SKILL_PATH = join(ROOT, "skills", "diagram-axi", "SKILL.md");
export const PACKETS = 4;
export const SOURCE_EXTS = [".exd", ".d2", ".mmd"];

const posix = (p) => p.split("\\").join("/");
const pad2 = (n) => String(n).padStart(2, "0");

export function loadTasks(path = TASKS_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---- prepare ----------------------------------------------------------------------------------

/** Tasks dealt round-robin into `n` packets, so every packet mixes fitting, outgrowing and native-kind tasks. */
export function splitPackets(tasks, n = PACKETS) {
  const packets = Array.from({ length: Math.min(n, tasks.length) }, () => []);
  tasks.forEach((t, i) => packets[i % packets.length].push(t));
  return packets;
}

export function renderPacket({ skillText, tasks, n, total, outDir, repoRoot }) {
  const base = posix(resolve(outDir));
  const bin = `node ${posix(resolve(repoRoot))}/bin/diagram-axi.js`;
  const sections = tasks
    .map((t) => {
      const input = t.input?.copy ? `\nThe folder already contains \`${t.input.copy}/\` (a copy of the project to look at).` : "";
      return `### ${t.id}\nWork folder: \`${base}/${t.id}/\`\n\n${t.prompt}${input}`;
    })
    .join("\n\n");
  const first = tasks[0].id;
  return `# diagram-axi authoring eval, packet ${n} of ${total}

You are a coding agent with a shell. The skill below is the only documentation of the \`diagram-axi\` tool you have.
For each request, produce the diagram the user asked for: write its source file, check it, draw it, fix what the
tool tells you to fix, and end with a PNG of the final diagram.

## Rules

- Where the skill says \`npx -y diagram-axi\`, run \`${bin}\` instead (the package is not published yet).
- Work only inside the work folder of each task. Write the source file and every output (\`.excalidraw\`, \`.d2\`,
  \`.mmd\`, \`.svg\`, \`.png\`) directly in that folder, not in a sub-folder. Any base name is fine.
- Learn the tool from the skill text and from the tool's own output (\`--help\`, \`syntax\`, \`check\`, \`draw\`).
  Do not read the tool's source code or any other folder; do not look at other tasks' folders.
- The final PNG is required for every task (\`--png\`). Rendering needs an installed browser; the tool finds it itself.
  Never start your own browser, and never kill processes by name (no \`taskkill /IM\`, no \`pkill\`).
- Do the tasks one after another. Count your attempts per task: every \`check\` or \`draw\` run is one attempt.

## Skill (SKILL.md)

\`\`\`\`markdown
${skillText.trimEnd()}
\`\`\`\`

## Requests

${sections}

## Final report

Your final reply must contain exactly one line per request and nothing else (paths relative to the task's work folder):

\`\`\`
${first} | <engine> | <source file> | <png file> | <attempts>
\`\`\`

- engine: excalidraw, d2 or mermaid, the engine that rendered the final diagram.
- source file: the file you wrote and drew from (for example \`login.d2\`).
- png file: the final PNG.
- attempts: the number of \`check\` and \`draw\` runs you made for that task.
`;
}

/** Create the work folders (+ input copies) and packets. Refuses to touch a non-empty task folder without force. */
export function prepare(outDir, { tasksFile = loadTasks(), skillText = readFileSync(SKILL_PATH, "utf8"), repoRoot = ROOT, force = false } = {}) {
  outDir = resolve(outDir);
  const busy = tasksFile.tasks.filter((t) => existsSync(join(outDir, t.id)) && readdirSync(join(outDir, t.id)).length > 0);
  if (busy.length > 0 && !force) throw new Error(`task folders not empty (${busy.map((t) => t.id).join(", ")}); pass --force to recreate them`);
  mkdirSync(outDir, { recursive: true });
  for (const t of tasksFile.tasks) {
    const dir = join(outDir, t.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (t.input?.copy) cpSync(join(repoRoot, t.input.copy), join(dir, t.input.copy), { recursive: true });
  }
  const packets = splitPackets(tasksFile.tasks);
  const files = packets.map((tasks, i) => {
    const file = `packet-${pad2(i + 1)}.md`;
    writeFileSync(join(outDir, file), renderPacket({ skillText, tasks, n: i + 1, total: packets.length, outDir, repoRoot }));
    return { file, tasks: tasks.map((t) => t.id) };
  });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(files, null, 2) + "\n");
  return files;
}

// ---- reading what the agents left -------------------------------------------------------------

const REPORT_LINE = /^[\s>*\-`]*([a-z0-9][a-z0-9-]*)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\d+)[\s`]*$/i;
const clean = (s) => s.trim().replace(/[`"']/g, "");

/** `id | engine | source | png | attempts` lines -> Map id -> {engine, source, png, attempts}. Other lines are ignored. */
export function parseReport(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = REPORT_LINE.exec(line);
    if (m) out.set(m[1].toLowerCase(), { engine: clean(m[2]).toLowerCase(), source: clean(m[3]), png: clean(m[4]), attempts: Number(m[5]) });
  }
  return out;
}

export function readReports(dir) {
  const files = readdirSync(dir).filter((f) => /^answers-\d+\.md$/.test(f)).sort();
  const reports = new Map();
  for (const f of files) for (const [k, v] of parseReport(readFileSync(join(dir, f), "utf8"))) reports.set(k, v);
  return { files, reports };
}

/** Plain files at the top of a task folder (the work folder contract), newest first; scratch (`_*`) and sidecars skipped. */
export function rootFiles(taskDir) {
  if (!existsSync(taskDir)) return [];
  return readdirSync(taskDir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("_") && !d.name.endsWith(".map.json"))
    .map((d) => ({ name: d.name, path: join(taskDir, d.name), mtime: statSync(join(taskDir, d.name)).mtimeMs, size: statSync(join(taskDir, d.name)).size }))
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
}

const extOf = (name) => {
  const e = extname(name).toLowerCase();
  return e === ".mermaid" ? ".mmd" : e;
};

/** The source file: the reported one if it exists in the folder, else the newest .exd/.d2/.mmd. */
export function findSource(taskDir, reported) {
  const files = rootFiles(taskDir);
  const named = reported ? files.find((f) => f.name.toLowerCase() === basename(reported.replace(/\\/g, "/")).toLowerCase()) : undefined;
  if (named && SOURCE_EXTS.includes(extOf(named.name))) return named.path;
  return files.find((f) => SOURCE_EXTS.includes(extOf(f.name)))?.path;
}

/** True for a non-empty file that starts with the PNG signature. */
export function isPng(path) {
  try {
    return statSync(path).size > 8 && readFileSync(path).subarray(0, 4).toString("latin1") === "\x89PNG";
  } catch {
    return false;
  }
}

/**
 * Engine that rendered the diagram: .d2 and .mmd pick their own; for .exd the newest sibling output of the same base
 * name (.mmd = mermaid, .d2 = d2, .excalidraw = excalidraw) decides, else the reported engine, else excalidraw.
 */
export function deriveEngine(source, reportedEngine) {
  const ext = extOf(source);
  if (ext === ".d2") return "d2";
  if (ext === ".mmd") return "mermaid";
  const stem = join(dirname(source), basename(source, extname(source)));
  const sibs = [[".mmd", "mermaid"], [".d2", "d2"], [".excalidraw", "excalidraw"]]
    .filter(([e]) => existsSync(stem + e))
    .sort((a, b) => statSync(stem + b[0]).mtimeMs - statSync(stem + a[0]).mtimeMs);
  if (sibs.length > 0) return sibs[0][1];
  return ["excalidraw", "d2", "mermaid"].includes(reportedEngine) ? reportedEngine : "excalidraw";
}

/** Source text without comment lines (`#`, `//`, `%%`), lower case, `_`/`-` read as spaces, whitespace collapsed. */
export function normText(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|\/\/|%%)/.test(l))
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ");
}

/** The `mustContain` labels (with `a|b` alternatives) that do not appear in the source text. */
export function missingLabels(text, labels) {
  const hay = normText(text);
  const norm = (s) => s.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  return labels.filter((l) => !l.split("|").some((alt) => hay.includes(norm(alt))));
}

// ---- cli-backed checks (injectable for tests) -------------------------------------------------

/** `check <source>`: {exit, errors, warnings}. */
export async function cliCheck(source) {
  const { runDraw } = await import("./qa/run.mjs");
  const r = await runDraw(["check", source]);
  const m = /check: (\w+), (\d+) errors?, (\d+) warnings?/.exec(r.stdout);
  return { exit: r.status, errors: m ? Number(m[2]) : r.status === 0 ? 0 : 1, warnings: m ? Number(m[3]) : 0, detail: m ? "" : (r.stdout + r.stderr).trim().split("\n")[0] ?? "" };
}

/**
 * Re-draw `source` into <taskDir>/_score with the derived engine (SVG + geometry sidecar for d2/mermaid, no PNG)
 * and run the shared quality analysis. Returns {ok, error?, nodes, hard, soft, kind}.
 */
export async function cliAnalyze({ source, engine, taskDir }) {
  const [{ runDraw }, { analyzeScene }, eng] = await Promise.all([import("./qa/run.mjs"), import("./qa/analyze.mjs"), import("./qa/engines.mjs")]);
  const scratch = join(taskDir, "_score");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const base = join(scratch, "q");
  const args = ["draw", source, "--out", base, "--force"];
  if (extOf(source) === ".exd") args.push("--engine", engine);
  if (eng.isEngine(engine)) args.push("--svg", "--geometry-json");
  const r = await runDraw(args);
  if (r.status !== 0) return { ok: false, error: `draw exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n").slice(0, 2).join(" | ").slice(0, 200)}`, nodes: 0, hard: 0, soft: 0 };
  const nodes = Number(/scene: (\d+) nodes?/.exec(r.stdout)?.[1] ?? NaN);
  try {
    let scene;
    let findingsOf = (f) => f;
    if (eng.isEngine(engine)) {
      const g = eng.readEngineGeometry(base);
      scene = { elements: await eng.sceneOf(g) };
      findingsOf = (f) => eng.maskFindings(f, g.rules_skipped);
    } else {
      scene = JSON.parse(readFileSync(`${base}.excalidraw`, "utf8"));
    }
    const fs = findingsOf(analyzeScene(scene).findings);
    return { ok: true, nodes, hard: fs.filter((f) => f.severity === "hard").length, soft: fs.filter((f) => f.severity === "soft").length, kind: /^kind: (\w+)/m.exec(r.stdout)?.[1] };
  } catch (err) {
    return { ok: false, error: `geometry unreadable: ${err.message}`, nodes, hard: 0, soft: 0 };
  }
}

export const defaultDeps = { check: cliCheck, analyze: cliAnalyze };

// ---- scoring ----------------------------------------------------------------------------------

/** One task folder -> a result row. `pass` needs parse ok, 0 HARD, an allowed engine, every label and the PNG. */
export async function scoreTask(task, outDir, report, deps = defaultDeps) {
  const { expect } = task;
  const taskDir = join(outDir, task.id);
  const row = { id: task.id, task, attempts: report?.attempts, source: undefined, engine: undefined, engineOk: false, parseOk: false, warnings: 0, hard: 0, soft: 0, nodes: undefined, nodesOk: false, missing: [], png: undefined, pngOk: false, filesMissing: [], pass: false, why: [] };
  const fail = (why) => row.why.push(why);
  const source = findSource(taskDir, report?.source);
  const files = rootFiles(taskDir);
  const pngs = files.filter((f) => extOf(f.name) === ".png" && isPng(f.path));
  const reportedPng = report?.png ? pngs.find((f) => f.name.toLowerCase() === basename(report.png.replace(/\\/g, "/")).toLowerCase()) : undefined;
  row.png = (reportedPng ?? pngs[0])?.path;
  row.pngOk = row.png !== undefined;
  if (!source) {
    fail(existsSync(taskDir) && files.length > 0 ? "no .exd/.d2/.mmd source in the task folder" : "no work product");
    if (!row.pngOk) fail("no PNG");
    return row;
  }
  row.source = source;
  row.engine = deriveEngine(source, report?.engine);
  row.engineOk = [expect.engine, ...(expect.allowedEngines ?? [])].includes(row.engine);
  if (!row.engineOk) fail(`engine ${row.engine}, expected ${[expect.engine, ...(expect.allowedEngines ?? [])].join("|")}`);

  const chk = await deps.check(source);
  row.warnings = chk.warnings;
  row.parseOk = chk.exit === 0 && chk.errors === 0;
  if (!row.parseOk) fail(`check failed (${chk.errors} errors)${chk.detail ? `: ${chk.detail}` : ""}`);

  const an = await deps.analyze({ source, engine: row.engine, taskDir });
  if (!an.ok) {
    row.parseOk = false;
    fail(an.error ?? "draw failed");
  } else {
    row.hard = an.hard;
    row.soft = an.soft;
    row.nodes = an.nodes;
    row.nodesOk = Number.isFinite(an.nodes) && an.nodes >= expect.minNodes && an.nodes <= expect.maxNodes;
    if (an.hard > 0) fail(`${an.hard} HARD quality finding${an.hard > 1 ? "s" : ""}`);
  }

  row.missing = missingLabels(readFileSync(source, "utf8"), expect.mustContain);
  if (row.missing.length > 0) fail(`missing labels: ${row.missing.join(", ")}`);
  if (!row.pngOk) fail("no valid PNG");
  const have = new Set(files.filter((f) => f.size > 0).map((f) => extOf(f.name)));
  row.filesMissing = (expect.files ?? []).filter((e) => e !== ".png" && !have.has(e));
  if (row.filesMissing.length > 0) fail(`missing output files: ${row.filesMissing.join(", ")}`);
  row.pass = row.why.length === 0;
  return row;
}

export async function scoreAll(tasksFile, outDir, reports, deps = defaultDeps) {
  const rows = [];
  for (const task of tasksFile.tasks) rows.push(await scoreTask(task, outDir, reports.get(task.id.toLowerCase()), deps));
  const pass = rows.filter((r) => r.pass).length;
  const bar = tasksFile.bar;
  const att = rows.map((r) => r.attempts).filter((a) => Number.isFinite(a));
  return { rows, pass, total: rows.length, bar, ok: pass >= bar.pass, avgAttempts: att.length ? att.reduce((a, b) => a + b, 0) / att.length : undefined };
}

const cell = (s) => String(s ?? "-").replace(/,/g, ";");
const yn = (b) => (b ? "yes" : "no");

/** TOON-style summary: per task, failures, notes, overall. */
export function formatReport(result) {
  const { rows, pass, total, bar, ok, avgAttempts } = result;
  const lines = [`tasks[${rows.length}]{id,pass,engine,expected,parse,warn,hard,nodes,labels,png,attempts}:`];
  for (const r of rows) {
    const e = r.task.expect;
    const nodes = r.nodes === undefined ? "-" : `${r.nodes}${r.nodesOk ? "" : "!"}`;
    const labels = `${e.mustContain.length - r.missing.length}/${e.mustContain.length}`;
    lines.push(`  ${cell(r.id)},${yn(r.pass)},${cell(r.engine)},${cell(e.engine)},${yn(r.parseOk)},${r.source ? r.warnings : "-"},${r.source ? r.hard : "-"},${nodes},${r.source ? labels : "-"},${yn(r.pngOk)},${cell(r.attempts)}`);
  }
  const failed = rows.filter((r) => !r.pass);
  if (failed.length > 0) {
    lines.push(`failures[${failed.length}]{id,why}:`);
    for (const r of failed) lines.push(`  ${cell(r.id)},${cell(r.why.join("; "))}`);
  }
  const off = rows.filter((r) => r.source && !r.nodesOk && r.nodes !== undefined);
  if (off.length > 0) {
    lines.push(`notes[${off.length}]{id,nodes,expected}:`);
    for (const r of off) lines.push(`  ${cell(r.id)},${r.nodes},${r.task.expect.minNodes}-${r.task.expect.maxNodes} (reported only; not part of the bar)`);
  }
  lines.push("overall:");
  lines.push(`  pass: ${pass}/${total}`);
  lines.push(`  bar: ">= ${bar.pass}/${bar.total}: parse ok, 0 HARD, allowed engine, all labels, PNG"`);
  if (avgAttempts !== undefined) lines.push(`  attempts_avg: ${avgAttempts.toFixed(1)}`);
  lines.push(`  result: ${ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

// ---- optional vision review packet ------------------------------------------------------------

/** Markdown packet for a vision reviewer: the PNGs of passing-or-not tasks, V1-V10, and a faithfulness check. */
export function visionPacket(rows) {
  const withPng = rows.filter((r) => r.png);
  const items = withPng
    .map((r) => `### ${r.id} (${r.engine ?? "?"})\n- image: \`${posix(r.png)}\`\n- request: ${r.task.prompt}\n- labels that must be visible: ${r.task.expect.mustContain.join(", ")}`)
    .join("\n\n");
  const rules = [...CHECKLIST.filter(([k]) => /^V\d+$/.test(k)), ["V-A1", "the diagram shows what the request asked for: its boxes, the listed labels and the arrows between them, nothing important missing or invented"]];
  const example = Object.fromEntries([["case", withPng[0]?.id ?? "web-arch"], ...rules.map(([k]) => [k, k === "V10" ? "yes" : k === "V9" ? "n/a" : "pass"]), ["note", "one line, empty when all pass"]]);
  return `# authoring eval, vision review packet

You review rendered diagrams that coding agents drew from a plain-language request. You have the Read tool for images only;
open each PNG below (absolute paths) and judge it against its request. Do not run commands, do not edit files.

## Images (${withPng.length})

${items}

## Checklist per image (pass / fail / n-a each; V10 yes / no)

${rules.map(([k, t]) => `- ${k}: ${t}`).join("\n")}

Judge only what is drawn. Sequence, ER and state diagrams have lifelines, tables or states instead of arrows between boxes:
apply V1-V8 to their equivalents (messages, relations, transitions) and mark rules that cannot apply n/a.

## Reply format

Reply with one JSON array, nothing else, one object per image in the order above:

\`\`\`json
[
${JSON.stringify(example)}
]
\`\`\`

For every fail give the failing rule, what you see and where in the \`note\`.
`;
}

// ---- CLI --------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/skill-author.mjs prepare --out <dir> [--force]
       node scripts/skill-author.mjs score <dir>`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "prepare") {
    const i = rest.indexOf("--out");
    if (i < 0 || !rest[i + 1]) {
      console.log(`error: prepare needs --out <dir>\n${USAGE}`);
      return 2;
    }
    const outDir = resolve(rest[i + 1]);
    let files;
    try {
      files = prepare(outDir, { force: rest.includes("--force") });
    } catch (err) {
      console.log(`error: ${err.message}`);
      return 2;
    }
    console.log(`packets[${files.length}]{file,tasks}:`);
    for (const f of files) console.log(`  ${f.file},${f.tasks.join(" ")}`);
    console.log(`out: ${posix(outDir)}`);
    console.log(`next: run one agent per packet (all four may run at once), save each final reply as answers-NN.md in that folder, then: node scripts/skill-author.mjs score ${posix(outDir)}`);
    return 0;
  }
  if (cmd === "score") {
    if (!rest[0]) {
      console.log(`error: score needs a run directory\n${USAGE}`);
      return 2;
    }
    const dir = resolve(rest[0]);
    if (!existsSync(dir)) {
      console.log(`error: no such directory: ${posix(dir)}`);
      return 2;
    }
    const tasksFile = loadTasks();
    const { files, reports } = readReports(dir);
    const result = await scoreAll(tasksFile, dir, reports);
    for (const r of result.rows) rmSync(join(dir, r.id, "_score"), { recursive: true, force: true });
    writeFileSync(join(dir, "vision-packet.md"), visionPacket(result.rows));
    writeFileSync(join(dir, "report.json"), JSON.stringify({ pass: result.pass, total: result.total, ok: result.ok, tasks: result.rows.map((r) => ({ id: r.id, pass: r.pass, engine: r.engine, hard: r.hard, warnings: r.warnings, nodes: r.nodes, missing: r.missing, png: r.pngOk, attempts: r.attempts, why: r.why })) }, null, 2) + "\n");
    console.log(`answers: ${files.length ? files.join(", ") : "none"} (${reports.size} report lines)`);
    console.log(formatReport(result));
    console.log(`vision: ${posix(join(dir, "vision-packet.md"))}`);
    return result.ok ? 0 : 1;
  }
  console.log(`error: ${cmd ? `unknown command '${cmd}'` : "missing command"}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
