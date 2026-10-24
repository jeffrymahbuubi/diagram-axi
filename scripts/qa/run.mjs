// Shared QA runner: used by scripts/qa.mjs (corpus) and the fuzz / shrink tools.
// Everything here is deterministic and free of timestamps. ESM, no dependencies.
// Engine runs (o.engine = d2|mermaid, U8) read the geometry sidecar instead of a .excalidraw scene: ./engines.mjs.
//
//   draw       runDraw(args) -> {status, stdout, stderr}      spawn the BUILT cli
//   one case   drawCase(c, o) -> result                       draw + analyse one (source, direction) pair
//   parallel   pool(items, jobs, fn)                          bounded-concurrency map, order preserved
//   direction  applyDirection(text, dir) -> {text, rewritten} force a direction (the DSL's own dir line wins)
//   stats      summarize(results) / groupRates(results, key)  pass-rate maths, overall and per group
//   output     toon helpers, buildReport, writeReport

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES, analyzeScene } from "./analyze.mjs";
import { commonSkipped, engineArgs, isEngine, maskFindings, nativeSuite, readEngineGeometry, sceneOf, svgProblem } from "./engines.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = join(ROOT, "bin", "diagram-axi.js");
export const ALL_DIRS = ["DOWN", "RIGHT", "UP", "LEFT"];
export const DIR_LINE = /^([ \t]*)(?:dir|direction)\b[ \t]*:?[ \t]*[A-Za-z]+/m;

/** Corpus suites run by scripts/qa.mjs, in report order. `dir` is relative to the project root. */
export const SUITES = [
  { suite: "corpus", dir: join("test", "qa", "corpus") },
  { suite: "fuzz-corpus", dir: join("test", "qa", "fuzz-corpus") },
];

/** Suites for `scripts/qa.mjs --engine <e>`: the shared .exd corpora plus the engine's native sources. */
export const suitesFor = (engine) => (isEngine(engine) ? [...SUITES, nativeSuite(engine)] : SUITES);

// ---- TOON helpers (same quoting rules as src/output/toon.ts) ----
export const val = (v) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** `name[N]{f1,f2}:` header plus two-space indented rows. `total` adds the "N of M total" form. */
export const table = (name, rows, fields, total) =>
  [`${name}[${total !== undefined && total !== rows.length ? `${rows.length} of ${total} total` : rows.length}]{${fields.join(",")}}:`, ...rows.map((r) => "  " + fields.map((f) => val(r[f])).join(","))].join("\n");

// ---- running the cli ----
/** Spawn the built cli with `args` from the project root. Never rejects. */
export function runDraw(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => done({ status: -1, stdout, stderr: String(err) }));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

/** Map `items` through async `fn` with at most `jobs` in flight; results keep input order. */
export async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/** Force `dir` onto DSL text: rewrites an existing dir/direction line (which beats --direction). */
export function applyDirection(text, dir) {
  return DIR_LINE.test(text) ? { text: text.replace(DIR_LINE, `$1dir ${dir}`), rewritten: true } : { text, rewritten: false };
}

/**
 * Draw one render and analyse it.
 *   c = { name, dir, file?, text?, base?, group?, native? }   `file` or `text` is the .exd source (`native`: a .d2
 *       or .mmd file drawn as is, its direction is its own); `base` is the output path without extension (default
 *       <outDir>/<name>-<dir>); `group` is carried through for grouping.
 *   o = { outDir, png?, engine?, layout? }   engine d2|mermaid draws with `--engine <e> --svg --geometry-json` and
 *       analyses the sidecar's scene minus its rules_skipped; excalidraw (the default) is unchanged.
 * Returns { case, dir, group, exit, stdout, findings[], stats } (findings: {code, severity, elements, detail});
 * engine runs add { kind, rulesSkipped[], geometry }.
 */
