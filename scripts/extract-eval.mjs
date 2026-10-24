#!/usr/bin/env node
// Agent-usefulness eval for `extract` (plan 2026-10-24-extract-plan.md section 5.4). Manual, never run in CI,
// and this script never calls a model: it derives answers, builds the prompts and scores the replies.
//
//   node scripts/extract-eval.mjs emit [--out out/extract-eval]    write packet-01..03.md (+ manifest.json)
//   node scripts/extract-eval.mjs score <answers-dir>              read answers-01..03.md, print TOON, exit 1 below the bar
//   node scripts/extract-eval.mjs derive [--write | --check]       re-derive the expected answers from the raw graphs
//
// Material per agent: for 2 repos (this repo's src/, hono@v4.13.13 src/) the `extract` TOON output, the .exd and a
// trimmed sidecar of two views (default, and --focus on the entry), plus the 15 questions of
// test/extract-eval/questions.json. Run one tool-less subagent per packet, save its reply as answers-NN.md in the
// packet folder, then score. Expected answers come from the RawGraph (`extract --format json`), not from the views.
// Counting convention shown to the agents: value imports only, test files ignored.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const QUESTIONS_PATH = join(ROOT, "test", "extract-eval", "questions.json");
const BIN = join(ROOT, "bin", "diagram-axi.js");
export const AGENTS = 3;

export const loadQuestions = (path = QUESTIONS_PATH) => JSON.parse(readFileSync(path, "utf8"));

// ---- scoring ----------------------------------------------------------------------------------

