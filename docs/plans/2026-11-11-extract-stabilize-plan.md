# Plan: `extract` from experimental to stable

Status: APPROVED by the user (2026-11-11): all 8 decisions answered with the recommended option (section 7). Planner Fable, read-only: nothing was built, rendered or tested for this plan. Builds on `2026-10-25-extract-hardening-plan.md` (Results, approved bar), `2026-10-25-extract-stable-wording.md` and the round 6 data in `out/qa-extract-r6/`.

Path chosen by the user: (1) fix the last double-reject `vitest-max15`, (2) re-run vision on corpus A with 2 Sonnet reviewers, (3) run the 5 held-out repos exactly once, (4) user sign-off, then apply the stable wording.

Approved bar (unchanged): checker 0 HARD on every case; vision V1 = mean of 2 reviewers >= 90%, V2 = default views 7/7 by both, V3 = 0 cases rejected by both; held-out V4 = mean >= 85% and 0 rejected by both, scored once.

## 1. Root cause of `vitest-max15`

### 1.1 What the round 6 data says

Measured from `out/qa-extract-r6/exd/vitest-max15.exd`, `draw/vitest-max15.excalidraw` and `report.json`:

- The view has 15 boxes but only **11 with an edge** (4 are edge-less: `assertType.ts`, `expectTypeOf.ts`, `global.ts`, `create/browser/`), and **29 edges: 2.64 edges per connected box**, with 7 arrows into `utils/` and 7 out of `node/`. 54 crossings.
- It is the densest view of the whole corpus and the only dense one drawn by excalidraw:

| case | engine (r6) | connected boxes | edges | edges/box | peak in | r6 verdict |
|---|---|---|---|---|---|---|
| commander-default | excalidraw | 8 | 14 | 1.75 | 4 | accepted |
| hono-focus | excalidraw | 8 | 12 | 1.50 | 4 | accepted |
| zod-none | excalidraw | 24 | 31 | 1.29 | 5 | accepted |
| **vitest-max15** | **excalidraw** | **11** | **29** | **2.64** | **7** | **rejected by both** |
| hono-max15 | d2 | 14 | 28 | 2.00 | 5 | accepted |
| fastify-max15 | d2 | 14 | 26 | 1.86 | 7 | accepted |
| excalidraw-max15 | d2 | 15 | 28 | 1.87 | 5 | accepted |
| self-max15 | d2 | 14 | 24 | 1.71 | 6 | accepted |

- Why it stayed on excalidraw: `denseReason` in `src/extract/density.ts` returns early when the view has fewer than `EXTRACT_DENSE_MIN_NODES` (12) connected boxes. That early return also skips the in-degree line, although its own comment says 7 arrows into one box are too many "whatever the ratio". The four edge-less boxes put this view at 11, one under the floor. `test/extract-entry.test.ts` even pins `denseReason(view(11, 40))` as undefined.
- What the reviewers saw: the excalidraw router gives each of the 29 edges its own orthogonal lane. 9 pairs of lanes of different edges run parallel 18-19 px apart for 98 to 764 px (for example `api/ -> constants.ts` beside `integrations/ -> constants.ts` for 764 px). 18 px is exactly the checker's `track-spacing` line, so the checker is silent (0 HARD, soft: `arrow-crossings`, `arrowheads-cross` only).
- The labels themselves are placed correctly: in the stored scene every label box except `x27` is at least 14 px away from any foreign segment, and neither `labels-side-by-side` nor `label-at-crossing` fires. "Labels inside bundles" is a density effect, not a placement bug.

### 1.2 Hypothesis

`vitest-max15` is a **routing gap**, not a router defect: a small but very dense view slips under the 12-box floor and lands on the engine that the hardening round already found unfit for more than 1.5 edges per box. Every other view with 1.7 to 2.0 edges per box goes to d2 and was accepted in round 6.

### 1.3 Why the lane-bundling fix was reverted

There is no record beyond one sentence in the hardening plan Results ("an attempted fix made it worse and was reverted"). The attempt was never committed: no commit, branch or stash holds it, in the public history or in the local private-history branch. What can be said from the code:

