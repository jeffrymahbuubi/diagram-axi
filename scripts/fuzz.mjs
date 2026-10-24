#!/usr/bin/env node
// Seeded fuzzer: generates random-but-valid .exd diagrams (scripts/qa/gen.mjs, profiles in scripts/qa/profiles.mjs),
// draws each one in every direction with the BUILT cli (run `npm run build` first), analyses the scene geometrically
// (scripts/qa/analyze.mjs) and reports HARD defects. Shared machinery lives in scripts/qa/run.mjs.
//
//   node scripts/fuzz.mjs [--seed <n|random>] [--count <n>] [--profile <list|all>] [--dirs DOWN,RIGHT,UP,LEFT]
//        [--jobs <n>] [--out out/fuzz] [--png] [--keep-passing] [--case <profile/seed|seed>] [--emit-only]
//        [--bar 90] [--profile-bar <bar>] [--rtl] [--gate-all] [--shrink] [--promote] [--promote-max <n>]
//        [--engine excalidraw|d2|mermaid] [--layout <l>]
//
// --engine d2|mermaid (U8): every generated .exd is drawn through `draw --engine <e> --svg --geometry-json`; the
// engine's neutral geometry becomes a scene (dist/engines/neutral.js toScene) and the SAME checker and the SAME bar
// run on it, minus the rules the engine reports as not applicable (rules_skipped, listed per case and in the
// report, never silently passed). --layout is passed through (d2 dagre|elk|tala, mermaid dagre|elk; default elk).
// Default output: out/fuzz-<engine>-s<seed>/ (report.json keeps the excalidraw schema plus engine, layout,
// rules_skipped and per case kind / rules_skipped / geometry). --shrink / --promote are excalidraw-only: the shrunk
// repros land in the shared test/qa/fuzz-corpus, which is a layout corpus of the excalidraw engine.
//
// Held-out protocol (R9): seeds 1 and 2 are DEVELOPMENT seeds, the only ones fixes may be developed or tuned
// against (translator choices, ELK spacing, layout flags, thresholds). Seeds 3 and 4 are HELD-OUT: they are measured
// once, after the fixes are frozen, to report the pass rate (count 60 per profile is the acceptance run), and are
// never used to choose a change. A failure found on a held-out seed is reported, not fixed against; if it is
// worth fixing, reproduce it on a development seed (or a promoted repro) first. Do not rerun held-out seeds in a
// fix loop.
//
// Gating (user decision): `dense` and `stress-60` (and `unicode-rtl`, which needs --rtl) are report-only: they are
// printed and written to report.json with gated:false but excluded from the gated pass rate until --gate-all.
// Exit 0 = gated overall and every gated profile at or above its bar and no cli-failure; 1 = below bar or a
// cli-failure (parser / crash, always critical); 2 = usage error, missing build or a generator bug (gen-invalid).
// --shrink shrinks failing cases (scripts/qa/shrink.mjs) into out/fuzz/shrunk/ without touching the repo; --promote also
// writes up to --promote-max (default 10) new, signature-distinct repros to test/qa/fuzz-corpus/ (scripts/promote.mjs).
// Neither changes the exit code.
//
// Output: out/fuzz/<profile>/<seed>-<DIR>.{exd,excalidraw[,png]} (passing renders are deleted unless --keep-passing),
// out/fuzz/report.json (qa.mjs shape + profiles[] + per case {profile, seed, meta}), out/fuzz/failures.toon.
// Case ids are `<profile>/<seed>`: rerun one with `--case <profile>/<seed>`. Deterministic: no timestamps on stdout.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generate } from "./qa/gen.mjs";
import { hash32 } from "./qa/prng.mjs";
import { DEFAULT_COUNT, DEFAULT_PROFILES, PROFILES, PROFILE_ORDER } from "./qa/profiles.mjs";
import { promote } from "./promote.mjs";
import { DEFAULT_ENGINE, checkEngineArgs, isEngine } from "./qa/engines.mjs";
import { ALL_DIRS, ROOT, buildReport, checkDirs, drawCase, failingRows, groupRates, hasHard, pool, prepareOut, ratesTable, summarize, table, toonBlocks, writeReport } from "./qa/run.mjs";

