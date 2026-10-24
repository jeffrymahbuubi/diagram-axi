# extract: stable wording (apply in one commit after user sign-off)

Prepared by U-H4 of `2026-10-25-extract-hardening-plan.md`. Nothing here is applied yet: every place below still says "(experimental)". Fill the `<..>` numbers from `out/qa-extract-r4/report.json` (checker) and `node scripts/qa/vision-score.mjs <packet dir>` (V1-V3 core, V4 held-out), then apply, run `npm run skill:gen`, `npm test -- --maxWorkers=4`, `npm run skill:check`, `npm run validate`.

If the vision bars fail, keep "(experimental)" and only replace the README numbers sentence with the measured ones.

## 1. README.md, section "Learn a codebase" (first sentence, currently "`extract` is **experimental** while its hardening round ...")

Replace the sentence "`extract` is **experimental** while its hardening round is being scored (...): it is clean by the layout checker, but vision review decides what a reader accepts, so check the picture. " with:

> On <28> views of 6 pinned public repos plus this one, `extract` is 28/28 clean by the layout checker (0 HARD) and vision reviewers accepted <V1>% of the pictures (default views <V2>/7); on <20> views of 5 repos it was never tuned on (axios, react-router, vue core, nest, svelte) it accepted <V4>%.

## 2. src/commands/extract.ts, `spec.summary`

Currently starts with `(experimental) Turn the import graph ...`. Remove the `(experimental) ` prefix only.

## 3. src/skill/content.ts

- `rootHelpText`, commands table row: `summary: "(experimental) TS/JS folder to an import-graph .exd plus a file map"` -> `summary: "TS/JS folder to an import-graph .exd plus a file map"`.
- `renderSkill`, the line "To learn a TS/JS codebase (experimental): ..." -> "To learn a TS/JS codebase: ..." (rest unchanged). That is 15 characters fewer, so the 1,400-token cap in `test/guide.test.ts` is not at risk.

## 4. src/guide/extract-slice.ts

No "experimental" wording there; nothing to change.

## 5. Plan bookkeeping

Fill "Results" in `2026-10-25-extract-hardening-plan.md` (checker table, V1-V4, engine decisions, HOLDOUT shas) in the same commit.