- Round 5 misread the case as a d2 view; the label-stagger fix (`a022dbd`) targeted side-by-side labels, which this picture does not have.
- The router's lanes already sit at the minimum pitch (`railPitch` 18, `portPitch` 28 in `src/layout/tune.ts`). A router fix can only widen the lanes (the scene is already 2404 px wide and scaled to 0.84, so text shrinks) or merge them (the "ambiguous labels on shared lines" reject of round 2). Either makes this picture worse. This is an inference, not a recorded finding.

Unknown until step 0 runs: whether the d2 render of this exact view is acceptable. The four comparable d2 views were accepted, which is the only evidence.

### 1.4 Second finding: reviewer files are identical

`verdicts-1.json` and `verdicts-2.json` are **byte-identical** in round 5 and in round 6 (they differ in round 4, where the notes are still word-for-word the same per case). The files were written by the orchestrator, not by the reviewers, so the "27/28 each, 0 split" numbers cannot show that two independent reviews took place. The lead confirmed it by checksum. The re-run fixes this (section 4, decision 4).

## 2. Step 0: probe before any code (lead, one browser launch)

Render the round 6 `.exd` on d2 from current `main`; this tests the hypothesis for the cost of one render:

```
npm run build
net user <user> | findstr /C:"Account active"
node bin/diagram-axi.js draw out/qa-extract-r6/exd/vitest-max15.exd --engine d2 --png --svg --geometry-json --out out/stabilize/probe/vitest-max15-d2 --force
net user <user> | findstr /C:"Account active"
```

Read the PNG and the `quality:` rows. Acceptable (no HARD, labels readable, no arrow through a box) -> units U-S1 and U-S2. Not acceptable -> one round of U-S1b (decision 3), and tell the user.

## 3. Units

Routing follows the project's `CLAUDE.md` (fosh-routing): each unit is one `sonnet-implementer` agent spawned with `isolation: "worktree"` and a prompt that names this plan file and the unit; the plan is committed before any spawn. Implementers **do not commit**: they leave their changes uncommitted in the worktree and report the worktree path, the files changed, the test summary and any deviation. The lead (Opus) copies exactly the reported files into `main`, runs the gate, and `haiku-git` commits, pushes (only on a confirmed go-ahead) and removes the worktrees. The lead owns `package.json`, the lockfile, `src/index.ts`, `outputs.ts`, `README.md` and the generated `SKILL.md`; no unit edits them.

**Dependency: the dark-theme fix (0.1.1).** It lands on `main` first and touches the d2 and mermaid translate files, `src/engines/types.ts`, `src/commands/draw-engine.ts` and `src/lint/rules.ts`. No unit below owns any of these. Spawn the units only after 0.1.1 is on `main` and its suite is green, so that every "no golden changes" gate compares against the post-0.1.1 goldens. Run step 0 after it as well (it changes the d2 translate output).

### U-S1: route small dense views to d2

