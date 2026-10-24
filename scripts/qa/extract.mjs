#!/usr/bin/env node
// Readability QA for `extract` (plan 2026-10-24-extract-plan.md section 5.3). Manual, never run in CI.
// The only network use is the one-time clone step. Needs the built cli (npm run build).
//
//   node scripts/qa/extract.mjs [--set core|holdout|all] [--repo commander,hono,...] [--jobs 3] [--out <dir>] [--no-png] [--clone-only]
//
// --set core (default): 6 pinned public TS/JS repos (cloned into out/extract-corpus/<name>@<sha7>/, skipped when present)
// plus this repo's src/, 4 views each = 28 cases: default, --group none, --focus <entry> --depth 2, --max-nodes 15; output
// out/qa-extract-r4/. --set holdout: the 5 pinned HOLDOUT repos (20 cases, never tuned on; score once), output
// out/qa-extract-holdout-r1/. --set all runs both (--out X then means X/core and X/holdout).
// Per case: extract -> check (errors, warnings, engine line) -> draw with the engine extract printed in its draw line
// (--engine d2 when extract says so, else the default excalidraw) --svg --png --geometry-json ->
// the shared geometric checker (scripts/qa/analyze.mjs). Writes <out>/report.json, <out>/png/<repo>-<view>.png and
// prints a TOON summary with the bars from the plan (0 HARD on every case, the four SILENT lints silent). Exit 1 when a
// bar fails. Per case it keeps exd/<case>.exd, exd/<case>.exd.map.json, png/<case>.png; the run keeps report.json and
// vision-packet.md (reviewer replies go next to it as verdicts-1.json / verdicts-2.json, scored by vision-score.mjs).
//
// Windows guard: the browser launches (png) are limited by --jobs (cap 3) and the account lock state is checked
// before the run, after every case and at the end; a non-"Yes" `Account active` stops the run at once.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RULES, analyzeScene } from "./analyze.mjs";
import { maskFindings, readEngineGeometry, sceneOf, svgProblem } from "./engines.mjs";
import { visionPacket } from "./extract-packet.mjs";
import { ROOT, pool, requireBuild, runDraw, summarize, table } from "./run.mjs";

export { visionPacket };

/**
 * Pinned corpus. `sha` is the release tag's commit (peeled), `sub` the folder scanned, `entry` the --focus target
 * (relative to the repo root), `args` extra extract flags used in every view of the repo.
 */
export const REPOS = [
  { name: "commander", url: "https://github.com/tj/commander.js.git", tag: "v15.0.0", sha: "ba6d13ddb4243e5913367734f8c159089ffe7834", sub: ".", entry: "index.js", args: [] },
  { name: "zod", url: "https://github.com/colinhacks/zod.git", tag: "v4.6.7", sha: "b500a2ee95134f81d74da7911d7378dd2853d042", sub: "packages/zod/src", entry: "packages/zod/src/index.ts", args: [] },
  { name: "hono", url: "https://github.com/honojs/hono.git", tag: "v4.13.13", sha: "08a023cbfde55b434fb0fb30fae35d42e4bf20aa", sub: "src", entry: "src/hono.ts", args: [] },
  { name: "fastify", url: "https://github.com/fastify/fastify.git", tag: "v5.12.7", sha: "9f400035ebaf572b95989db5040ebb09c01e4e77", sub: ".", entry: "fastify.js", args: [] },
  { name: "vitest", url: "https://github.com/vitest-dev/vitest.git", tag: "v5.0.5", sha: "7a825db43e2beca0b219d2eadaec334cb81af0c7", sub: "packages/vitest", entry: "packages/vitest/src/public/node.ts", args: [] },
  { name: "excalidraw", url: "https://github.com/excalidraw/excalidraw.git", tag: "v0.18.1", sha: "a2ec2889babf7d2295469c6d90ebe77fae57df84", sub: "packages/excalidraw", entry: "packages/excalidraw/index.tsx", args: [] },
  { name: "self", url: null, tag: "HEAD", sha: null, sub: "src", entry: "src/index.ts", args: [] },
];
/**
 * Held-out corpus (hardening plan section 3, corpus B): 5 repos never opened while the extract fixes were made, 4 views each =
 * 20 cases, scored once after the core set passes. Each is pinned to its latest stable release tag as of 2026-10-24 (peeled
 * commit sha from the remote tag list). `entry` is the --focus target, picked from the package layout without opening the
 * sources; `verify: true` marks a guess (the run stops before any extract when an entry or scan folder is missing in the checkout).
 */
