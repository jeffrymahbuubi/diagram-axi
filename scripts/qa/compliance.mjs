#!/usr/bin/env node
// Compliance evidence for the authoring rules (docs/plans/2026-10-23-authoring-rules-plan.md, section 4).
// "Compliant" = lint() (dist/lint/rules.js, the single source of truth) reports none of the COUNTED codes for the
// case's .exd text. Each fuzz case is regenerated with generate(seed, profile) and joined to the report's per-render
// findings: HARD renders, arrow-crossings counts, route-ratio and aspect-ratio.
//
//   node scripts/qa/compliance.mjs --report out/fuzz-s3/report.json,out/fuzz-s4/report.json [--out out/compliance]
//        [--fix [--count <n>] [--profile <list>] [--hard-only] [--jobs <n>]]
//
// Filter mode prints TOON and writes <out>/report.json. Exit 0 = the claim holds (compliant HARD rate <= 0.5 % and
// below the violating rate, compliant crossings lower); 1 = it fails; 2 = usage error / missing build.
// --fix applies the lints' own suggestions on the model (scripts/qa/fixes.mjs), redraws the violators in the report's
// directions and prints HARD / crossings before and after, per rule and for all fixers together.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXERS, UNFIXABLE, fixAll } from "./fixes.mjs";
import { emit, generate } from "./gen.mjs";
import { PROFILES } from "./profiles.mjs";
import { ROOT, drawCase, hasHard, pool, prepareOut, table } from "./run.mjs";

/** Lint codes that make an input non-compliant (implicit-node, a parser warning, never counts). */
export const COUNTED = ["parallel-edges", "busy-node", "diamond-hub", "dense-graph", "wordy-edge-label", "reciprocal-pair", "many-nodes", "too-many-nodes", "deep-nesting", "long-label", "cross-group-edges"];
export const HARD_BAR = 0.5; // percent: the plan's ceiling for the compliant HARD rate
const FLAGS_HELP = "--report <a.json[,b.json]> --out <dir> --fix --count <n> --profile <list> --hard-only --jobs <n>";

const die = (msg, suggestion = `valid flags: ${FLAGS_HELP}`) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(2);
};

// ---- numbers ----
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) : "0.00");
const mean = (xs) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1) : "0.0");
const crossingsOf = (findings) => Number(/^(\d+) crossing/.exec(findings.find((f) => f.code === "arrow-crossings")?.detail ?? "")?.[1] ?? 0);

/** Row stats for a render list. */
export function stats(rows) {
  const hard = rows.filter((r) => r.hard).length;
  return {
    renders: rows.length,
    hard,
    hard_rate: `${pct(hard, rows.length)}%`,
    avg_crossings: mean(rows.map((r) => r.crossings)),
    route_ratio_rate: `${pct(rows.filter((r) => r.routeRatio).length, rows.length)}%`,
    aspect_rate: `${pct(rows.filter((r) => r.aspect).length, rows.length)}%`,
  };
}

/**
 * The plan's section 0 candidate set (out/rules-evidence/ablate.mjs "none"): thresholds as measured, including two the
 * shipped lints do not have (edge label chars <= 24, group title <= 24). Reproduces the section 0 table, not the lint.
 */
export function candidateCompliant(model) {
  const pair = new Map();
  const deg = new Map();
  const dir = new Map();
  for (const e of model.edges) {
    const k = [e.from, e.to].sort().join("|");
    pair.set(k, (pair.get(k) ?? 0) + 1);
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    if (e.to !== e.from) deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    dir.set(`${e.from}>${e.to}`, e);
  }
  const recipSame = [...dir].some(([k, e]) => {
    const [a, b] = k.split(">");
    return a < b && dir.has(`${b}>${a}`) && (e.label ?? "") === (dir.get(`${b}>${a}`).label ?? "");
  });
  const shape = new Map(model.nodes.map((n) => [n.id, n.shape]));
  const lines = model.edges.flatMap((e) => (e.label ? e.label.split("\n") : []));
  const max = (xs) => Math.max(0, ...xs);
  return (
    max(pair.values()) <= 2 &&
    max(lines.map((l) => l.split(/\s+/).filter(Boolean).length)) <= 3 &&
    max(lines.map((l) => l.length)) <= 24 &&
    max(deg.values()) <= 8 &&
    max([...deg].filter(([id]) => shape.get(id) === "diamond").map(([, d]) => d)) <= 4 &&
    model.nodes.length <= 25 &&
    max(model.groups.map((g) => g.depth)) <= 2 &&
    !recipSame &&
    max(model.groups.map((g) => (g.title ?? "").length)) <= 24
  );
}

