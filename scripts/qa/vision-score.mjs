#!/usr/bin/env node
// Scores the two vision reviewers of an `extract` QA run (hardening plan section 3, bars V1-V4). No browser, no network.
//
//   node scripts/qa/vision-score.mjs <packet-dir> [--holdout]
//
// <packet-dir> holds verdicts-1.json and verdicts-2.json (what each Sonnet reviewer replied: an array with one object per
// image, `{"case": "zod-default", ..., "V10": "yes"|"no", "note": "..."}`; see the reply format in vision-packet.md).
// A case is accepted by a reviewer when its V10 is "yes". Both files must cover the same cases.
//
//   V1  mean of the two reviewers' V10-yes rates (each over all cases)        core bar: >= 90%
//   V2  default views accepted by BOTH reviewers (n of the default views)      core bar: all (7/7)
//   V3  cases rejected by BOTH reviewers (listed)                              core bar: 0
//   V4  (--holdout) generality: V1 mean >= 85% and V3 = 0                      held-out bar
//
// Prints TOON; exit 0 when the bars of the chosen corpus pass, 1 when one fails, 2 on unreadable input.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { table } from "./run.mjs";

export const CORE_BARS = { v1: 90 };
export const HOLDOUT_BARS = { v4: 85 };

const yes = (v) => v === true || (typeof v === "string" && v.trim().toLowerCase() === "yes");
const pct = (n, d) => (d === 0 ? 0 : (n / d) * 100);
const f1 = (x) => `${x.toFixed(1)}%`;
/** Rules a reviewer failed on one image: V-keys whose value is "fail". */
const failedRules = (v) => Object.keys(v).filter((k) => /^V/.test(k) && String(v[k]).toLowerCase() === "fail");

/**
 * Score two verdict arrays. Throws on a malformed or mismatched pair. `holdout` selects the bar set.
 * @returns {{ok:boolean, cases:object[], reviewers:object[], v1:number, v2:{n:number,of:number}, v3:string[], bars:object[], single:number}}
 */
export function scoreVerdicts(a, b, { holdout = false } = {}) {
  const index = (arr, who) => {
    if (!Array.isArray(arr)) throw new Error(`${who}: expected a JSON array of verdicts`);
    const m = new Map();
    for (const v of arr) {
      if (!v || typeof v.case !== "string") throw new Error(`${who}: an entry has no "case"`);
      if (m.has(v.case)) throw new Error(`${who}: duplicate case ${v.case}`);
      if (v.V10 === undefined) throw new Error(`${who}: case ${v.case} has no V10`);
      m.set(v.case, v);
    }
    return m;
  };
  const m1 = index(a, "verdicts-1");
  const m2 = index(b, "verdicts-2");
  const only1 = [...m1.keys()].filter((c) => !m2.has(c));
  const only2 = [...m2.keys()].filter((c) => !m1.has(c));
  if (only1.length || only2.length) throw new Error(`reviewers cover different cases (only in 1: ${only1.join(" ") || "-"}; only in 2: ${only2.join(" ") || "-"})`);
  if (m1.size === 0) throw new Error("no verdicts");

  const names = [...m1.keys()].sort();
  const cases = names.map((name) => {
    const r1 = m1.get(name);
    const r2 = m2.get(name);
    const y1 = yes(r1.V10);
    const y2 = yes(r2.V10);
    return {
      case: name,
      view: name.slice(name.lastIndexOf("-") + 1),
      r1: y1 ? "yes" : "no",
      r2: y2 ? "yes" : "no",
      result: y1 && y2 ? "both" : !y1 && !y2 ? "rejected" : "split",
      failed: [y1 ? "" : `r1:${failedRules(r1).join("+") || "?"}`, y2 ? "" : `r2:${failedRules(r2).join("+") || "?"}`].filter(Boolean).join(" "),
    };
  });
  const n = cases.length;
  const yes1 = cases.filter((c) => c.r1 === "yes").length;
  const yes2 = cases.filter((c) => c.r2 === "yes").length;
  const v1 = (pct(yes1, n) + pct(yes2, n)) / 2;
  const defaults = cases.filter((c) => c.view === "default");
  const v2 = { n: defaults.filter((c) => c.result === "both").length, of: defaults.length };
  const v3 = cases.filter((c) => c.result === "rejected").map((c) => c.case);
  const single = cases.filter((c) => c.result === "split").length;

  const bars = holdout
    ? [{ bar: `V4 held-out: mean V10-yes >= ${HOLDOUT_BARS.v4}% and 0 rejected by both`, ok: v1 >= HOLDOUT_BARS.v4 && v3.length === 0, detail: `${f1(v1)} mean, ${v3.length} rejected by both` }]
    : [
        { bar: `V1 mean of the two reviewers' V10-yes rates >= ${CORE_BARS.v1}%`, ok: v1 >= CORE_BARS.v1, detail: `${f1(v1)} (r1 ${yes1}/${n}, r2 ${yes2}/${n})` },
        { bar: "V2 default views accepted by both reviewers", ok: v2.of > 0 && v2.n === v2.of, detail: `${v2.n}/${v2.of}` },
        { bar: "V3 cases rejected by both reviewers = 0", ok: v3.length === 0, detail: `${v3.length}${v3.length ? `: ${v3.join(" ")}` : ""}` },
      ];
  const reviewers = [
    { reviewer: "r1", yes: yes1, cases: n, rate: f1(pct(yes1, n)) },
    { reviewer: "r2", yes: yes2, cases: n, rate: f1(pct(yes2, n)) },
  ];
  return { ok: bars.every((x) => x.ok), cases, reviewers, v1, v2, v3, bars, single };
}