/** Spelling-insensitive form of one answer item: no quotes/backticks, no `src/` or `./`, no trailing slash or `(n files)`. */
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/[`*"']/g, "")
    .replace(/\s*\(\d+ files?\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^src\//, "")
    .replace(/[/.]+$/, "");
}

/** Accepted spellings of an expected item: itself plus, for a nested path, its last segment. */
const spellings = (item) => {
  const n = norm(item);
  return n.includes("/") ? [n, n.slice(n.lastIndexOf("/") + 1)] : [n];
};

const ANSWER = /^[\s>*\-`]*(q\d+)\s*\|\s*(.*?)[\s`]*$/i;

/** `q03 | answer` lines -> Map qid -> raw answer text. Other lines are ignored. */
export function parseAnswers(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = ANSWER.exec(line);
    if (m) out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}

const items = (answer) => answer.split(/\s*(?:;|,|\band\b|\|)\s*/i).map(norm).filter(Boolean);

/** One question against one raw answer text (undefined = unanswered). */
export function scoreQuestion(q, answer) {
  if (answer === undefined || answer === "") return { pass: false, why: "no answer" };
  if (q.type === "number") {
    const m = /-?\d+/.exec(answer);
    return m && Number(m[0]) === q.expected ? { pass: true, why: "" } : { pass: false, why: `got ${m ? m[0] : answer}, expected ${q.expected}` };
  }
  if (q.type === "one") {
    // `expected` lists every accepted answer (where-to-start questions accept a set); one of them is enough.
    const accepted = new Set(q.expected.flatMap(spellings));
    const got = items(answer);
    return got.length === 1 && accepted.has(got[0]) ? { pass: true, why: "" } : { pass: false, why: `got ${answer}, accepted ${q.expected.join(" | ")}` };
  }
  // set: all expected items and nothing else
  const want = q.expected.map(spellings);
  const got = items(answer);
  const missing = want.filter((alts) => !got.some((g) => alts.includes(g)));
  const extra = got.filter((g) => !want.some((alts) => alts.includes(g)));
  const ok = missing.length === 0 && extra.length === 0 && got.length === want.length;
  return { pass: ok, why: ok ? "" : `missing [${missing.map((m) => m[0]).join(" ")}] extra [${extra.join(" ")}]` };
}

/** Score one agent's answers (Map qid -> text). */
export function scoreAgent(qf, answers) {
  const rows = qf.questions.map((q) => ({ q, answer: answers.get(q.id), ...scoreQuestion(q, answers.get(q.id)) }));
  const pass = rows.filter((r) => r.pass).length;
  const entryOk = rows.filter((r) => r.q.entry).every((r) => r.pass);
  const ok = pass >= qf.bar.pass && (!qf.bar.entryAllAgents || entryOk);
  return { rows, pass, total: rows.length, entryOk, ok };
}

const cell = (s) => String(s ?? "").replace(/[,\n]/g, ";");

/** TOON summary over all agents: per question x agent, per agent, overall. */
export function formatReport(qf, perAgent) {
  const lines = [];
  lines.push(`questions[${qf.questions.length}]{id,repo,entry,expected,${perAgent.map((_, i) => `a${i + 1}`).join(",")}}:`);
  qf.questions.forEach((q, i) => {
    const exp = Array.isArray(q.expected) ? q.expected.join(" | ") : q.expected;
    lines.push(`  ${q.id},${q.repo},${q.entry ? "entry" : "-"},${cell(exp)},${perAgent.map((a) => (a.rows[i].pass ? "ok" : "no")).join(",")}`);
  });
  lines.push(`agents[${perAgent.length}]{agent,pass,total,entry_ok,result}:`);
  perAgent.forEach((a, i) => lines.push(`  a${i + 1},${a.pass},${a.total},${a.entryOk ? "yes" : "no"},${a.ok ? "PASS" : "FAIL"}`));
  const fails = perAgent.flatMap((a, i) => a.rows.filter((r) => !r.pass).map((r) => `  a${i + 1},${r.q.id},${cell(r.why)}`));
  if (fails.length) lines.push(`failures[${fails.length}]{agent,id,why}:`, ...fails);
  const ok = perAgent.length > 0 && perAgent.every((a) => a.ok);
  lines.push("overall:");
  lines.push(`  bar: ">= ${qf.bar.pass}/${qf.bar.total} per agent and every agent names the entry file"`);
  lines.push(`  result: ${ok ? "PASS" : "FAIL"}`);
  return { text: lines.join("\n"), ok };
}

export function readAnswers(dir) {
  const files = readdirSync(dir).filter((f) => /^answers-\d+\.md$/.test(f)).sort();
  return { files, agents: files.map((f) => parseAnswers(readFileSync(join(dir, f), "utf8"))) };
}

// ---- views (extract runs) ---------------------------------------------------------------------

/** Run the built cli in `cwd`; returns {status, stdout}. */
function cli(cwd, args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", timeout: 120000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

/** Where each repo lives: self is this repo's src/, hono comes from the QA corpus (cloned by scripts/qa/extract.mjs). */
export async function repoSources() {
  const { REPOS, ensureRepo } = await import("./qa/extract.mjs");
  const hono = REPOS.find((r) => r.name === "hono");
  const h = ensureRepo(hono);
  return {
    self: { cwd: ROOT, scan: "src", focus: "src/commands/draw.ts", rev: git(ROOT, ["rev-parse", "HEAD"]), tree: git(ROOT, ["rev-parse", "HEAD:src"]), title: "diagram-axi, a TypeScript CLI (folder src/)" },
    hono: { cwd: h.dir, scan: "src", focus: "src/hono.ts", rev: h.sha, tag: hono.tag, title: `hono ${hono.tag}, a TypeScript web framework (folder src/)` },
  };
}

export function rawGraph(src) {
  mkdirSync(join(ROOT, "out"), { recursive: true });
  const out = join(ROOT, "out", `.extract-eval-raw-${process.pid}`);
  const r = cli(src.cwd, ["extract", src.scan, "--format", "json", "--out", out, "--force"]);
  if (r.status !== 0) throw new Error(`extract --format json failed: ${r.stdout.slice(0, 300)}`);
  const g = JSON.parse(readFileSync(`${out}.json`, "utf8"));
  rmSync(`${out}.json`, { force: true });
  return g;
}

/** Default or focus view: {toon, exd, map}. Output paths in the TOON are rewritten to `imports`. */
export function view(src, kind, tmp) {
  const base = join(tmp, `${kind}`);
  const args = ["extract", src.scan, ...(kind === "focus" ? ["--focus", src.focus, "--depth", "2"] : []), "--out", base, "--force"];
  const r = cli(src.cwd, args);
  if (r.status !== 0) throw new Error(`extract failed: ${r.stdout.slice(0, 300)}`);
  const slash = (p) => p.split("\\").join("/");
  const toon = r.stdout.split(slash(relative(src.cwd, base))).join("imports").split(slash(base)).join("imports").split(base).join("imports");
  return { toon: toon.trim(), exd: readFileSync(`${base}.exd`, "utf8").trim(), map: JSON.parse(readFileSync(`${base}.exd.map.json`, "utf8")) };
}

/** Sidecar without evidence and sizes: what an agent needs to go from a box to its folder/file and to see hidden hub edges. */
export function trimSidecar(map) {
  const nodes = Object.fromEntries(Object.entries(map.nodes).map(([id, n]) => [id, [n.path, n.kind, ...(n.files ? [`${n.files} files`] : [])].join(" ")]));
  const edge = (e) => `${e.from} -> ${e.to}${e.weight > 1 ? ` x${e.weight}` : ""}${e.typeOnly ? " type-only" : ""}${e.dynamic ? " dynamic" : ""}`;
  const h = map.hidden;
  const trimmed = {
    meta: { root: map.meta.root, files: map.meta.stats.files, edges: map.meta.stats.edges },
    nodes,
    edges: map.edges.map(edge),
    hidden: { externals: (h.externals ?? []).map((x) => x.name), tests: (h.tests ?? []).length, hubEdges: (h.hubEdges ?? []).map(edge), sccs: h.sccs ?? [] },
  };
  const list = (arr) => (arr.length ? `[\n${arr.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : "[]");
  const obj = (o) => `{\n${Object.entries(o).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n  }`;
  return [
    "{",
    `  "meta": ${JSON.stringify(trimmed.meta)},`,
    `  "nodes": ${obj(trimmed.nodes)},`,
    `  "edges": ${list(trimmed.edges)},`,
    `  "hidden": ${JSON.stringify({ externals: trimmed.hidden.externals, testFilesIgnored: trimmed.hidden.tests })},`,
    `  "hubEdges": ${list(trimmed.hidden.hubEdges)},`,
    `  "cycles": ${JSON.stringify(trimmed.hidden.sccs)}`,
    "}",
  ].join("\n");
}

// ---- derivation from the raw graph ------------------------------------------------------------

const topOf = (p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : ".");

/** Non-test files and the value edges between them (type-only imports ignored). */
export function valueGraph(raw) {
  const files = raw.files.filter((f) => !f.test).map((f) => f.path);
  const set = new Set(files);
  const edges = raw.edges.filter((e) => set.has(e.from) && set.has(e.to) && !e.typeOnly && e.from !== e.to);
  return { files, edges };
}

/** Strongly connected components of size > 1 (Tarjan, iterative-safe sizes here are small). */
export function sccs(nodes, pairs) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of pairs) adj.get(a)?.push(b);
  let idx = 0;
  const ix = new Map(), low = new Map(), on = new Set(), st = [], out = [];
  const visit = (v) => {
    ix.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of adj.get(v)) {
      if (!ix.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w)));
    }
    if (low.get(v) === ix.get(v)) {
      const c = []; let w;
      do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1) out.push(c.sort());
    }
  };
  for (const n of nodes) if (!ix.has(n)) visit(n);
  return out;
}