// ---- classification (pure given deps) ----
/**
 * Joins every report case with its lint result. deps = { lint, parse, textOf(profile, seed), modelOf?(profile, seed) }.
 * With modelOf, rows also carry `cand` (candidateCompliant).
 * Returns one row per render: { key, profile, seed, dir, hard, crossings, routeRatio, aspect, codes[] }.
 * `codes` are the COUNTED lint codes of the case's text (shared by its directions).
 */
export function classify(reports, deps) {
  const lintCache = new Map();
  const codesOf = (profile, seed) => {
    const k = `${profile}/${seed}`;
    if (!lintCache.has(k)) {
      const { graph, diagnostics } = deps.parse(deps.textOf(profile, seed));
      const bad = diagnostics.find((d) => d.severity === "error");
      if (bad) throw new Error(`${k}: generated text does not parse (line ${bad.line}: ${bad.message})`);
      lintCache.set(k, [...new Set(deps.lint(graph).map((d) => d.code).filter((c) => COUNTED.includes(c)))].sort());
    }
    return lintCache.get(k);
  };
  const candCache = new Map();
  const candOf = (profile, seed) => {
    const k = `${profile}/${seed}`;
    if (!candCache.has(k)) candCache.set(k, candidateCompliant(deps.modelOf(profile, seed)));
    return candCache.get(k);
  };
  const rows = [];
  for (const rep of reports) {
    const byRender = new Map();
    for (const f of rep.findings ?? []) {
      const k = `${f.case}\0${f.dir}`;
      if (!byRender.has(k)) byRender.set(k, []);
      byRender.get(k).push(f);
    }
    for (const c of rep.cases) {
      if (c.profile === undefined || c.seed === undefined) throw new Error(`report case ${c.case} has no profile/seed (not a fuzz report)`);
      const fs = byRender.get(`${c.case}\0${c.dir}`) ?? [];
      rows.push({
        key: `${c.case}-${c.dir}`,
        profile: c.profile,
        seed: c.seed,
        dir: c.dir,
        hard: c.hard > 0,
        crossings: crossingsOf(fs),
        routeRatio: fs.some((f) => f.code === "route-ratio"),
        aspect: fs.some((f) => f.code === "aspect-ratio"),
        codes: codesOf(c.profile, c.seed),
        ...(deps.modelOf ? { cand: candOf(c.profile, c.seed) } : {}),
      });
    }
  }
  return rows;
}

/** The numbers behind the TOON: classes, by_rule (with leave-one-out), compliant profiles, tiny/unicode exclusion. */
export function summarizeRows(rows) {
  const compliant = rows.filter((r) => r.codes.length === 0);
  const violating = rows.filter((r) => r.codes.length > 0);
  const byRule = COUNTED.flatMap((rule) => {
    const hit = rows.filter((r) => r.codes.includes(rule));
    if (hit.length === 0) return [];
    const loo = rows.filter((r) => r.codes.every((c) => c === rule));
    return [{ rule, violating_renders: hit.length, hard_rate: `${pct(hit.filter((r) => r.hard).length, hit.length)}%`, avg_crossings: mean(hit.map((r) => r.crossings)), loo_renders: loo.length, loo_hard_rate: `${pct(loo.filter((r) => r.hard).length, loo.length)}%` }];
  });
  const profiles = [...new Set(compliant.map((r) => r.profile))].map((profile) => ({ profile, ...stats(compliant.filter((r) => r.profile === profile)) }));
  const real = (rs) => rs.filter((r) => !["tiny", "unicode"].includes(r.profile));
  const c = stats(compliant);
  const v = stats(violating);
  const holds = compliant.length > 0 && Number(pct(c.hard, c.renders)) <= HARD_BAR && c.hard / c.renders < v.hard / Math.max(1, v.renders) && Number(c.avg_crossings) < Number(v.avg_crossings);
  const cand = rows.some((r) => r.cand !== undefined) ? [{ class: "compliant", ...stats(rows.filter((r) => r.cand)) }, { class: "violating", ...stats(rows.filter((r) => !r.cand)) }] : [];
  return {
    holds,
    cand,
    classes: [{ class: "compliant", ...c }, { class: "violating", ...v }],
    byRule,
    profiles,
    excl: { compliant: stats(real(compliant)), violating: stats(real(violating)) },
  };
}

