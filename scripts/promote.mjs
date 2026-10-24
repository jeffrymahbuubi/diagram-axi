#!/usr/bin/env node
// Shrink fuzz failures and promote the minimal repros into test/qa/fuzz-corpus/ (run `npm run build` first).
//
//   node scripts/promote.mjs [--report out/fuzz/report.json] [--promote-max 10] [--include-planned] [--dry-run]
//        [--jobs <n>] [--budget <n>]
//   node scripts/promote.mjs <repro.exd> [--dir DOWN] [--code <code>] [--dry-run]
//
// From a fuzz report: failing cases are grouped by failure (code; cli-failure also by message), cli-failure first, then
// HARD codes by frequency; candidates are taken round-robin across the groups (smallest case of each group first),
// shrunk (scripts/qa/shrink.mjs) and kept when their structural signature (scripts/qa/signature.mjs) is new: not
// the signature of any file in test/qa/corpus or test/qa/fuzz-corpus, and not one already promoted in this run.
// At most --promote-max files are written as test/qa/fuzz-corpus/fuzz-<code>-<hash8>.exd; every distinct shrunk repro
// is also left in <report dir>/shrunk/ for review. --dry-run shrinks and reports but writes nothing to the corpus.
// Also callable as promote({...}) from scripts/fuzz.mjs (--shrink = dry run, --promote = for real).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { RULES } from "./qa/analyze.mjs";
import { generate } from "./qa/gen.mjs";
import { PROFILES } from "./qa/profiles.mjs";
import { ALL_DIRS, ROOT, pool, requireBuild, table } from "./qa/run.mjs";
import { DEFAULT_BUDGET, shrinkCase, sizeOf } from "./qa/shrink.mjs";
import { corpusHashes, failureKey, modelHash } from "./qa/signature.mjs";

export const CORPUS_DIRS = [join(ROOT, "test", "qa", "corpus"), join(ROOT, "test", "qa", "fuzz-corpus")];
export const FUZZ_CORPUS = join(ROOT, "test", "qa", "fuzz-corpus");