const uniqueMax = (entries, what) => {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) throw new Error(`${what}: tie at the top (${sorted[0]} vs ${sorted[1]})`);
  return sorted[0];
};
const count = (arr, key) => arr.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map());

/** Box of a raw file in a default-view sidecar: exact file node or the dir node whose path is a prefix. */
const boxOf = (nodes, file) => Object.entries(nodes).find(([, n]) => (n.kind === "file" && n.path === file) || (n.kind === "dir" && file.startsWith(`${n.path}/`)))?.[0];

/** Fresh questions.json content from the live repos (raises when a fact is ambiguous or disagrees with the view). */
export async function derive(srcs = undefined) {
  srcs ??= await repoSources();
  const tmp = join(ROOT, "out", `.extract-eval-derive-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const self = valueGraph(rawGraph(srcs.self));
    const hono = valueGraph(rawGraph(srcs.hono));
    const selfView = view(srcs.self, "default", tmp);
    const q = [];
    const add = (o) => q.push({ id: `q${String(q.length + 1).padStart(2, "0")}`, ...o });

    // -- self
    const roots = self.files.filter((f) => !self.edges.some((e) => e.to === f));
    const entry = roots.filter((f) => self.edges.some((e) => e.from === f && e.to === "cli/router.ts"));
    if (entry.length !== 1) throw new Error(`self: expected one root importing cli/router.ts, got ${entry}`);
    const draw = self.files.filter((f) => f === "commands/draw.ts");
    if (draw.length !== 1) throw new Error("self: commands/draw.ts missing");
    add({ repo: "self", type: "one", entry: true, prompt: "Where should you start reading to follow the `draw` command? Name one file.", expected: [entry[0], draw[0]], derivedBy: "the root file that imports cli/router.ts (the CLI entry) and the file that implements the command, commands/draw.ts" });
    add({ repo: "self", type: "one", entry: false, prompt: "Which file is the CLI entry point inside src/ (no other file in src/ imports it)?", expected: [entry[0]], derivedBy: "the one file with no importers that imports cli/router.ts" });
    const importers = new Map();
    for (const e of self.edges) if (topOf(e.from) !== topOf(e.to)) importers.set(topOf(e.to), (importers.get(topOf(e.to)) ?? new Set()).add(topOf(e.from)));
    const [mostImported] = uniqueMax([...importers].map(([k, s]) => [k, s.size]), "self most imported");
    add({ repo: "self", type: "one", entry: false, prompt: "Which top-level folder of src/ is imported by the most other top-level folders? Answer with the folder name.", expected: [mostImported], derivedBy: "distinct importing top-level folders per target folder" });
    const dslImporters = count(self.edges.filter((e) => e.to.startsWith("dsl/") && topOf(e.from) !== "dsl"), (e) => topOf(e.from));
    const [dslTop] = uniqueMax([...dslImporters], "self dsl importers");
    add({ repo: "self", type: "one", entry: false, prompt: "Which top-level folder imports dsl/ the most (number of import statements)? Answer with the folder name.", expected: [dslTop], derivedBy: "import statements from each other top-level folder into dsl/" });
    add({ repo: "self", type: "number", entry: false, prompt: "How many files does the layout/ folder have (test files not counted)?", expected: self.files.filter((f) => f.startsWith("layout/")).length, derivedBy: "non-test files under layout/" });
    // cycle at the granularity of the default view's boxes
    const nodes = selfView.map.nodes;
    const boxEdges = self.edges.map((e) => [boxOf(nodes, e.from), boxOf(nodes, e.to)]).filter(([a, b]) => a && b && a !== b);
    const boxIds = [...new Set(boxEdges.flat())];
    const boxCycles = sccs(boxIds, boxEdges).map((c) => c.map((id) => nodes[id].path).sort());
    const viewCycles = (selfView.map.hidden.sccs ?? []).map((c) => c.map((id) => nodes[id].path).sort());
    if (JSON.stringify(boxCycles) !== JSON.stringify(viewCycles)) throw new Error(`self: raw-derived box cycles ${JSON.stringify(boxCycles)} disagree with the sidecar ${JSON.stringify(viewCycles)}`);
    if (boxCycles.length !== 1) throw new Error(`self: expected exactly one cycle, got ${JSON.stringify(boxCycles)}`);
    add({ repo: "self", type: "set", entry: false, prompt: "The diagram marks one import cycle (red boxes). Name the boxes that are in it (as the folder or file path).", expected: boxCycles[0], derivedBy: "Tarjan SCC over the raw value edges collapsed to the default view's boxes; equals the sidecar's hidden.sccs" });
    const extractOut = [...new Set(self.edges.filter((e) => e.from.startsWith("extract/") && !e.to.startsWith("extract/")).map((e) => e.to))].sort();
    add({ repo: "self", type: "set", entry: false, prompt: "Which files outside extract/ does the extract/ folder import (value imports)? List the files.", expected: extractOut, derivedBy: "raw edges leaving extract/" });
    const outputImporters = new Set(self.edges.filter((e) => e.to.startsWith("output/") && !e.from.startsWith("output/")).map((e) => topOf(e.from)));
    add({ repo: "self", type: "number", entry: false, prompt: "How many different top-level folders (and root files) import something from output/?", expected: outputImporters.size, derivedBy: "distinct top-level importers of output/ (the hub; its incoming arrows are listed in the sidecar under hubEdges)" });

    // -- hono
    const honoRoots = hono.files.filter((f) => f === "index.ts");
    const idx = honoRoots[0];
    if (!idx || !hono.edges.some((e) => e.from === "index.ts" && e.to === "hono.ts") || !hono.edges.some((e) => e.from === "hono.ts" && e.to === "hono-base.ts")) throw new Error("hono: index.ts -> hono.ts -> hono-base.ts chain not found");
    add({ repo: "hono", type: "one", entry: true, prompt: "Where should you start reading to follow how `new Hono()` is built? Name one file.", expected: ["index.ts", "hono.ts", "hono-base.ts"], derivedBy: "the chain index.ts -> hono.ts -> hono-base.ts (public entry, class Hono, base class)" });
    const hImp = new Map();
    for (const e of hono.edges) if (topOf(e.from) !== topOf(e.to)) hImp.set(topOf(e.to), (hImp.get(topOf(e.to)) ?? new Set()).add(topOf(e.from)));
    const [hMost] = uniqueMax([...hImp].filter(([k]) => k !== ".").map(([k, s]) => [k, s.size]), "hono most imported");
    add({ repo: "hono", type: "one", entry: false, prompt: "Which top-level folder of src/ is imported by the most other top-level folders (root files count as one importer)? Answer with the folder name.", expected: [hMost], derivedBy: "distinct importing top-level folders per target folder" });
    add({ repo: "hono", type: "number", entry: false, prompt: "How many files does the middleware/ folder have (test files not counted)?", expected: hono.files.filter((f) => f.startsWith("middleware/")).length, derivedBy: "non-test files under middleware/" });
    const utilsImp = count(hono.edges.filter((e) => e.to.startsWith("utils/") && topOf(e.from) !== "utils"), (e) => topOf(e.from));
    const [uTop] = uniqueMax([...utilsImp], "hono utils importers");
    add({ repo: "hono", type: "one", entry: false, prompt: "Which top-level folder imports utils/ the most (number of import statements)? Answer with the folder name.", expected: [uTop], derivedBy: "import statements from each other top-level folder into utils/" });
    const quick = [...new Set(hono.edges.filter((e) => e.from === "preset/quick.ts" && e.to.startsWith("router/")).map((e) => e.to.split("/").slice(0, 2).join("/")))].sort();
    add({ repo: "hono", type: "set", entry: false, prompt: "Which router implementation folders (under router/) does preset/quick.ts import? List them.", expected: quick, derivedBy: "raw edges from preset/quick.ts into router/<name>/" });
    const ah = hono.edges.filter((e) => topOf(e.from) === "adapter" && topOf(e.to) === "helper").length;
    const ha = hono.edges.filter((e) => topOf(e.from) === "helper" && topOf(e.to) === "adapter").length;
    if (!(ah > 0 && ha === 0)) throw new Error(`hono: adapter/helper direction is not one-way (${ah}/${ha})`);
    add({ repo: "hono", type: "one", entry: false, prompt: "Between adapter/ and helper/, one imports the other and not the reverse. Which one is the importer? Answer with the folder name.", expected: ["adapter"], derivedBy: "raw edge counts adapter->helper vs helper->adapter" });
    const vroot = [...new Set(hono.edges.filter((e) => topOf(e.from) === "validator" && !e.to.includes("/")).map((e) => e.to))];
    if (vroot.length !== 1) throw new Error(`hono: validator/ imports ${vroot.length} root files`);
    add({ repo: "hono", type: "one", entry: false, prompt: "Which file that sits directly in src/ (not in a subfolder) does validator/ import?", expected: vroot, derivedBy: "raw edges from validator/ to root-level files" });

    return {
      schema: 1,
      note: "Expected answers are derived from the RawGraph (extract --format json) by `node scripts/extract-eval.mjs derive`; counting convention: value imports only, test files ignored.",
      bar: { pass: 12, total: q.length, entryAllAgents: true },
      sources: {
        self: { path: "src", commit: srcs.self.rev, srcTree: srcs.self.tree, files: self.files.length },
        hono: { repo: "honojs/hono", tag: srcs.hono.tag, commit: srcs.hono.rev, path: "src", files: hono.files.length },
      },
      questions: q,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- packets ----------------------------------------------------------------------------------

/** Deterministic per-agent question order (rotation) so the agents do not all see the same sequence. */
export const orderFor = (qs, agent) => qs.map((_, i) => qs[(i + agent * 5) % qs.length]);

const fence = (lang, body) => "```" + lang + "\n" + body.trimEnd() + "\n```";

export function renderPacket(qf, repoViews, agent, total) {
  const sections = repoViews
    .map(({ key, title, views }) => {
      const parts = views.map(
        (v) => `### ${key}: ${v.label}\n\nCommand: \`${v.command}\`\n\nOutput of the command:\n\n${fence("", v.toon)}\n\n\`imports.exd\`:\n\n${fence("", v.exd)}\n\n\`imports.exd.map.json\` (trimmed: no line evidence):\n\n${fence("json", v.sidecar)}`,
      );
      return `## Repo \`${key}\`: ${title}\n\n${parts.join("\n\n")}`;
    })
    .join("\n\n");
  const qs = orderFor(qf.questions, agent - 1)
    .map((q) => `### ${q.id} (repo ${q.repo})\n${q.prompt}`)
    .join("\n\n");
  return `# diagram-axi extract eval, packet ${agent} of ${total}

You are a coding agent who has just run \`diagram-axi extract\` on two codebases. You have no tools: you cannot run commands or read
files. Answer the questions using only the material below (TOON summaries, .exd diagram sources and sidecar maps).

## How to read the material

- An .exd line \`A -> B\` means the code in A imports B. \`x7\` = 7 import statements. \`-->\` = dynamic import, \`<->\` = both ways.
- A box is a file, or a folder collapsed to \`name/ (N files)\`. A \`group\` is a folder shown open, its boxes inside. Ids are in the sidecar:
  \`imports.exd.map.json\` maps each box id to its real path, kind and file count.
- \`:yellow\` + a one-line note \`used by N\`: a hub that many files import; its incoming arrows are not drawn on purpose and are listed in the
  sidecar under \`hubEdges\` (box to box, with counts). \`, K uses hidden\` after it: K of the hub's outgoing arrows are not drawn (only the
  heaviest are). \`:red\`: member of an import cycle. \`:green\`: the entry point (note \`entry\`) or the \`--focus\` file (note \`focus\`); on a
  collapsed folder the note names the file inside (\`entry: node.ts\`). A \`... +k more\` stub is joined to its box by a plain line (no arrowhead).
- Counting convention for every question: value imports only (type-only imports are ignored), test files are ignored. Paths are relative to
  the scanned folder (\`src\`).

${sections}

## Questions

${qs}

## Answer format

Reply with exactly one line per question and nothing else, in this form (any order):

${fence("", "q01 | <answer>")}

- file or folder: the path or folder name only (for example \`index.ts\` or \`router\`).
- number: digits only.
- list: items separated by \`;\` (for example \`a/x.ts; b/y.ts\`).
`;
}