const FLAGS_HELP = "--seed <n|random> --count <n> --profile <list|all> --dirs <list> --jobs <n> --out <dir> --png --keep-passing --case <profile/seed> --emit-only --bar <n> --profile-bar <n> --rtl --gate-all --shrink --promote --promote-max <n> --engine <excalidraw|d2|mermaid> --layout <l>";
const die = (msg, suggestion) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(2);
};

// ---- args ----
function parseArgs(argv) {
  const o = { seed: 1, count: DEFAULT_COUNT, profile: "all", dirs: ALL_DIRS, jobs: Math.min(8, availableParallelism()), out: undefined, engine: DEFAULT_ENGINE, layout: undefined, png: false, keepPassing: false, case: undefined, emitOnly: false, bar: 90, profileBar: undefined, rtl: false, gateAll: false, shrink: false, promote: false, promoteMax: 10 };
  const num = (flag, v) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : die(`${flag} needs a number (got ${v})`, `valid flags: ${FLAGS_HELP}`));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") {
      const v = argv[++i];
      o.seed = v === "random" ? "random" : num(a, v) >>> 0;
    } else if (a === "--count") o.count = Math.max(1, Math.floor(num(a, argv[++i])));
    else if (a === "--profile") o.profile = String(argv[++i]);
    else if (a === "--dirs") o.dirs = String(argv[++i]).toUpperCase().split(",");
    else if (a === "--jobs") o.jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--engine") o.engine = String(argv[++i]);
    else if (a === "--layout") o.layout = String(argv[++i]);
    else if (a === "--png") o.png = true;
    else if (a === "--keep-passing") o.keepPassing = true;
    else if (a === "--case") o.case = String(argv[++i]);
    else if (a === "--emit-only") o.emitOnly = true;
    else if (a === "--bar") o.bar = num(a, argv[++i]);
    else if (a === "--profile-bar") o.profileBar = num(a, argv[++i]);
    else if (a === "--rtl") o.rtl = true;
    else if (a === "--gate-all") o.gateAll = true;
    else if (a === "--shrink") o.shrink = true;
    else if (a === "--promote") o.promote = o.shrink = true;
    else if (a === "--promote-max") o.promoteMax = Math.max(1, Math.floor(num(a, argv[++i])));
    else die(`unknown flag ${a}`, `valid flags: ${FLAGS_HELP}`);
  }
  o.profileBar ??= o.bar;
  const bad = checkEngineArgs(o.engine, o.layout);
  if (bad) die(bad.msg, bad.suggestion);
  if (isEngine(o.engine) && o.shrink) die(`--shrink and --promote are excalidraw-only (got --engine ${o.engine})`, "shrunk repros go to the shared layout corpus test/qa/fuzz-corpus; rerun a failing case with --case <profile>/<seed> instead");
  o.dirsGiven = argv.includes("--dirs");
  checkDirs(o.dirs);
  return o;
}

/** `--case profile/seed[-DIR]` or a bare seed: returns {profile?, seed, dir?}. */
function parseCase(v) {
  const m = /^(?:([a-z][a-z0-9-]*)\/)?(\d+)(?:-(DOWN|RIGHT|UP|LEFT))?$/.exec(v);
  if (!m) die(`bad --case '${v}'`, "use <profile>/<seed> (as printed in failing[]) or a bare numeric seed");
  return { profile: m[1], seed: Number(m[2]) >>> 0, dir: m[3] };
}

function selectProfiles(o, only) {
  const names = only ? [only] : o.profile === "all" ? (o.rtl ? PROFILE_ORDER : DEFAULT_PROFILES) : o.profile.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of names) {
    if (!PROFILES[p]) die(`unknown profile ${p}`, `use any of ${PROFILE_ORDER.join(",")} or all`);
    if (PROFILES[p].rtlOnly && !o.rtl) die(`profile ${p} needs --rtl`, "RTL / combining-mark labels run only behind --rtl");
  }
  return names;
}