// ---- fix mode ----
async function fixMode(rows, o, deps) {
  const { outDir } = o;
  const scratch = join(outDir, "_fix");
  const cases = new Map(); // "profile/seed" -> { profile, seed, codes, dirs[], before: Map(dir -> row) }
  for (const r of rows) {
    if (r.codes.length === 0) continue;
    const k = `${r.profile}/${r.seed}`;
    if (!cases.has(k)) cases.set(k, { profile: r.profile, seed: r.seed, codes: r.codes, before: new Map() });
    cases.get(k).before.set(r.dir, r);
  }
  const pickSubset = (list) => (o.hardOnly ? list.filter((c) => [...c.before.values()].some((r) => r.hard)) : list).slice(0, o.count ?? Infinity);
  const modelOf = (c) => generate(c.seed, c.profile, { rtl: PROFILES[c.profile].rtl }).model;

  async function redraw(list, fix, tag) {
    const texts = new Map(list.map((c) => [c, emit(fix(modelOf(c)))]));
    const jobs = list.flatMap((c) => [...c.before.keys()].map((dir) => ({ c, dir, text: texts.get(c) })));
    const lintLeft = new Map(list.map((c) => [c, deps.lint(deps.parse(texts.get(c)).graph).map((d) => d.code).filter((code) => COUNTED.includes(code))]));
    const done = await pool(jobs, o.jobs, async ({ c, dir, text }) => {
      const safe = `${c.profile}-${c.seed}-${dir}`;
      const r = await drawCase({ name: `${tag}-${safe}`, dir, text, base: join(scratch, tag, safe) }, { outDir });
      for (const ext of ["exd", "excalidraw"]) rmSync(join(scratch, tag, `${safe}.${ext}`), { force: true });
      return { c, dir, hard: hasHard(r), failed: r.exit !== 0, crossings: crossingsOf(r.findings), routeRatio: r.findings.some((f) => f.code === "route-ratio") };
    });
    return { done, lintLeft };
  }

  function row(rule, list, { done, lintLeft }) {
    const before = done.map(({ c, dir }) => c.before.get(dir));
    const clean = list.filter((c) => (rule === "all" ? lintLeft.get(c).length === 0 : !lintLeft.get(c).includes(rule))).length;
    return {
      rule,
      cases: list.length,
      renders: done.length,
      hard_before: before.filter((r) => r.hard).length,
      hard_after: done.filter((d) => d.hard).length,
      crossings_before: mean(before.map((r) => r.crossings)),
      crossings_after: mean(done.map((d) => d.crossings)),
      lint_clean: `${clean}/${list.length}`,
      cli_failures: done.filter((d) => d.failed).length,
    };
  }

  const fixed = [];
  for (const rule of Object.keys(FIXERS)) {
    const list = pickSubset([...cases.values()].filter((c) => c.codes.includes(rule)));
    if (list.length === 0) continue;
    fixed.push(row(rule, list, await redraw(list, FIXERS[rule], rule)));
  }
  const allList = pickSubset([...cases.values()]);
  if (allList.length > 0) fixed.push(row("all", allList, await redraw(allList, fixAll, "all")));
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(outDir, "_src"), { recursive: true, force: true });

  const unfixed = UNFIXABLE.flatMap((rule) => {
    const hit = rows.filter((r) => r.codes.includes(rule));
    return hit.length ? [{ rule, violating_renders: hit.length, hard_before: hit.filter((r) => r.hard).length, note: "needs a human decision; not auto-fixed" }] : [];
  });
  return { fixed, unfixed };
}