/** TOON report of a score. `holdout` only changes the heading and the bars (already in `score.bars`). */
export function renderScore(score, { holdout = false } = {}) {
  const out = [];
  out.push(`vision-score: ${score.ok ? "PASS" : "FAIL"}, ${holdout ? "holdout" : "core"}, ${score.cases.length} cases, 2 reviewers`);
  out.push(table("reviewers", score.reviewers, ["reviewer", "yes", "cases", "rate"]));
  out.push(table("cases", score.cases, ["case", "r1", "r2", "result", "failed"]));
  out.push(table("bars", score.bars.map((b) => ({ bar: b.bar, result: b.ok ? "PASS" : "FAIL", detail: b.detail })), ["bar", "result", "detail"]));
  out.push("summary:");
  out.push(`  v1_mean_yes: ${f1(score.v1)}`);
  out.push(`  v2_defaults_accepted_by_both: ${score.v2.n}/${score.v2.of}`);
  out.push(`  v3_rejected_by_both: ${score.v3.length}${score.v3.length ? ` (${score.v3.join(", ")})` : ""}`);
  out.push(`  split_one_reviewer: ${score.single}`);
  if (holdout) out.push(`  v4_holdout_mean_yes: ${f1(score.v1)}`);
  return out.join("\n");
}

function main(argv) {
  const holdout = argv.includes("--holdout");
  const rest = argv.filter((x) => x !== "--holdout");
  const bad = rest.filter((x) => x.startsWith("--"));
  if (bad.length || rest.length !== 1) {
    process.stdout.write(`error: ${bad.length ? `unknown flag ${bad[0]}` : "expected one packet directory"}\nsuggestion: node scripts/qa/vision-score.mjs <packet-dir> [--holdout]\n`);
    return 2;
  }
  const dir = resolve(rest[0]);
  const read = (name) => {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`${name} not found in ${dir}`);
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${name}: not valid JSON (${err.message})`);
    }
  };
  try {
    const score = scoreVerdicts(read("verdicts-1.json"), read("verdicts-2.json"), { holdout });
    process.stdout.write(renderScore(score, { holdout }) + "\n");
    return score.ok ? 0 : 1;
  } catch (err) {
    process.stdout.write(`error: ${err.message}\nsuggestion: save each reviewer's JSON reply as verdicts-1.json and verdicts-2.json in the packet folder\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