const header = (c, o, dir) => `# fuzz case: ${c.profile}/${c.seed}${dir ? ` dir=${dir}` : ""} run-seed=${o.runSeed} index=${c.index}\n${dir ? `dir ${dir}\n` : ""}`;

// ---- main ----
async function main() {
  const t0 = Date.now();
  const o = parseArgs(process.argv.slice(2));
  const forced = o.case ? parseCase(o.case) : undefined;
  if (forced?.dir && !o.dirsGiven) o.dirs = [forced.dir];
  if (forced?.profile && o.profile === "all") o.profile = forced.profile;
  o.runSeed = o.seed === "random" ? Math.floor(Math.random() * 2 ** 32) : o.seed;
  if (o.seed === "random") process.stderr.write(`seed: ${o.runSeed}\n`);
  const profiles = selectProfiles(o);
  const defaultOut = isEngine(o.engine) ? `out/fuzz-${o.engine}-s${o.runSeed}` : "out/fuzz";
  const { outDir, rel } = prepareOut(o.out ?? defaultOut, defaultOut);
  const { parse } = await import(pathToFileURL(join(ROOT, "dist", "dsl", "parser.js")).href);

  // 1. generate and validate (a parse error is a generator bug: exit 2, never blamed on layout)
  const cases = [];
  const invalid = [];
  for (const profile of profiles) {
    const count = forced ? 1 : o.count;
    for (let index = 0; index < count; index++) {
      const seed = forced ? forced.seed : hash32(o.runSeed, index);
      const g = generate(seed, profile, { rtl: PROFILES[profile].rtl });
      const bad = parse(g.text).diagnostics.find((d) => d.severity === "error");
      if (bad) invalid.push(`${profile}/${seed}: line ${bad.line}: ${bad.message}`);
      cases.push({ profile, seed, index, text: g.text, meta: g.meta });
    }
  }
  if (invalid.length) {
    process.stdout.write(`fuzz: gen-invalid\ninvalid: ${invalid.length}\n${invalid.slice(0, 10).map((s) => `  ${s}`).join("\n")}\nsuggestion: generator bug, fix scripts/qa/gen.mjs (reproduce with --case <profile>/<seed> --emit-only)\n`);
    process.exit(2);
  }

  // 2. emit-only: write the .exd files and stop
  if (o.emitOnly) {
    for (const c of cases) {
      const file = join(outDir, c.profile, `${c.seed}.exd`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, header(c, o) + c.text);
    }
    const rows = profiles.map((p) => ({ profile: p, cases: cases.filter((c) => c.profile === p).length, dir: `${rel}/${p}` }));
    process.stdout.write([`fuzz: emitted`, `seed: ${o.runSeed}`, `cases: ${cases.length}`, table("profiles", rows, ["profile", "cases", "dir"])].join("\n") + "\n");
    return process.exit(0);
  }

  // 3. draw every (case, direction) pair
  const renders = cases.flatMap((c) => o.dirs.map((dir) => ({ c, dir })));
  const results = await pool(renders, o.jobs, async ({ c, dir }) => {
    const base = join(outDir, c.profile, `${c.seed}-${dir}`);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.exd`, header(c, o, dir) + c.text);
    const r = await drawCase({ name: `${c.profile}/${c.seed}`, dir, text: c.text, base, group: c.profile }, { outDir, png: o.png, engine: o.engine, layout: o.layout });
    Object.assign(r, { profile: c.profile, seed: c.seed, meta: c.meta, file: `${rel}/${c.profile}/${c.seed}-${dir}.exd` });
    if (!hasHard(r) && !o.keepPassing) for (const ext of ["exd", "excalidraw", "png", "svg", "d2", "mmd", "geometry.json"]) rmSync(`${base}.${ext}`, { force: true });
    return r;
  });
  rmSync(join(outDir, "_src"), { recursive: true, force: true });

  // 4. numbers: all profiles and gated only
  const gatedOf = (p) => PROFILES[p].gated || (o.gateAll && !PROFILES[p].rtlOnly);
  const sum = summarize(results);
  const gatedResults = results.filter((r) => gatedOf(r.profile));
  const gsum = summarize(gatedResults);
  const rates = groupRates(results, "group").map((g) => ({ ...g, gated: gatedOf(g.key) }));
  const cliFailures = sum.flat.filter((f) => f.code === "cli-failure");
  const reportOnly = profiles.filter((p) => !gatedOf(p));
  const lowProfiles = rates.filter((g) => g.gated && g.passRate < o.profileBar);
  const ok = Number(gsum.pct) >= o.bar && !lowProfiles.length && !cliFailures.length;

  // 5. report
  const examples = Object.fromEntries(sum.byCode.map((b) => [b.code, [...new Set(sum.flat.filter((f) => f.code === b.code).map((f) => `${f.case}-${f.dir}`))].slice(0, 5)]));
  const report = buildReport({
    results,
    sum,
    files: cases.length,
    png: o.png,
    summaryExtra: { seed: o.runSeed, countPerProfile: forced ? 1 : o.count, bar: o.bar, profileBar: o.profileBar, gatedRenders: gatedResults.length, gatedPassed: gsum.passed, gatedPassRate: Number(gsum.pct), cliFailures: cliFailures.length, reportOnly },
    extra: {
      profiles: rates.map((g) => ({ profile: g.key, renders: g.renders, passed: g.passed, passRate: g.passRate, topCode: g.topCode, gated: g.gated })),
      examples,
    },
    caseExtra: (r) => ({ profile: r.profile, seed: r.seed, meta: r.meta }),
    engine: o.engine,
    layout: o.layout,
  });
  writeReport(outDir, report);
  const fails = failingRows(results).map((f) => ({ ...f, file: results.find((r) => r.case === f.case && r.dir === f.dir).file }));
  writeFileSync(join(outDir, "failures.toon"), (fails.length ? table("failing", fails, ["case", "dir", "hard", "codes", "file"]) : "failing[0]:") + "\n");

  const lines = [
    `fuzz: ${ok ? "pass" : "fail"}`,
    ...(isEngine(o.engine) ? [`engine: ${o.engine}${o.layout ? ` (layout ${o.layout})` : ""}`] : []),
    `seed: ${o.runSeed}`,
    `renders: ${results.length}${o.png ? " (with png)" : ""}`,
    `hard: ${sum.hard.length}`,
    `pass_rate: ${gsum.pct}% (${gsum.passed}/${gatedResults.length}) gated, bar ${o.bar}%`,
    `pass_rate_all: ${sum.pct}% (${sum.passed}/${results.length}) all profiles`,
    `report_only: ${reportOnly.join(",") || "none"}`,
    `cli_failures: ${cliFailures.length}`,
    `report: ${rel}/report.json`,
    ratesTable("profiles", "profile", rates, ["top_code"]),
    ...toonBlocks(sum, results),
    ...(lowProfiles.length ? [`below_bar: ${lowProfiles.map((g) => `${g.key} ${g.pct}%`).join(", ")} (profile bar ${o.profileBar}%)`] : []),
    "help[3]:",
    `  node scripts/fuzz.mjs${isEngine(o.engine) ? ` --engine ${o.engine}` : ""} --case <profile>/<seed> --dirs DOWN   rerun one case (failing .exd kept under ${rel}/<profile>/)`,
    `  see ${rel}/report.json for element ids, details and examples per code; ${rel}/failures.toon for grep`,
    "  --gate-all counts report-only profiles too; --keep-passing keeps every render",
  ];
  if (o.shrink) {
    const res = await promote({ report, outDir, max: o.promoteMax, jobs: o.jobs, dryRun: !o.promote, runSeed: o.runSeed });
    lines.push(...res.lines);
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.stderr.write(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`error: fuzz harness crashed: ${err.stack ?? err}\n`);
  process.exit(2);
});