// ---- args + main ----
function parseArgs(argv) {
  const o = { reports: [], out: "out/compliance", fix: false, count: undefined, profiles: undefined, hardOnly: false, jobs: Math.min(8, availableParallelism()) };
  const value = (i, flag) => (argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? die(`${flag} needs a value`) : argv[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") o.reports.push(...value(i++, a).split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--out") o.out = value(i++, a);
    else if (a === "--fix") o.fix = true;
    else if (a === "--hard-only") o.hardOnly = true;
    else if (a === "--count") o.count = Math.max(1, Math.floor(Number(value(i++, a)) || die("--count needs a number")));
    else if (a === "--profile") o.profiles = value(i++, a).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--jobs") o.jobs = Math.max(1, Number(value(i++, a)) || 1);
    else die(`unknown argument ${a}`);
  }
  if (o.reports.length === 0) die("--report is required", "e.g. --report out/fuzz-s3/report.json,out/fuzz-s4/report.json");
  for (const p of o.profiles ?? []) if (!PROFILES[p]) die(`unknown profile ${p}`, `known: ${Object.keys(PROFILES).join(",")}`);
  return o;
}

async function main() {
  const t0 = Date.now();
  const o = parseArgs(process.argv.slice(2));
  const reports = o.reports.map((p) => {
    try {
      return JSON.parse(readFileSync(resolve(process.cwd(), p), "utf8"));
    } catch (err) {
      return die(`cannot read report ${p}: ${err.message}`, "pass fuzz report.json files (node scripts/fuzz.mjs writes out/fuzz*/report.json)");
    }
  });
  const { outDir, rel } = prepareOut(o.out, "out/compliance");
  o.outDir = outDir;
  const [{ lint }, { parse }] = await Promise.all([import(pathToFileURL(join(ROOT, "dist", "lint", "rules.js")).href), import(pathToFileURL(join(ROOT, "dist", "dsl", "parser.js")).href)]);
  const deps = { lint, parse, textOf: (profile, seed) => generate(seed, profile, { rtl: PROFILES[profile].rtl }).text, modelOf: (profile, seed) => generate(seed, profile, { rtl: PROFILES[profile].rtl }).model };

  let rows;
  try {
    rows = classify(reports, deps);
  } catch (err) {
    return die(err.message, "reports must come from scripts/fuzz.mjs with the same generator version");
  }
  if (o.profiles) rows = rows.filter((r) => o.profiles.includes(r.profile));
  const s = summarizeRows(rows);
  const cases = new Set(rows.map((r) => `${r.profile}/${r.seed}`)).size;

  const lines = [
    `compliance: ${rows.length} renders (${cases} cases)`,
    `claim: ${s.holds ? "holds" : "fails"} (compliant HARD rate <= ${HARD_BAR}% and below violating, fewer crossings)`,
    table("classes", s.classes, ["class", "renders", "hard", "hard_rate", "avg_crossings", "route_ratio_rate", "aspect_rate"]),
    ...(s.cand.length ? ["evidence_note: plan section 0 candidate set (adds edge chars <= 24 and group title <= 24, which the lints do not have)",table("evidence_set", s.cand, ["class", "renders", "hard", "hard_rate", "avg_crossings", "route_ratio_rate", "aspect_rate"])] : []),
    table("by_rule", s.byRule, ["rule", "violating_renders", "hard_rate", "avg_crossings", "loo_renders", "loo_hard_rate"]),
    table("profiles", s.profiles, ["profile", "renders", "hard", "hard_rate", "avg_crossings"]),
    `compliant_excl_tiny_unicode: ${s.excl.compliant.renders} renders, ${s.excl.compliant.hard_rate} hard, crossings ${s.excl.compliant.avg_crossings} vs ${s.excl.violating.avg_crossings} violating`,
  ];
  const report = { summary: { renders: rows.length, cases, holds: s.holds, reports: o.reports }, classes: s.classes, evidenceSet: s.cand, byRule: s.byRule, profiles: s.profiles, exclTinyUnicode: s.excl };

  if (o.fix) {
    const fx = await fixMode(rows, o, deps);
    report.fixed = fx.fixed;
    report.unfixed = fx.unfixed;
    lines.push(table("fixed", fx.fixed, ["rule", "cases", "renders", "hard_before", "hard_after", "crossings_before", "crossings_after", "lint_clean", "cli_failures"]));
    if (fx.unfixed.length) lines.push(table("unfixed", fx.unfixed, ["rule", "violating_renders", "hard_before", "note"]));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  lines.push(`report: ${rel}/report.json`);
  process.stdout.write(lines.join("\n") + "\n");
  process.stderr.write(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  process.exit(s.holds ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