- **Owns:** `src/extract/density.ts`, `test/extract-entry.test.ts`; `test/extract-layering.test.ts` and `test/cli-extract.test.ts` only where an expectation flips.
- **Does:** in `denseReason`, (a) apply the in-degree line (`peak >= EXTRACT_DENSE_IN_DEGREE`) at any box count; (b) add one small-graph line: more than `EXTRACT_SMALL_RATIO` (2.0) edges per box from `EXTRACT_SMALL_MIN_NODES` (8) connected boxes. `crowded()` and the budget retry in `aggregate.ts` stay untouched (they decide the cut, and changing them would change every `.exd`). Update the calibration comment with the round 6 row. Add tests: 11 boxes / 29 edges -> dense; 8 / 14 and 8 / 12 -> undefined; in-degree 7 on 9 boxes -> dense, 6 -> undefined.
- **Must not:** add a source file or an import (the `self` corpus views scan this repo's `src/`), touch any engine or layout code.
- **Gate (browser-free):** `npm run build`, then `npx vitest run test/extract-entry.test.ts test/extract-layering.test.ts test/extract-aggregate.test.ts test/extract-emit.test.ts test/cli-extract.test.ts --maxWorkers=4`. `git diff --stat test/golden` must be empty: no golden may change, because the `.exd` output does not depend on the engine line. The unit report lists every test expectation it changed and why, and the engine each of the 28 round 6 `.exd` files now gets (expected: only `vitest-max15` moves, excalidraw -> d2; computed by running `extract` on the corpus clones, no draw).
- **Hard rules (in the brief):** this unit starts no browser. If a browser run is ever needed: persistent Chrome profile slot pool only, concurrency <= 4 slots, `--jobs` <= 3, never set `DIAGRAM_AXI_CHROME_PROFILE=temp`, after any browser batch run `net user <user> | findstr /C:"Account active"` and stop everything if it says Locked. Never kill processes by image name (no `taskkill /IM node.exe` or `chrome.exe`); kill only your own PIDs. Do not commit: leave the changes uncommitted in the worktree and report the worktree path and the files changed. Never push. Do not open or clone the held-out repos.

### U-S2: QA evidence tooling

- **Owns:** `scripts/qa/vision-score.mjs`, `scripts/qa/extract.mjs`, `scripts/qa/extract-packet.mjs`, `test/vision-score.test.ts`, `test/qa-extract.test.ts`.
- **Does:** (a) `vision-score.mjs` exits 2 when the two verdict files are byte-identical, and prints the count of split cases; (b) the packet's last sentence says the reply is stored verbatim; (c) `extract.mjs` adds a report-only observation `laneBundles` per case (pairs of parallel segments of different edges closer than 24 px for more than 150 px; `vitest-max15` on excalidraw measures 9) so the next round has a number for this defect. No new bar, no new checker rule. Keep both scripts under 500 lines.
- **Gate (browser-free):** `npx vitest run test/vision-score.test.ts test/qa-extract.test.ts test/qa.test.ts --maxWorkers=4`; `node scripts/qa/vision-score.mjs out/qa-extract-r6` must now exit 2 (identical files), and `out/qa-extract-r4` (different files) must still be scored as before (exit 1: its bars failed).
- **Hard rules (in the brief):** this unit starts no browser and runs no QA batch. If a browser run is ever needed: persistent Chrome profile slot pool only, concurrency <= 4 slots, `--jobs` <= 3, never set `DIAGRAM_AXI_CHROME_PROFILE=temp`, after any browser batch run `net user <user> | findstr /C:"Account active"` and stop everything if it says Locked. Never kill processes by image name (no `taskkill /IM node.exe` or `chrome.exe`); kill only your own PIDs. Do not commit: leave the changes uncommitted in the worktree and report the worktree path and the files changed. Never push. Do not open or clone the held-out repos.

### U-S1b (only if step 0 fails; decision 3): excalidraw label placement

- **Owns:** `src/layout/labels.ts` (and `src/layout/tune.ts` for a new constant), `test/layout*.test.ts`, `test/golden/*.excalidraw`.
- **Does:** one cost term in `placeLabels`: a label prefers a stretch of its own route with no foreign parallel lane within 30 px, accepted only where every existing penalty is no worse (the pattern of the polish pass in `a022dbd`). Lanes are not moved. The unit report records what was tried and what it changed, so the next reader is not left with one sentence again.
- **Gate:** `npm test -- --maxWorkers=4` (one run at a time on the machine, see section 6); only `test/golden/*.excalidraw` may change, each diff explained (label `x`/`y` only); `node scripts/qa.mjs --jobs 3` before and after: HARD count and every per-rule soft count must not rise; `test/golden/d2/**` and `test/golden/mermaid/**` must not change.
- **Hard rules (in the brief):** every local browser run goes through the persistent Chrome profile slot pool, concurrency <= 4 slots, `--jobs` <= 3, never set `DIAGRAM_AXI_CHROME_PROFILE=temp`; after any browser batch run `net user <user> | findstr /C:"Account active"` and stop everything if it says Locked. Never kill processes by image name (no `taskkill /IM node.exe` or `chrome.exe`); kill only your own PIDs. Do not commit: leave the changes uncommitted in the worktree and report the worktree path and the files changed. Never push. Do not open or clone the held-out repos.

### U-S3 (after user sign-off; done by the lead, not an implementer): stable wording

- **Owns:** `README.md` (extract section), `src/commands/extract.ts` (`spec.summary`), `src/skill/content.ts`, generated `skills/diagram-axi/SKILL.md`, both plan files' Results. These are lead-owned or one-line edits, so the lead makes them itself and `haiku-git` commits; nothing else runs meanwhile.
- **Does:** applies `2026-10-25-extract-stable-wording.md` with the measured numbers (checker from `out/qa-extract-r7/report.json`, V1-V3 and V4 from `vision-score.mjs`; the wording file's `out/qa-extract-r4` path is outdated), `npm run skill:gen`, one commit. Then the installed skill copies are re-synced (project memory note).
- **Gate:** `npm test -- --maxWorkers=4`, `npm run skill:check`, `npm run validate`.
- **Hard rules (apply to the lead too):** every local browser run (the test suite launches Chrome) goes through the persistent Chrome profile slot pool, concurrency <= 4 slots, `--jobs` <= 3, never set `DIAGRAM_AXI_CHROME_PROFILE=temp`; after any browser batch run `net user <user> | findstr /C:"Account active"` and stop everything if it says Locked. Never kill processes by image name (no `taskkill /IM node.exe` or `chrome.exe`); kill only your own PIDs. Never push without the user's go-ahead.

### Merge gate (lead, after U-S1 and U-S2)

Copy in U-S1's reported files, then U-S2's (the file sets are disjoint; check `git status` shows only owned files); `npm test -- --maxWorkers=4`; `npm run skill:check`; `git diff --stat <base> -- test/golden` empty; account check; then `haiku-git` commits one commit per unit. This full suite is the d2 and mermaid regression guard: no engine, layout or translate file changes on this path, and the goldens of all three engines are byte-compared.

## 4. QA sequence (lead; exact commands)

Every browser batch is preceded and followed by `net user <user> | findstr /C:"Account active"`; anything but `Yes` stops all work, agents included.

1. **Core run (round 7).** `npm run build`, then `node scripts/qa/extract.mjs --set core --jobs 3 --out out/qa-extract-r7`. Bar: exit 0 (28/28 0 HARD, lints silent).
2. **Regression check on the other 27.** Compare `out/qa-extract-r7/exd/*.exd` with `out/qa-extract-r6/exd/`: the 24 non-`self` files must be byte-identical; `self-*` may differ only by what changed in `src/` since round 6 (list it; the 0.1.1 dark-theme fix is one such change). Engine column: only `vitest-max15` differs. Per case, `hard` stays 0 and `soft` does not rise against round 6; a rise is looked at before the reviewers start.
3. **Vision, corpus A.** Two fresh reviewers in parallel, read-only, image Read only. The routing hook allows only the routed agent types and read-only helpers, and an implementer prompt must cite a plan file; this plan names the fixed case, so a reviewer must not be given it. Use a read-only helper type with the packet as the whole prompt, and record the reviewer model in Results (the earlier rounds used Sonnet; if the helper runs on another model, say so next to the numbers). Each gets `out/qa-extract-r7/vision-packet.md` and nothing else: no earlier verdicts, no hint which case was fixed, no hypothesis. The orchestrator stores each raw reply verbatim as `verdicts-1.json` / `verdicts-2.json` (code fences stripped, nothing reworded). Then `node scripts/qa/vision-score.mjs out/qa-extract-r7`. Bar: V1 >= 90%, V2 7/7, V3 0.
4. **If the core bar fails:** see decision 6. The held-out set is not run.
5. **Held-out, once.** `node scripts/qa/extract.mjs --set holdout --clone-only` (network, no browser) prints `entry_exists` for the 3 entries marked `verify`; a wrong path is fixed from the file listing only (decision 7), committed, and logged. Then, with the code frozen: `node scripts/qa/extract.mjs --set holdout --jobs 3 --out out/qa-extract-holdout-r1`. Nobody looks at the held-out PNGs before the reviewers. Two fresh reviewers as in step 3, then `node scripts/qa/vision-score.mjs out/qa-extract-holdout-r1 --holdout`. Bar: checker 20/20 0 HARD, V4 mean >= 85%, 0 rejected by both.
6. **"Exactly once" means:** the first run that renders all 20 cases is the score. A run aborted by a lock, a crash or a failed clone is not a score and may be restarted, but no source file changes between the abort and the restart.
7. **Sign-off.** The user gets the numbers, `out/qa-extract-r7/png/`, `out/qa-extract-holdout-r1/png/` and every reviewer note on a non-accepted case (local gallery from the project's dashboard kit on request; no hosted pages). After a yes: U-S3. Push only on the user's go-ahead.

Not re-run, with reason: the usefulness eval (`scripts/extract-eval.mjs`) reads `.exd` text, which this fix does not change; the d2 and mermaid curated QA (`scripts/qa.mjs --engine d2|mermaid`), because no engine file changes on the routing path (it becomes mandatory if U-S1b runs).

## 5. If a bar fails

- **Step 0 fails** (the d2 render of `vitest-max15` is not acceptable): one round of U-S1b, then the same QA sequence; if that round fails its gates or the picture is still rejected, `extract` stays experimental.
- **Corpus A fails after the fix:** one more targeted fix round on corpus A (this would be round 8), then stop; `extract` stays experimental with the round 7/8 numbers (decision 6).
- **Held-out fails** (HARD on any case, V4 < 85%, or a double-reject): the 5 repos join corpus A as tuning data. At most **one** fix round on A + B, then two fresh pinned repos (the hardening plan named `unjs/h3` and `pmndrs/zustand`) are scored once as the new held-out. A second failure ends the effort: `extract` stays experimental, the README numbers sentence is updated with the measured ones, nothing else changes (decision 5).
- In every failure case the wording file's rule applies: keep "(experimental)" and replace only the numbers.

## 6. Concurrency limits

- At most 2 writing agents at once (U-S1 and U-S2), each in its own worktree; U-S1b and U-S3 run alone.
- **One browser consumer on the machine at a time.** `npm test` launches Chrome through the slot pool, so the full suite is run by one party at a time (the orchestrator at the merge gate, or U-S1b / U-S3 alone). U-S1 and U-S2 run only the browser-free test files named in their gates.
- QA scripts `--jobs 3`, vitest `--maxWorkers=4`, Chrome profile slots <= 4, never the temp profile.
- 2 vision reviewers at once; they start no process.
- Check the usage quota before spawning; near the limit, stop agents (their uncommitted worktrees stay in place; list them in the handoff) and write the handoff.
- A locked agent worktree at `main` HEAD existed when this plan was written; confirm it is not in use and remove it before spawning.

## 7. Decisions (user, 2026-11-11; do not re-ask)

All 8 open questions were answered with the recommended option.

1. **Fix for `vitest-max15`:** route small dense views to d2 (U-S1). No engine or layout code changes on this path.
2. **Routing rule:** in-degree >= 7 at any box count, plus more than 2.0 edges per box from 8 connected boxes (one new constant pair). The 12-box floor and the budget retry stay as they are.
3. **Step 0 probe fails:** one round of U-S1b (label placement prefers stretches without a parallel neighbour; lanes untouched), with the excalidraw and d2 QA gates.
4. **Reviewer evidence:** two fresh, independent reviewers; raw replies stored verbatim; the scorer refuses byte-identical verdict files.
5. **Held-out fails:** one fix round on A + B, then two fresh held-out repos scored once; a second failure keeps `extract` experimental.
6. **Corpus A fails again in round 7:** one more targeted fix round, then stop and stay experimental.
7. **Held-out focus entries marked `verify`:** a wrong path is corrected from the file listing only, before the scored run, and logged.
8. **Release:** stable wording in one commit, push at this milestone, publish 0.2.0 (after the 0.1.1 dark-theme release) once the user approves the publish.

## 8. Open questions

None.

## Results

(none yet)