export async function emit(outDir) {
  const qf = loadQuestions();
  const srcs = await repoSources();
  const tmp = join(outDir, "_work");
  mkdirSync(tmp, { recursive: true });
  const repoViews = [];
  for (const key of ["self", "hono"]) {
    const s = srcs[key];
    const views = ["default", "focus"].map((kind) => {
      const dir = join(tmp, key);
      mkdirSync(dir, { recursive: true });
      const v = view(s, kind, dir);
      return { label: kind === "focus" ? `focus on ${s.focus.replace(/^src\//, "")}, depth 2` : "default view", command: `diagram-axi extract ${s.scan}${kind === "focus" ? ` --focus ${s.focus} --depth 2` : ""}`, toon: v.toon, exd: v.exd, sidecar: trimSidecar(v.map) };
    });
    repoViews.push({ key, title: s.title, views });
  }
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (let a = 1; a <= AGENTS; a++) {
    const name = `packet-${String(a).padStart(2, "0")}.md`;
    const text = renderPacket(qf, repoViews, a, AGENTS);
    writeFileSync(join(outDir, name), text);
    files.push({ file: name, bytes: Buffer.byteLength(text) });
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ sources: qf.sources, packets: files.map((f) => f.file), order: Array.from({ length: AGENTS }, (_, a) => orderFor(qf.questions, a).map((q) => q.id)) }, null, 2) + "\n");
  return files;
}

