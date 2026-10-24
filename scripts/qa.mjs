#!/usr/bin/env node
// Production QA harness: draws every test/qa/corpus/*.exd (curated) and test/qa/fuzz-corpus/*.exd (shrunk fuzz
// repros, reported as a separate suite) in all four directions with the BUILT cli (run `npm run build` first),
// analyses each produced .excalidraw geometrically (scripts/qa/analyze.mjs) and reports HARD defects (exit 1)
// and SOFT signals. Shared machinery lives in scripts/qa/run.mjs.
//
//   node scripts/qa.mjs [--engine excalidraw|d2|mermaid] [--layout <l>] [--png] [--only <substr>]
//                       [--dirs DOWN,RIGHT,UP,LEFT] [--out out/qa] [--jobs 4]
//
// --engine d2|mermaid (U8): the same .exd corpora are drawn through `draw --engine <e> --svg --geometry-json`, the
// engine's neutral geometry becomes a scene (dist/engines/neutral.js toScene) and the SAME checker runs on it,
// minus the rules the engine reports as not applicable (rules_skipped, listed in the report, never silently
// passed). A third suite `native-<e>` renders test/qa/native/*.d2 (d2) or *.mmd (mermaid): sequence, class, ERD,
// state, timeline, gitGraph and mindmap sources that have no graph geometry; it is a render-success plus
// overlap/bounds suite (the engine's rule mask drops the graph-only rules for those kinds), one render per file
// (dir NATIVE). --layout is passed through (d2 dagre|elk|tala, mermaid dagre|elk; default is the engine's own: elk).
// The default output folder becomes out/qa-<engine>. The excalidraw engine path is unchanged and its report keeps
// its exact shape (regression guard: out/qa/report.json is byte-identical to the previous baseline apart from the
// `stdout` text of each case).
//
// stdout: TOON summary (overall pass rate plus suites[]). out/qa/report.json: every finding (case, dir, code,
// elements, detail) plus per-case results and suites[]. Deterministic: no timestamps, sorted cases, findings
// sorted within a case.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_DIRS, ROOT, buildReport, checkDirs, drawCase, groupRates, pool, prepareOut, ratesTable, suitesFor, summarize, toonBlocks, writeReport } from "./qa/run.mjs";
import { DEFAULT_ENGINE, checkEngineArgs, isEngine } from "./qa/engines.mjs";

const FLAGS_HELP = "--engine <excalidraw|d2|mermaid> --layout <l> --png --only <substr> --dirs <list> --out <dir> --jobs <n>";
const die = (msg, suggestion) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(2);
};

// ---- args ----
function parseArgs(argv) {
  const o = { engine: DEFAULT_ENGINE, layout: undefined, png: false, only: undefined, dirs: ALL_DIRS, out: undefined, jobs: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--png") o.png = true;
    else if (a === "--engine") o.engine = String(argv[++i]);
    else if (a === "--layout") o.layout = String(argv[++i]);
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--dirs") o.dirs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--jobs") o.jobs = Math.max(1, Number(argv[++i]) || 1);
    else die(`unknown flag ${a}`, `valid flags: ${FLAGS_HELP}`);
  }
  const bad = checkEngineArgs(o.engine, o.layout);
  if (bad) die(bad.msg, bad.suggestion);
  o.out ??= isEngine(o.engine) ? `out/qa-${o.engine}` : "out/qa";
  checkDirs(o.dirs);
  return o;
}

// ---- main ----
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { outDir, rel } = prepareOut(o.out);
  const suites = suitesFor(o.engine);

  // Suites in fixed order, files sorted within each: the curated-corpus part of every output stays unchanged.
  const files = suites.flatMap(({ suite, dir, ext = ".exd", native = false }) => {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs)
      .filter((f) => f.endsWith(ext) && (!o.only || f.includes(o.only)))
      .sort()
      .map((f) => ({ suite, native, name: f.slice(0, -ext.length), file: join(abs, f) }));
  });
  // Native sources carry their own direction: one render each, reported with dir NATIVE.
  const cases = files.flatMap((f) => (f.native ? [{ name: f.name, dir: "NATIVE", file: f.file, group: f.suite, native: true }] : o.dirs.map((dir) => ({ name: f.name, dir, file: f.file, group: f.suite }))));
  const results = await pool(cases, o.jobs, (c) => drawCase(c, { outDir, png: o.png, engine: o.engine, layout: o.layout }));

  const sum = summarize(results);
  const rates = groupRates(results, "group");
  const suiteRows = suites.map(({ suite }) => rates.find((g) => g.key === suite) ?? { key: suite, renders: 0, passed: 0, passRate: 100, pct: "100.0", topCode: "" });
  const report = buildReport({
    results,
    sum,
    files: files.length,
    png: o.png,
    extra: { suites: suiteRows.map((g) => ({ suite: g.key, renders: g.renders, passed: g.passed, passRate: g.passRate })) },
    engine: o.engine,
    layout: o.layout,
  });
  writeReport(outDir, report);

  const lines = [
    `qa: ${sum.hard.length ? "fail" : "pass"}`,
    ...(isEngine(o.engine) ? [`engine: ${o.engine}${o.layout ? ` (layout ${o.layout})` : ""}`] : []),
    `files: ${files.length}`,
    `renders: ${results.length}${o.png ? " (with png)" : ""}`,
    `hard: ${sum.hard.length}`,
    `soft: ${sum.soft.length}`,
    `pass_rate: ${sum.pct}% (${sum.passed}/${results.length})`,
    `report: ${rel}/report.json`,
    ratesTable("suites", "suite", suiteRows),
    ...toonBlocks(sum, results),
    "help[2]:",
    `  node scripts/qa.mjs${isEngine(o.engine) ? ` --engine ${o.engine}` : ""} --only <name> --dirs DOWN   rerun one case`,
    `  see ${rel}/report.json for element ids and details`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(sum.hard.length ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write(`error: qa harness crashed: ${err.stack ?? err}\n`);
  process.exit(2);
});
