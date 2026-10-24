#!/usr/bin/env node
// Shrink a failing diagram to a minimal .exd repro (run `npm run build` first).
//
//   node scripts/shrink.mjs <file.exd | profile/seed> [--dir DOWN|RIGHT|UP|LEFT] [--code <code>] [--include-planned]
//        [--out <path>] [--budget <n>] [--rtl]
//
//   <file.exd>      any .exd (corpus file, out/fuzz/<profile>/<seed>-<DIR>.exd, a hand-made repro)
//   <profile/seed>  regenerate a fuzz case exactly as `scripts/fuzz.mjs --case` does (e.g. multi-edge/1056367876)
//   --dir           the direction the failure is chased in; default: the first of DOWN,RIGHT,UP,LEFT that fails
//   --code          the failure to preserve (default: cli-failure, else the first HARD code alphabetically)
//   --include-planned  also treat soft rules that are planned to turn HARD (RULES[code][2]) as failures
//   --out           default out/shrink/<name>-<code>-<DIR>.exd
//   --budget        oracle-call cap (default 400); on exhaustion the best repro so far is kept
//
// Deterministic; prints a TOON summary and the minimal repro. Exit 0 = shrunk, 1 = input does not fail, 2 = usage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { generate } from "./qa/gen.mjs";
import { PROFILES } from "./qa/profiles.mjs";
import { DEFAULT_BUDGET, reproHeader, shrinkCase, sizeOf } from "./qa/shrink.mjs";
import { ALL_DIRS, ROOT, checkDirs, requireBuild } from "./qa/run.mjs";

const FLAGS = "--dir <DIR> --code <code> --include-planned --out <path> --budget <n> --rtl";
const die = (msg, suggestion, code = 2) => {
  process.stdout.write(`error: ${msg}\nsuggestion: ${suggestion}\n`);
  process.exit(code);
};

function parseArgs(argv) {
  const o = { input: undefined, dir: undefined, code: undefined, includePlanned: false, out: undefined, budget: DEFAULT_BUDGET, rtl: false };
  const val = (i, flag) => (argv[i] === undefined ? die(`${flag} needs a value`, `valid flags: ${FLAGS}`) : argv[i]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = val(++i, a).toUpperCase();
    else if (a === "--code") o.code = val(++i, a);
    else if (a === "--include-planned") o.includePlanned = true;
    else if (a === "--out") o.out = val(++i, a);
    else if (a === "--budget") o.budget = Math.max(1, Number(val(++i, a)) || DEFAULT_BUDGET);
    else if (a === "--rtl") o.rtl = true;
    else if (a.startsWith("--")) die(`unknown flag ${a}`, `valid flags: ${FLAGS}`);
    else if (o.input === undefined) o.input = a;
    else die(`unexpected argument ${a}`, "pass exactly one input");
  }
  if (!o.input) die("no input", `usage: node scripts/shrink.mjs <file.exd|profile/seed> [${FLAGS}]`);
  if (o.dir) checkDirs([o.dir]);
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  requireBuild();
  let text;
  let model;
  let meta = {};
  let name;
  const ref = /^([a-z][a-z0-9-]*)\/(\d+)$/.exec(o.input);
  if (existsSync(o.input)) {
    text = readFileSync(o.input, "utf8");
    name = basename(o.input).replace(/\.exd$/, "");
    const m = /^# fuzz case: ([a-z][a-z0-9-]*)\/(\d+)/m.exec(text);
    if (m) meta = { profile: m[1], seed: m[2] };
  } else if (ref) {
    const [, profile, seed] = ref;
    if (!PROFILES[profile]) die(`unknown profile ${profile}`, "use a profile from scripts/qa/profiles.mjs");
    const g = generate(Number(seed) >>> 0, profile, { rtl: o.rtl || PROFILES[profile].rtl });
    ({ text, model } = g);
    meta = { profile, seed };
    name = `${profile}-${seed}`;
  } else die(`${o.input} is neither a file nor a <profile>/<seed> reference`, "e.g. out/fuzz/dense/123-DOWN.exd or multi-edge/1056367876");

  const r = await shrinkCase({ text, model, dirs: o.dir ? [o.dir] : ALL_DIRS, code: o.code, includePlanned: o.includePlanned, budget: o.budget });
  if (!r.ok) die(r.reason, "check --dir / --code, or that the build is current (npm run build)", 1);

  const out = resolve(ROOT, o.out ?? `out/shrink/${name}-${r.code}-${r.dir}.exd`);
  mkdirSync(dirname(out), { recursive: true });
  const body = reproHeader(r, meta) + r.text;
  writeFileSync(out, body);
  const lines = [
    "shrink: ok",
    `code: ${r.code}`,
    `dir: ${r.dir}`,
    `detail: ${JSON.stringify(r.detail.slice(0, 160))}`,
    `original: ${sizeOf(r.from)}`,
    `minimal: ${sizeOf(r.to)}`,
    `oracle_calls: ${r.calls}${r.exhausted ? " (budget exhausted, best so far kept)" : ""}`,
    ...(r.fellBack ? ["note: model re-emit did not reproduce; reduced line by line"] : []),
    `signature: ${r.signature}`,
    `out: ${out}`,
    "repro:",
    ...r.text.trimEnd().split("\n").map((l) => `  ${l}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err) => {
  process.stdout.write(`error: shrink crashed: ${err.stack ?? err}\n`);
  process.exit(2);
});