/** One-line description of what a minimal model contains. */
export function describeModel(m) {
  const pairs = new Map();
  for (const e of m.edges) {
    const k = e.from === e.to ? `${e.from}*` : [e.from, e.to].sort().join("|");
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const parts = [];
  const maxPar = Math.max(0, ...[...pairs].filter(([k]) => !k.endsWith("*")).map(([, n]) => n));
  if (maxPar >= 2) parts.push(`${maxPar} edges on one node pair`);
  const loops = m.edges.filter((e) => e.from === e.to).length;
  if (loops) parts.push(`${loops} self-loop${loops > 1 ? "s" : ""}`);
  if (m.edges.some((e) => m.edges.some((f) => f.from === e.to && f.to === e.from && e.from !== e.to))) parts.push("opposing edges");
  const shapes = [...new Set(m.nodes.map((n) => n.shape).filter((s) => s !== "rect"))];
  if (shapes.length) parts.push(shapes.join("+"));
  const labeled = m.edges.filter((e) => e.label).length;
  if (labeled) parts.push(`${labeled} edge label${labeled > 1 ? "s" : ""}`);
  if (m.groups.length) parts.push(`${m.groups.length} zone${m.groups.length > 1 ? "s" : ""}`);
  if (m.title) parts.push("title");
  return `${m.nodes.length} nodes, ${m.edges.length} edges${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

function baseCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const fileBody = (r, c, runSeed, base) =>
  `# Fuzz repro (auto-promoted): ${r.code} in ${r.dir}; profile ${c.profile ?? "-"}, seed ${c.seed ?? "-"}, run seed ${runSeed ?? "-"}, base ${base}.\n` +
  `# Minimal: ${r.model.nodes.length} nodes, ${r.model.edges.length} edges, ${r.model.groups.length} groups. signature ${r.signature}\n` +
  r.text;

/** Ordered candidates {case, profile, seed, dir, code, group} from a fuzz report (see file header for the order). */
export function candidatesFromReport(report, { includePlanned = false } = {}) {
  const info = new Map(report.cases.map((c) => [c.case, c]));
  const groups = new Map();
  for (const f of report.findings) {
    if (!(f.severity === "hard" || (includePlanned && RULES[f.code]?.[2] === "hard"))) continue;
    const c = info.get(f.case);
    if (!c?.profile || c.seed === undefined) continue;
    const key = failureKey(f);
    if (!groups.has(key)) groups.set(key, { key, code: f.code, renders: 0, cases: new Map() });
    const g = groups.get(key);
    g.renders++;
    const prev = g.cases.get(f.case);
    if (!prev || ALL_DIRS.indexOf(f.dir) < ALL_DIRS.indexOf(prev.dir)) g.cases.set(f.case, { case: f.case, profile: c.profile, seed: c.seed, dir: f.dir, code: f.code, size: (c.meta?.nodes ?? 0) + (c.meta?.edges ?? 0), group: key });
  }
  const ordered = [...groups.values()].sort((a, b) => (a.code === "cli-failure") !== (b.code === "cli-failure") ? (a.code === "cli-failure" ? -1 : 1) : b.renders - a.renders || a.key.localeCompare(b.key));
  const lists = ordered.map((g) => [...g.cases.values()].sort((a, b) => a.size - b.size || a.case.localeCompare(b.case)));
  const out = [];
  for (let r = 0; lists.some((l) => r < l.length); r++) for (const l of lists) if (r < l.length) out.push(l[r]);
  return out;
}

/**
 * Shrink and promote. opts: {report | candidates, outDir (for shrunk/), max, jobs, includePlanned, dryRun, budget,
 * corpusDir, runSeed, log}. Returns {lines, promoted[], skipped[], shrunk[]}. `lines` is the TOON block to print.
 */
export async function promote(opts) {
  const { max = 10, jobs = 4, includePlanned = false, dryRun = false, budget = DEFAULT_BUDGET, corpusDir = FUZZ_CORPUS, runSeed, shrinkFn = shrinkCase } = opts;
  const candidates = opts.candidates ?? candidatesFromReport(opts.report, { includePlanned });
  const shrunkDir = join(opts.outDir, "shrunk");
  const seen = await corpusHashes([...CORPUS_DIRS.filter((d) => d !== FUZZ_CORPUS), corpusDir]);
  const base = baseCommit();
  const promoted = [];
  const skipped = [];
  const shrunk = [];
  const attemptsCap = Math.max(max, 1) * 3;
  let attempts = 0;
  const cell = (c) => c.case ?? c.file;

  while (candidates.length && attempts < attemptsCap && shrunk.length < max) {
    const batch = candidates.splice(0, Math.min(jobs, attemptsCap - attempts, max - shrunk.length));
    attempts += batch.length;
    const results = await pool(batch, jobs, (c) => {
      const input = c.text !== undefined ? { text: c.text } : { model: generate(c.seed, c.profile, { rtl: PROFILES[c.profile].rtl }).model };
      return shrinkFn({ ...input, dirs: c.dirs ?? [c.dir], code: c.code, includePlanned, budget });
    });
    batch.forEach((c, i) => {
      const r = results[i];
      if (!r.ok) return skipped.push({ case: cell(c), code: c.code ?? "", reason: r.reason });
      const hash = modelHash(r.model);
      const file = `fuzz-${r.code}-${hash}.exd`;
      if (seen.has(hash)) return skipped.push({ case: cell(c), code: r.code, reason: `signature ${r.signature} already covered by ${seen.get(hash)}` });
      seen.set(hash, file);
      const body = fileBody(r, c, runSeed, base);
      mkdirSync(shrunkDir, { recursive: true });
      writeFileSync(join(shrunkDir, file), body);
      shrunk.push({ file, code: r.code });
      const row = { file: relative(ROOT, join(corpusDir, file)).split("\\").join("/"), code: r.code, dir: r.dir, case: cell(c), size: sizeOf(r.to), from: sizeOf(r.from), calls: r.calls, description: describeModel(r.model) + (r.exhausted ? " [budget exhausted]" : "") };
      if (!dryRun) {
        mkdirSync(corpusDir, { recursive: true });
        writeFileSync(join(corpusDir, file), body);
      }
      promoted.push(dryRun ? { ...row, file: relative(ROOT, join(shrunkDir, file)).split("\\").join("/") } : row);
    });
  }
  const rest = candidates.length;
  const lines = [
    `promote: ${dryRun ? "dry run (shrunk only)" : "done"}`,
    `shrunk: ${shrunk.length} distinct of ${attempts} attempted, ${rest} candidate${rest === 1 ? "" : "s"} left untried (cap ${attemptsCap}, --promote-max ${max})`,
    promoted.length ? table(dryRun ? "shrunk_files" : "promoted", promoted, ["file", "code", "dir", "case", "from", "size", "calls", "description"]) : "promoted[0]:",
    ...(skipped.length ? [table("skipped", skipped, ["case", "code", "reason"])] : []),
    `review: ${relative(ROOT, shrunkDir).split("\\").join("/")}/`,
  ];
  return { lines, promoted, skipped, shrunk };
}

// ---- CLI ----
const FLAGS = "--report <file> --promote-max <n> --include-planned --dry-run --jobs <n> --budget <n> --dir <DIR> --code <code>";
const die = (msg, suggestion) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(2);
};

async function main() {
  const o = { input: undefined, report: "out/fuzz/report.json", max: 10, includePlanned: false, dryRun: false, jobs: Math.min(4, availableParallelism()), budget: DEFAULT_BUDGET, dir: undefined, code: undefined };
  const argv = process.argv.slice(2);
  const val = (i, f) => (argv[i] === undefined ? die(`${f} needs a value`, `valid flags: ${FLAGS}`) : argv[i]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") o.report = val(++i, a);
    else if (a === "--promote-max") o.max = Math.max(1, Math.floor(Number(val(++i, a)) || 10));
    else if (a === "--include-planned") o.includePlanned = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--jobs") o.jobs = Math.max(1, Number(val(++i, a)) || 1);
    else if (a === "--budget") o.budget = Math.max(1, Number(val(++i, a)) || DEFAULT_BUDGET);
    else if (a === "--dir") o.dir = val(++i, a).toUpperCase();
    else if (a === "--code") o.code = val(++i, a);
    else if (a.startsWith("--")) die(`unknown flag ${a}`, `valid flags: ${FLAGS}`);
    else o.input = a;
  }
  requireBuild();
  const common = { max: o.max, jobs: o.jobs, includePlanned: o.includePlanned, dryRun: o.dryRun, budget: o.budget };
  let res;
  if (o.input) {
    if (!existsSync(o.input)) die(`no such file ${o.input}`, "pass a repro .exd or use --report");
    const text = readFileSync(o.input, "utf8");
    const m = /^# fuzz case: ([a-z][a-z0-9-]*)\/(\d+)/m.exec(text);
    const c = { file: o.input, text, dirs: o.dir ? [o.dir] : ALL_DIRS, code: o.code, ...(m ? { profile: m[1], seed: m[2] } : {}) };
    res = await promote({ ...common, candidates: [c], outDir: resolve(ROOT, "out", "promote") });
  } else {
    if (!existsSync(o.report)) die(`report not found: ${o.report}`, "run node scripts/fuzz.mjs first, or pass --report <file>");
    res = await promote({ ...common, report: JSON.parse(readFileSync(o.report, "utf8")), outDir: dirname(resolve(ROOT, o.report)), runSeed: JSON.parse(readFileSync(o.report, "utf8")).summary?.seed });
  }
  process.stdout.write(res.lines.join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stdout.write(`error: promote crashed: ${err.stack ?? err}\n`);
    process.exit(2);
  });
}