export async function drawCase(c, o) {
  const eng = isEngine(o.engine) ? o.engine : undefined;
  const base = c.base ?? join(o.outDir, `${c.name}-${c.dir}`);
  const args = ["draw"];
  if (c.native) {
    args.push(c.file);
  } else {
    const src = c.text ?? readFileSync(c.file, "utf8");
    const forced = applyDirection(src, c.dir);
    if (forced.rewritten || c.file === undefined) {
      // Temp copy (line numbers preserved): the DSL's own dir line must be rewritten, or the text has no file yet.
      const copy = join(o.outDir, "_src", `${c.name}-${c.dir}.exd`);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, forced.text);
      args.push(copy);
      if (!forced.rewritten) args.push("--direction", c.dir);
    } else {
      args.push(c.file, "--direction", c.dir);
    }
  }
  if (eng) args.push(...engineArgs(eng, o.layout));
  args.push("--out", base, "--force");
  if (o.png) args.push("--png");
  const r = await runDraw(args);
  const result = { case: c.name, dir: c.dir, group: c.group, exit: r.status, stdout: r.stdout.trim().split("\n").slice(0, 4).join(" | "), findings: [], stats: null };
  const add = (code, detail, elements = []) => result.findings.push({ code, severity: RULES[code][0], elements, detail });

  if (r.status !== 0) {
    add("cli-failure", `exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n").slice(0, 2).join(" | ").slice(0, 300)}`);
    return result;
  }
  if (r.stderr.trim()) add("cli-stderr", r.stderr.trim().slice(0, 200));
  let scene;
  let geometry;
  try {
    if (eng) {
      const bad = svgProblem(base);
      if (bad) add("render-failure", bad);
      geometry = readEngineGeometry(base);
      scene = { elements: await sceneOf(geometry) };
      Object.assign(result, { kind: geometry.kind, rulesSkipped: [...geometry.rules_skipped].sort(), geometry: geometry.neutral ? "neutral" : "elements" });
    } else {
      scene = JSON.parse(readFileSync(`${base}.excalidraw`, "utf8"));
    }
    if (!Array.isArray(scene.elements)) throw new Error("no elements array");
  } catch (err) {
    add("cli-failure", `${eng ? "geometry" : "scene"} unreadable: ${err.message}`);
    return result;
  }
  if (o.png && !(existsSync(`${base}.png`) && statSync(`${base}.png`).size > 0)) add("render-failure", `${relative(ROOT, base)}.png missing or empty`);
  const a = analyzeScene(scene);
  result.stats = a.stats;
  result.findings.push(...(geometry ? maskFindings(a.findings, geometry.rules_skipped) : a.findings));
  return result;
}

// ---- pass-rate maths ----
export const hasHard = (r) => r.findings.some((f) => f.severity === "hard");
const pctOf = (passed, total) => (total ? ((passed / total) * 100).toFixed(1) : "100.0");

/**
 * Overall numbers for a result list: flat findings, hard/soft lists, failing renders, passed count,
 * pass rate as a one-decimal string `pct`, and `byCode` rows sorted hard-first, then count, then code.
 */
export function summarize(results) {
  const flat = results.flatMap((r) => r.findings.map((f) => ({ case: r.case, dir: r.dir, code: f.code, severity: f.severity, elements: f.elements, detail: f.detail })));
  const hard = flat.filter((f) => f.severity === "hard");
  const soft = flat.filter((f) => f.severity === "soft");
  const failing = results.filter(hasHard);
  const passed = results.length - failing.length;
  const codes = [...new Set(flat.map((f) => f.code))];
  const byCode = codes
    .map((code) => {
      const fs = flat.filter((f) => f.code === code);
      return { code, severity: RULES[code][0], count: fs.length, cases: new Set(fs.map((f) => `${f.case}-${f.dir}`)).size, example: `${fs[0].case}-${fs[0].dir}` };
    })
    .sort((a, b) => (a.severity === b.severity ? b.count - a.count || a.code.localeCompare(b.code) : a.severity === "hard" ? -1 : 1));
  return { flat, hard, soft, failing, passed, pct: pctOf(passed, results.length), byCode };
}

/**
 * Per-group pass rates. `key` is a property name or a function of a result (default: result.group).
 * Returns rows { key, renders, passed, passRate (number), pct (string), topCode } in first-seen order;
 * topCode = the HARD code hit by the most renders in that group ("" when nothing fails).
 */
export function groupRates(results, key = "group") {
  const keyOf = typeof key === "function" ? key : (r) => r[key];
  const groups = new Map();
  for (const r of results) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups].map(([k, rs]) => {
    const passed = rs.filter((r) => !hasHard(r)).length;
    const tally = new Map();
    for (const r of rs) for (const code of new Set(r.findings.filter((f) => f.severity === "hard").map((f) => f.code))) tally.set(code, (tally.get(code) ?? 0) + 1);
    const top = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const pct = pctOf(passed, rs.length);
    return { key: k, renders: rs.length, passed, passRate: Number(pct), pct, topCode: top ? top[0] : "" };
  });
}