export const HOLDOUT = [
  { name: "axios", url: "https://github.com/axios/axios.git", tag: "v1.20.0", sha: "84a9f3b9a4f3244b8c8e818f557d64c7b964fb25", sub: "lib", entry: "lib/axios.js", args: [], verify: false },
  { name: "react-router", url: "https://github.com/remix-run/react-router.git", tag: "react-router@8.5.0", sha: "4fe4525102870a2b21a4a0568a651d118f5e5dbb", sub: "packages/react-router/lib", entry: "packages/react-router/lib/components.tsx", args: [], verify: true },
  { name: "vue-core", url: "https://github.com/vuejs/core.git", tag: "v3.5.44", sha: "bf5f0dd877dd3c23ce85c2cbc1dd771567e84c8c", sub: "packages/runtime-core/src", entry: "packages/runtime-core/src/index.ts", args: [], verify: false },
  { name: "nest", url: "https://github.com/nestjs/nest.git", tag: "v12.2.0", sha: "af37111368de7fd2dfab0bdec2f530c7845510c2", sub: "packages/core", entry: "packages/core/index.ts", args: [], verify: true },
  { name: "svelte", url: "https://github.com/sveltejs/svelte.git", tag: "svelte@5.57.2", sha: "10fdca7d705081cae17bf7d609d46ee6eb237d17", sub: "packages/svelte/src/compiler", entry: "packages/svelte/src/compiler/index.js", args: [], verify: true },
];
/** Set name -> repos and default output folder. */
export const SETS = {
  core: { repos: REPOS, out: "out/qa-extract-r4" },
  holdout: { repos: HOLDOUT, out: "out/qa-extract-holdout-r1" },
};
export const VIEWS = [
  { view: "default", args: () => [] },
  { view: "none", args: () => ["--group", "none"] },
  { view: "focus", args: (r) => ["--focus", r.entryPath, "--depth", "2"] },
  { view: "max15", args: () => ["--max-nodes", "15"] },
];
/** Lint rules the cut must keep silent in every case. */
export const SILENT = ["many-nodes", "busy-node", "long-label", "deep-nesting"];
export const MAX_JOBS = 3;
const CORPUS = join(ROOT, "out", "extract-corpus");

const die = (msg, suggestion) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(2);
};
const posix = (p) => p.split("\\").join("/");

// ---- args ----
export function parseArgs(argv) {
  const o = { set: "core", repos: undefined, jobs: MAX_JOBS, out: undefined, png: true, cloneOnly: false };
  const usage = "valid flags: --set core|holdout|all --repo <names> --jobs <1-3> --out <dir> --no-png --clone-only";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") o.set = String(argv[++i]);
    else if (a === "--repo") o.repos = String(argv[++i]).split(",").filter(Boolean);
    else if (a === "--jobs") o.jobs = Math.min(MAX_JOBS, Math.max(1, Number(argv[++i]) || 1));
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--no-png") o.png = false;
    else if (a === "--clone-only") o.cloneOnly = true;
    else die(`unknown flag ${a}`, usage);
  }
  if (!["core", "holdout", "all"].includes(o.set)) die(`unknown --set ${o.set}`, "use core, holdout or all");
  const names = (o.set === "all" ? [...REPOS, ...HOLDOUT] : SETS[o.set].repos).map((r) => r.name);
  const bad = (o.repos ?? []).filter((n) => !names.includes(n));
  if (bad.length) die(`unknown repo ${bad.join(",")} for --set ${o.set}`, `use ${names.join(",")}`);
  return o;
}

// ---- windows logon-lock guard ----
/** "Yes" when the account is usable, the raw value otherwise; "n/a" off Windows or when `net user` is unreadable. */
export function accountActive() {
  if (process.platform !== "win32") return "n/a";
  const r = spawnSync("net", ["user", userInfo().username], { encoding: "utf8", timeout: 10000 });
  const m = /Account active\s+(\S+)/i.exec(r.stdout ?? "");
  return m ? m[1] : "n/a";
}
const locked = (v) => v !== "Yes" && v !== "n/a";

// ---- clone ----
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 600000 });