// ---- CLI --------------------------------------------------------------------------------------

const USAGE = `usage: node scripts/extract-eval.mjs emit [--out <dir>]
       node scripts/extract-eval.mjs score <answers-dir>
       node scripts/extract-eval.mjs derive [--write | --check]`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "emit") {
    const i = rest.indexOf("--out");
    const outDir = resolve(i >= 0 && rest[i + 1] ? rest[i + 1] : join(ROOT, "out", "extract-eval"));
    if (!existsSync(join(ROOT, "dist", "index.js"))) {
      console.log("error: dist/ not found; run npm run build first");
      return 2;
    }
    const files = await emit(outDir);
    console.log(`packets[${files.length}]{file,bytes}:`);
    for (const f of files) console.log(`  ${f.file},${f.bytes}`);
    console.log(`out: ${outDir}`);
    console.log(`next: run one tool-less subagent per packet; save each reply as answers-NN.md in that folder, then: node scripts/extract-eval.mjs score ${outDir}`);
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
    const { files, agents } = readAnswers(dir);
    if (files.length === 0) {
      console.log(`error: no answers-NN.md files in ${dir}`);
      return 2;
    }
    const qf = loadQuestions();
    const report = formatReport(qf, agents.map((a) => scoreAgent(qf, a)));
    console.log(`answers: ${files.join(", ")}`);
    console.log(report.text);
    return report.ok ? 0 : 1;
  }
  if (cmd === "derive") {
    const fresh = await derive();
    if (rest.includes("--write")) {
      writeFileSync(QUESTIONS_PATH, JSON.stringify(fresh, null, 2) + "\n");
      console.log(`wrote ${QUESTIONS_PATH} (${fresh.questions.length} questions)`);
      return 0;
    }
    if (rest.includes("--check")) {
      const cur = loadQuestions();
      const same = JSON.stringify(cur.questions.map((q) => [q.id, q.type, q.expected])) === JSON.stringify(fresh.questions.map((q) => [q.id, q.type, q.expected]));
      console.log(same ? "questions.json matches the raw graphs" : "questions.json differs from the raw graphs (source changed?)");
      return same ? 0 : 1;
    }
    console.log(JSON.stringify(fresh, null, 2));
    return 0;
  }
  console.log(`error: ${cmd ? `unknown command '${cmd}'` : "missing command"}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((c) => (process.exitCode = c));
}
