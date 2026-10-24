// scripts/qa/vision-score.mjs: V1-V4 from the two reviewers' verdict files (no browser, no network).

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderScore, scoreVerdicts } from "../scripts/qa/vision-score.mjs";
import { tempDir } from "./helpers/run.js";

const SCRIPT = fileURLToPath(new URL("../scripts/qa/vision-score.mjs", import.meta.url));
const VIEWS = ["default", "none", "focus", "max15"];
const REPOS = ["a", "b", "c", "d", "e", "f", "g"];
const ALL = REPOS.flatMap((r) => VIEWS.map((v) => `${r}-${v}`)); // 28 cases, 7 default views

type V = { case: string; V10: string; V3?: string; note?: string };
const verdicts = (rejected: string[] = [], failRule = "V3"): V[] =>
  ALL.map((c) => (rejected.includes(c) ? { case: c, V10: "no", [failRule]: "fail", note: "x" } : { case: c, V10: "yes" }));

describe("scoreVerdicts", () => {
  it("passes when both reviewers accept every case", () => {
    const s = scoreVerdicts(verdicts(), verdicts());
    expect(s.ok).toBe(true);
    expect(s.v1).toBe(100);
    expect(s.v2).toEqual({ n: 7, of: 7 });
    expect(s.v3).toEqual([]);
  });

  it("V1 is the mean of the per-reviewer rates, not the both-accept rate", () => {
    // r1 rejects 3 cases, r2 rejects 2 other ones: rates 25/28 and 26/28; both accept only 23/28
    const r1 = verdicts(["a-none", "b-none", "c-none"]);
    const r2 = verdicts(["d-max15", "e-max15"]);
    const s = scoreVerdicts(r1, r2);
    expect(s.v1).toBeCloseTo(((25 / 28 + 26 / 28) / 2) * 100, 6);
    expect(s.single).toBe(5);
    expect(s.bars[0]?.ok).toBe(true); // 91.1% mean, although only 23/28 = 82% are accepted by both
  });

  it("V1 bar is >= 90%: 3 rejections each (25/28 = 89.3%) fail, 2 each (92.9%) pass", () => {
    expect(scoreVerdicts(verdicts(["a-none", "b-none", "c-none"]), verdicts(["d-none", "e-none", "f-none"])).bars[0]?.ok).toBe(false);
    expect(scoreVerdicts(verdicts(["a-none", "b-none"]), verdicts(["d-none", "e-none"])).ok).toBe(true);
  });

  it("V2 needs every default view accepted by both (a split default fails)", () => {
    const s = scoreVerdicts(verdicts(["a-default"]), verdicts());
    expect(s.v2).toEqual({ n: 6, of: 7 });
    expect(s.ok).toBe(false);
    expect(s.bars.find((b: { bar: string }) => b.bar.startsWith("V2"))?.ok).toBe(false);
  });

  it("V3 lists cases rejected by both and fails the run", () => {
    const s = scoreVerdicts(verdicts(["c-focus"]), verdicts(["c-focus"], "V7"));
    expect(s.v3).toEqual(["c-focus"]);
    expect(s.ok).toBe(false);
    const text = renderScore(s);
    expect(text).toContain("vision-score: FAIL, core, 28 cases, 2 reviewers");
    expect(text).toContain("c-focus,no,no,rejected,r1:V3 r2:V7");
    expect(text).toContain("v3_rejected_by_both: 1 (c-focus)");
  });

  it("holdout uses V4: mean >= 85% and no double reject, V2 is not a bar", () => {
    // 4 single rejections per reviewer on 28 cases = 85.7%: passes; a split default view does not matter
    const r1 = verdicts(["a-default", "a-none", "b-none", "c-none"]);
    const r2 = verdicts(["d-none", "e-none", "f-none", "g-none"]);
    const s = scoreVerdicts(r1, r2, { holdout: true });
    expect(s.bars).toHaveLength(1);
    expect(s.ok).toBe(true);
    expect(renderScore(s, { holdout: true })).toContain("v4_holdout_mean_yes: 85.7%");
    // below 85%: 5 rejections each = 82.1%
    const low = scoreVerdicts(verdicts(["a-none", "b-none", "c-none", "d-none", "e-none"]), verdicts(["f-none", "g-none", "a-max15", "b-max15", "c-max15"]), { holdout: true });
    expect(low.ok).toBe(false);
    // a double reject fails even at 92.9%
    expect(scoreVerdicts(verdicts(["a-none", "b-none"]), verdicts(["a-none", "c-none"]), { holdout: true }).ok).toBe(false);
  });

  it("rejects unreadable input", () => {
    expect(() => scoreVerdicts(verdicts(), verdicts().slice(1))).toThrow(/different cases/);
    expect(() => scoreVerdicts({} as never, verdicts())).toThrow(/array/);
    expect(() => scoreVerdicts([{ case: "a-default" }] as never, [{ case: "a-default", V10: "yes" }] as never)).toThrow(/V10/);
    expect(() => scoreVerdicts([...verdicts(), { case: "a-none", V10: "yes" }], verdicts())).toThrow(/duplicate/);
  });
});

describe("vision-score cli", () => {
  const run = (args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

  it("prints TOON and exits 0 / 1 / 2", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "verdicts-1.json"), JSON.stringify(verdicts()));
    writeFileSync(join(dir, "verdicts-2.json"), JSON.stringify(verdicts()));
    const ok = run([dir]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("vision-score: PASS, core, 28 cases, 2 reviewers");
    expect(ok.stdout).toContain("reviewers[2]{reviewer,yes,cases,rate}:");
    expect(run([dir, "--holdout"]).stdout).toContain("vision-score: PASS, holdout");

    writeFileSync(join(dir, "verdicts-2.json"), JSON.stringify(verdicts(["a-default"])));
    expect(run([dir]).status).toBe(1);

    expect(run([join(dir, "missing")]).status).toBe(2);
    expect(run([dir, "--bogus"]).status).toBe(2);
    writeFileSync(join(dir, "verdicts-2.json"), "not json");
    const bad = run([dir]);
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain("not valid JSON");
  });
});