/** Corpus checkout of a repo (clones when missing). Returns { dir, sha } where sha is the commit actually checked out. */
export function ensureRepo(r) {
  if (!r.url) {
    const sha = git(ROOT, ["rev-parse", "HEAD"]).stdout.trim();
    return { dir: ROOT, sha, label: `self@${sha.slice(0, 7)}` };
  }
  const label = `${r.name}@${r.sha.slice(0, 7)}`;
  const dir = join(CORPUS, label);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(CORPUS, { recursive: true });
    const tmp = `${dir}.partial`;
    rmSync(tmp, { recursive: true, force: true });
    for (const args of [["clone", "--quiet", "--filter=blob:none", "--no-checkout", r.url, tmp]]) {
      const c = git(ROOT, args);
      if (c.status !== 0) throw new Error(`git ${args[0]} ${r.url}: ${(c.stderr || "").trim().slice(0, 200)}`);
    }
    const co = git(tmp, ["checkout", "--quiet", r.sha]);
    if (co.status !== 0) throw new Error(`git checkout ${r.sha}: ${(co.stderr || "").trim().slice(0, 200)}`);
    renameSync(tmp, dir);
  }
  return { dir, sha: git(dir, ["rev-parse", "HEAD"]).stdout.trim(), label };
}

// ---- parsing of cli output ----
const num = (re, s) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : undefined;
};
/** Rows of a TOON table block `name[N]{..}:` as raw CSV lines. */
function blockRows(text, name) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${name}[`));
  if (i < 0) return [];
  const rows = [];
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) rows.push(lines[j].trim());
  return rows;
}

export function parseExtract(stdout) {
  const g = /^graph: (\d+) nodes?.*?, (\d+) edges?/m.exec(stdout);
  return {
    files: num(/^extract: ok, (\d+) files/m, stdout),
    importEdges: num(/^extract: ok, \d+ files, (\d+) import edges/m, stdout),
    nodes: g ? Number(g[1]) : undefined,
    edges: g ? Number(g[2]) : undefined,
    cycles: num(/^cycles: (\d+)/m, stdout),
    unresolved: num(/^unresolved: (\d+)/m, stdout),
    graphLine: (/^graph: .*$/m.exec(stdout) ?? [""])[0],
    isolated: num(/; isolated: (\d+) files?/, stdout) ?? 0,
    // the box budget actually used: 25 unless extract lowered it ("budget 12 (dense)")
    budget: num(/; budget (\d+) \(dense\)/, stdout) ?? 25,
    engineLine: (/^engine: .*$/m.exec(stdout) ?? [""])[0],
    // the engine of the first `draw` help line, as extract prints it for the agent
    drawEngine: (/^\s+\S*diagram-axi draw \S+(?: --engine (\w+))? --png$/m.exec(stdout) ?? [])[1] ?? "excalidraw",
  };
}

export function parseCheck(stdout) {
  const warnRows = blockRows(stdout, "warnings");
  return {
    errors: num(/(\d+) errors?/, stdout.split("\n")[0] ?? "") ?? 0,
    warnings: num(/(\d+) warnings?/, stdout.split("\n")[0] ?? "") ?? 0,
    quality: blockRows(stdout, "quality").map((r) => r.split(",")[0]),
    lint: warnRows.map((r) => r.split(",")[2]).filter(Boolean),
    engineLine: (/^engine: .*$/m.exec(stdout) ?? [""])[0],
  };
}

export function parseDraw(stdout) {
  const scene = /^scene: (\d+) nodes?, (\d+) edges?, (\d+) groups?, (\d+)x(\d+) px/m.exec(stdout);
  const scale = /scale reduced from ([\d.]+) to ([\d.]+)/.exec(stdout);
  const eng = /^engine: (\w+)/m.exec(stdout);
  return {
    engine: eng ? eng[1] : undefined,
    engineLine: (/^engine: .*$/m.exec(stdout) ?? [""])[0],
    nodes: scene ? Number(scene[1]) : undefined,
    edges: scene ? Number(scene[2]) : undefined,
    groups: scene ? Number(scene[3]) : undefined,
    width: scene ? Number(scene[4]) : undefined,
    height: scene ? Number(scene[5]) : undefined,
    scaleFrom: scale ? Number(scale[1]) : undefined,
    scaleTo: scale ? Number(scale[2]) : undefined,
    layout: (/layout (\w+)/.exec(stdout) ?? [])[1],
  };
}

// ---- .exd observations (hubs) ----
/**
 * Hub observations from an emitted .exd: hubs (labels with `used by N` / `K uses hidden`), islands (a hub with no edge
 * at all, so the hub folder floats detached) and crowded hubs (label with more than 2 lines: the hub note is one line).
 */
export function hubStats(exdText) {
  const nodes = new Map();
  const touched = new Set();
  for (const raw of exdText.split(/\r?\n/)) {
    const line = raw.trim();
    const n = /^([A-Za-z0-9_]+)\[(.*)\](?:\s+:\w+)?$/.exec(line);
    if (n) {
      nodes.set(n[1], n[2]);
      continue;
    }
    const e = /^([A-Za-z0-9_]+)\s+(?:<->|-->|->|-\.->|<-)\s+([A-Za-z0-9_]+)/.exec(line);
    if (e) {
      touched.add(e[1]);
      touched.add(e[2]);
    }
  }
  // a hub label is `name\nused by N[, K uses hidden]` (or `K uses hidden` alone; `entry, ` leads the note on a green hub)
  const isHub = (label) => label.includes("used by") || /\d+ uses? hidden/.test(label);
  const hubs = [...nodes].filter(([, label]) => isHub(label));
  const islands = hubs.filter(([id]) => !touched.has(id)).map(([, l]) => l.split("\\n")[0]);
  const crowded = hubs.filter(([, label]) => label.split("\\n").length > 2).map(([, l]) => l.split("\\n").join(" / "));
  const isolated = [...nodes].filter(([id, label]) => !touched.has(id) && !isHub(label)).length;
  return { hubs: hubs.length, islands: islands.length, islandLabels: islands, crowded: crowded.length, crowdedLabels: crowded, isolated };
}

// ---- one case ----
async function runCase(c, o, dirs) {
  const base = `${c.repo.name}-${c.view}`;
  const exdBase = join(dirs.exd, base);
  const res = { case: base, dir: "DOWN", repo: c.repo.name, view: c.view, findings: [], stats: null };

  const t0 = process.hrtime.bigint();
  const ex = await runDraw(["extract", c.scan, ...c.args, "--out", exdBase, "--force"]);
  res.extract = { exit: ex.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), ...parseExtract(ex.stdout) };
  if (ex.status !== 0) {
    res.findings.push(failure("cli-failure", `extract exit ${ex.status}: ${(ex.stdout + ex.stderr).trim().split("\n").slice(0, 2).join(" | ").slice(0, 300)}`));
    return res;
  }
  const exdFile = `${exdBase}.exd`;
  res.hubs = hubStats(readFileSync(exdFile, "utf8"));

  const ck = await runDraw(["check", exdFile]);
  res.check = { exit: ck.status, ...parseCheck(ck.stdout) };

  const out = join(dirs.draw, base);
  const args = ["draw", exdFile, "--engine", res.extract.drawEngine, "--svg", "--geometry-json", "--out", out, "--force"];
  if (o.png) args.push("--png");
  const t1 = process.hrtime.bigint();
  const dr = await runDraw(args);
  res.draw = { exit: dr.status, ms: Math.round(Number(process.hrtime.bigint() - t1) / 1e6), ...parseDraw(dr.stdout) };
  res.draw.engine ??= res.extract.drawEngine; // an explicit --engine prints no engine line
  if (dr.status !== 0) {
    res.findings.push(failure("cli-failure", `draw exit ${dr.status}: ${(dr.stdout + dr.stderr).trim().split("\n").slice(0, 2).join(" | ").slice(0, 300)}`));
    return res;
  }
  if (dr.stderr.trim()) res.findings.push(failure("cli-stderr", dr.stderr.trim().slice(0, 200)));

  let scene;
  let geometry;
  try {
    if (existsSync(`${out}.geometry.json`)) {
      geometry = readEngineGeometry(out);
      scene = { elements: await sceneOf(geometry) };
      const bad = svgProblem(out);
      if (bad) res.findings.push(failure("render-failure", bad));
    } else {
      scene = JSON.parse(readFileSync(`${out}.excalidraw`, "utf8"));
    }
    if (!Array.isArray(scene.elements)) throw new Error("no elements array");
  } catch (err) {
    res.findings.push(failure("cli-failure", `scene unreadable: ${err.message}`));
    return res;
  }
  if (o.png) {
    if (existsSync(`${out}.png`)) copyFileSync(`${out}.png`, join(dirs.png, `${base}.png`));
    else res.findings.push(failure("render-failure", `${relative(ROOT, out)}.png missing`));
  }
  const a = analyzeScene(scene);
  res.stats = a.stats;
  res.rulesSkipped = geometry ? [...geometry.rules_skipped].sort() : [];
  res.findings.push(...(geometry ? maskFindings(a.findings, geometry.rules_skipped) : a.findings));
  return res;
}

const failure = (code, detail) => ({ code, severity: RULES[code][0], elements: [], detail });
const hardOf = (r) => r.findings.filter((f) => f.severity === "hard");
const softOf = (r) => r.findings.filter((f) => f.severity === "soft");
const uniq = (xs) => [...new Set(xs)];

// ---- bars + summary ----
export function evaluate(results) {
  const defaults = results.filter((r) => r.view === "default");
  const clean = results.filter((r) => hardOf(r).length === 0).length;
  const silentBreaks = results.flatMap((r) => (r.check?.lint ?? []).filter((c) => SILENT.includes(c)).map((c) => `${r.case}:${c}`));
  const extractFail = results.filter((r) => r.extract.exit !== 0).map((r) => r.case);
  const bars = [
    { bar: "0 HARD on every default view", ok: defaults.every((r) => hardOf(r).length === 0), detail: `${defaults.filter((r) => hardOf(r).length === 0).length}/${defaults.length} default views HARD-clean` },
    { bar: "0 HARD on every case", ok: results.length > 0 && clean === results.length, detail: `${clean}/${results.length} = ${results.length ? ((clean / results.length) * 100).toFixed(1) : "0"}%` },
    { bar: `${SILENT.join("/")} silent in every case`, ok: silentBreaks.length === 0 && extractFail.length === 0, detail: silentBreaks.length ? silentBreaks.join(" ") : extractFail.length ? `extract failed: ${extractFail.join(" ")}` : "silent" },
  ];
  return { bars, ok: bars.every((b) => b.ok), clean };
}

/** Observation counts (hub islands, crowded hub labels, tall images with reduced scale) over all cases. */
export function observations(results) {
  const withHubs = results.filter((r) => r.hubs);
  const sum = (f) => withHubs.reduce((n, r) => n + f(r), 0);
  const tall = results.filter((r) => r.draw?.scaleTo !== undefined);
  const verytall = results.filter((r) => r.draw?.height && r.draw?.width && r.draw.height / r.draw.width >= 1.5);
  return {
    hubIslands: { cases: withHubs.filter((r) => r.hubs.islands > 0).length, total: sum((r) => r.hubs.islands), of: withHubs.length, hubsTotal: sum((r) => r.hubs.hubs), where: withHubs.filter((r) => r.hubs.islands > 0).map((r) => `${r.case}(${r.hubs.islandLabels.join("; ")})`) },
    crowdedHubLabels: { cases: withHubs.filter((r) => r.hubs.crowded > 0).length, total: sum((r) => r.hubs.crowded), of: withHubs.length, where: withHubs.filter((r) => r.hubs.crowded > 0).map((r) => `${r.case}(${r.hubs.crowdedLabels.join("; ")})`) },
    scaleReduced: { cases: tall.length, of: results.length, min: tall.length ? Math.min(...tall.map((r) => r.draw.scaleTo)) : null, where: tall.map((r) => `${r.case}(${r.draw.width}x${r.draw.height} -> ${r.draw.scaleTo})`) },
    tallPx: { cases: results.filter((r) => r.draw?.height >= 2500).length, of: results.length, where: results.filter((r) => r.draw?.height >= 2500).map((r) => `${r.case}(${r.draw.width}x${r.draw.height}, ${r.draw.engine})`) },
    tallScenes: { cases: verytall.length, of: results.length, where: verytall.map((r) => `${r.case}(${r.draw.width}x${r.draw.height})`) },
  };
}

const sc = (r) => uniq(softOf(r).map((f) => f.code)).join("+");
export function toon(results, ev, obs, meta) {
  const rows = results.map((r) => ({
    case: r.case,
    hard: hardOf(r).length,
    hard_codes: uniq(hardOf(r).map((f) => f.code)).join("+"),
    soft: softOf(r).length,
    soft_rules: sc(r),
    engine: r.draw?.engine ?? "-",
    nodes: r.extract.nodes ?? "-",
    edges: r.extract.edges ?? "-",
    isolated: r.extract.isolated ?? 0,
    budget: r.extract.budget ?? 25,
    check: r.check ? `${r.check.errors}e/${r.check.warnings}w` : "-",
    extract_ms: r.extract.ms,
  }));
  const out = [];
  out.push(`qa-extract: ${ev.ok ? "PASS" : "FAIL"}, ${results.length} cases, ${ev.clean} HARD-clean, jobs ${meta.jobs}`);
  out.push(table("cases", rows, ["case", "hard", "hard_codes", "soft", "soft_rules", "engine", "nodes", "edges", "isolated", "budget", "check", "extract_ms"]));
  out.push(table("bars", ev.bars.map((b) => ({ bar: b.bar, result: b.ok ? "PASS" : "FAIL", detail: b.detail })), ["bar", "result", "detail"]));
  const s = summarize(results);
  if (s.byCode.length) out.push(table("by_code", s.byCode, ["code", "severity", "count", "cases", "example"]));
  out.push("observations:");
  out.push(`  hub_islands: ${obs.hubIslands.total} in ${obs.hubIslands.cases}/${obs.hubIslands.of} cases (of ${obs.hubIslands.hubsTotal} hub boxes)`);
  out.push(`  crowded_hub_labels: ${obs.crowdedHubLabels.total} in ${obs.crowdedHubLabels.cases}/${obs.crowdedHubLabels.of} cases`);
  out.push(`  scale_reduced: ${obs.scaleReduced.cases}/${obs.scaleReduced.of} cases${obs.scaleReduced.min === null ? "" : `, min scale ${obs.scaleReduced.min}`}`);
  out.push(`  tall_scenes_h_over_1.5w: ${obs.tallScenes.cases}/${obs.tallScenes.of} cases`);
  out.push(`  scene_height_2500px_or_more: ${obs.tallPx.cases}/${obs.tallPx.of} cases (${obs.tallPx.where.join("; ")})`);
  out.push(`account_active: ${meta.accountEnd}`);
  return out.join("\n");
}

// ---- main ----
const join2 = (a, b) => (a === "." ? b : `${a}/${b}`);
const rootOf = (r) => posix(relative(ROOT, r.dir)) || ".";

/** Repos of a set that exist on disk (clone on demand). */
function prepare(repos, o) {
  const prepared = [];
  for (const r of repos.filter((x) => !o.repos || o.repos.includes(x.name))) {
    try {
      prepared.push({ ...r, ...ensureRepo(r) });
    } catch (err) {
      die(`clone failed for ${r.name}: ${err.message}`, "check the network and rerun; a partial clone is removed on the next run");
    }
  }
  return prepared;
}

/** Scan folder and focus entry present in the checkout? (a pinned guess may be wrong: say so before any extract runs). */
const layoutProblems = (prepared) =>
  prepared.flatMap((r) => [
    ...(existsSync(join(r.dir, r.sub)) ? [] : [`${r.name}: scan folder ${r.sub} missing`]),
    ...(existsSync(join(r.dir, r.entry)) ? [] : [`${r.name}: focus entry ${r.entry} missing${r.verify ? " (marked verify)" : ""}`]),
  ]);

async function runSet(setName, prepared, o, relOut) {
  const outDir = resolve(ROOT, relOut);
  const rel = relative(ROOT, outDir);
  if (!rel || rel.startsWith("..")) die(`--out must be a folder inside the project (got ${relOut})`, `use the default ${SETS[setName].out}`);
  const bad = layoutProblems(prepared);
  if (bad.length) die(bad.join("; "), "fix the repo entry in scripts/qa/extract.mjs (REPOS / HOLDOUT) and rerun");
  rmSync(outDir, { recursive: true, force: true });
  const dirs = { exd: join(outDir, "exd"), draw: join(outDir, "draw"), png: join(outDir, "png") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

  const accountStart = accountActive();
  if (locked(accountStart)) die(`Windows account is not active (Account active: ${accountStart})`, "stop; do not launch a browser until the account is unlocked");

  const cases = prepared.flatMap((r) => {
    const root = rootOf(r);
    const withPaths = { ...r, entryPath: join2(root, r.entry) };
    return VIEWS.map((v) => ({ repo: r, view: v.view, scan: join2(root, r.sub), args: [...r.args, ...v.args(withPaths)] }));
  });
  let aborted = null;
  const results = await pool(cases, o.jobs, async (c) => {
    if (aborted) return { case: `${c.repo.name}-${c.view}`, dir: "DOWN", repo: c.repo.name, view: c.view, extract: { exit: -1 }, findings: [failure("cli-failure", `skipped: ${aborted}`)], stats: null };
    const r = await runCase(c, o, dirs);
    const acc = accountActive();
    if (locked(acc)) aborted = `account lock state is ${acc}`;
    return r;
  });
  const accountEnd = accountActive();
  if (aborted) process.stdout.write(`warning: run aborted early: ${aborted}\n`);

  // a `none` view with no open folder is the default view without the (absent) groups: say so, the picture is the same
  for (const r of results.filter((x) => x.view === "none")) {
    const d = results.find((x) => x.repo === r.repo && x.view === "default");
    if (d && r.extract.exit === 0 && d.extract.exit === 0 && readFileSync(join(dirs.exd, `${r.case}.exd`), "utf8") === readFileSync(join(dirs.exd, `${d.case}.exd`), "utf8")) r.duplicateOf = d.case;
  }

  const ev = evaluate(results);
  const obs = observations(results);
  const sum = summarize(results);
  const report = {
    summary: { set: setName, cases: results.length, hardClean: ev.clean, hard: sum.hard.length, soft: sum.soft.length, pass: ev.ok, jobs: o.jobs, png: o.png, accountStart, accountEnd },
    repos: prepared.map((p) => ({ name: p.name, tag: p.tag, sha: p.sha, dir: rootOf(p), scanned: p.sub, entry: p.entry, ...(p.verify ? { verify: true } : {}) })),
    bars: ev.bars,
    observations: obs,
    rules: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, { severity: v[0], definition: v[1] }])),
    byCode: sum.byCode.map(({ code, severity, count, cases: n }) => ({ code, severity, count, cases: n })),
    cases: results.map((r) => ({
      case: r.case,
      repo: r.repo,
      view: r.view,
      hard: hardOf(r).length,
      soft: softOf(r).length,
      hardCodes: uniq(hardOf(r).map((f) => f.code)),
      softCodes: uniq(softOf(r).map((f) => f.code)),
      extract: r.extract,
      check: r.check,
      draw: r.draw,
      hubs: r.hubs,
      ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
      stats: r.stats,
      rulesSkipped: r.rulesSkipped,
    })),
    findings: results.flatMap((r) => r.findings.map((f) => ({ case: r.case, code: f.code, severity: f.severity, elements: f.elements, detail: f.detail }))),
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (o.png) writeFileSync(join(outDir, "vision-packet.md"), visionPacket(results, outDir, report.repos));
  process.stdout.write(`set: ${setName}\n` + toon(results, ev, obs, { jobs: o.jobs, accountEnd }) + `\nout: ${posix(rel)}/report.json\n`);
  return aborted ? 2 : ev.ok ? 0 : 1;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  requireBuild();
  const wantedSets = o.set === "all" ? ["core", "holdout"] : [o.set];
  const prepared = Object.fromEntries(wantedSets.map((s) => [s, prepare(SETS[s].repos, o)]));
  const sets = wantedSets.filter((s) => prepared[s].length > 0); // --repo may name repos of one set only
  if (o.cloneOnly) {
    const rows = sets.flatMap((s) => prepared[s].map((p) => `  ${s},${p.name},${p.tag},${p.sha},${rootOf(p)},${p.entry},${existsSync(join(p.dir, p.entry))}${p.verify ? ",verify" : ""}`));
    process.stdout.write(`repos[${rows.length}]{set,name,tag,sha,dir,entry,entry_exists}:\n${rows.join("\n")}\n`);
    return 0;
  }
  let code = 0;
  for (const s of sets) {
    const rel = o.out === undefined ? SETS[s].out : o.set === "all" ? `${o.out}/${s}` : o.out;
    code = Math.max(code, await runSet(s, prepared[s], o, rel));
  }
  return code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => (process.exitCode = code));
}