// ---- report + TOON summary ----
/** Failing renders as rows {case, dir, hard, codes}, worst first. */
export function failingRows(results) {
  return results
    .filter(hasHard)
    .map((r) => {
      const h = r.findings.filter((f) => f.severity === "hard");
      return { case: r.case, dir: r.dir, hard: h.length, codes: [...new Set(h.map((f) => f.code))].join("+") };
    })
    .sort((a, b) => b.hard - a.hard || a.case.localeCompare(b.case) || a.dir.localeCompare(b.dir));
}

/** `by_code` and `failing` TOON blocks (empty array parts omitted), `limit` failing rows shown. */
export function toonBlocks(sum, results, limit = 25) {
  const out = [];
  if (sum.byCode.length) out.push(table("by_code", sum.byCode, ["code", "severity", "count", "cases", "example"]));
  const rows = failingRows(results);
  if (rows.length) out.push(table("failing", rows.slice(0, limit), ["case", "dir", "hard", "codes"], rows.length));
  return out;
}

/** `name[N]{<keyName>,renders,passed,pass_rate}:` block from groupRates rows (pass_rate printed with %). */
export function ratesTable(name, keyName, rates, extraFields = []) {
  const rows = rates.map((g) => ({ [keyName]: g.key, renders: g.renders, passed: g.passed, pass_rate: `${g.pct}%`, top_code: g.topCode }));
  return table(name, rows, [keyName, "renders", "passed", "pass_rate", ...extraFields]);
}

/**
 * report.json body. summary = {files, renders, png, hard, soft, passed, passRate, ...summaryExtra}.
 * `extra` keys land between byCode and cases (e.g. suites[], profiles[]); `caseExtra(r)` adds per-case fields.
 */
export function buildReport({ results, sum, files, png, summaryExtra = {}, extra = {}, caseExtra, engine, layout }) {
  // Engine runs (d2, mermaid) add engine, layout and rules_skipped; the excalidraw report keeps its exact shape.
  const eng = isEngine(engine);
  const withMask = results.filter((r) => r.rulesSkipped);
  const graphLists = (withMask.some((r) => r.kind === "graph") ? withMask.filter((r) => r.kind === "graph") : withMask).map((r) => r.rulesSkipped);
  return {
    summary: { files, renders: results.length, png, hard: sum.hard.length, soft: sum.soft.length, passed: sum.passed, passRate: Number(sum.pct), ...(eng ? { engine, ...(layout ? { layout } : {}) } : {}), ...summaryExtra },
    ...(eng ? { engine, ...(layout ? { layout } : {}), rules_skipped: commonSkipped(graphLists) } : {}),
    rules: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, { severity: v[0], definition: v[1] }])),
    byCode: sum.byCode.map(({ code, severity, count, cases: n }) => ({ code, severity, count, cases: n })),
    ...extra,
    cases: results.map((r) => ({
      case: r.case,
      dir: r.dir,
      exit: r.exit,
      stats: r.stats,
      hard: r.findings.filter((f) => f.severity === "hard").length,
      soft: r.findings.filter((f) => f.severity === "soft").length,
      stdout: r.stdout,
      ...(eng ? { kind: r.kind, rules_skipped: [...(r.rulesSkipped ?? [])].sort(), geometry: r.geometry } : {}),
      ...(caseExtra ? caseExtra(r) : {}),
    })),
    findings: sum.flat,
  };
}

export function writeReport(outDir, report) {
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

// ---- environment guards (exit 2 with a TOON error, like every qa tool) ----
const fail = (msg, suggestion) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(2);
};

/** Exit 2 unless the built cli exists. */
export function requireBuild() {
  if (!existsSync(join(ROOT, "dist", "index.js"))) fail("dist/ not found; the built cli is required", "run npm run build first");
}

/** Resolve `--out` inside the project, wipe and recreate it. Returns {outDir, rel} (rel uses `/`). */
export function prepareOut(out, defaultOut = "out/qa") {
  const outDir = resolve(ROOT, out);
  const rel = relative(ROOT, outDir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(`--out must be a folder inside the project (got ${out})`, `use the default ${defaultOut}`);
  requireBuild();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  return { outDir, rel: rel.split(sep).join("/") };
}

/** Exit 2 on unknown direction names. */
export function checkDirs(dirs) {
  const bad = dirs.filter((d) => !ALL_DIRS.includes(d));
  if (bad.length) fail(`unknown direction ${bad.join(",")}`, `use any of ${ALL_DIRS.join(",")}`);
}
