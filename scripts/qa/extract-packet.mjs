// Vision-review packet text for scripts/qa/extract.mjs (split out to keep that file under 500 lines).
// The wording tracks what `extract` really prints: one-line hub notes (`used by N, K uses hidden`), `entry: <file>` /
// `focus: <file>` notes on folder boxes, green = entry or --focus file, `... +k more` stubs joined by plain lines.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const posix = (p) => p.split("\\").join("/");

export const CHECKLIST = [
  ["V1", "every arrow visibly starts at and ends on its nodes"],
  ["V2", "no arrowhead hidden"],
  ["V3", "every edge label (`x7`) readable, adjacent to its own arrow, not over another arrow"],
  ["V4", "no text overlapping text"],
  ["V5", "node labels fit their shapes (two-line hub labels such as `used by 20, 2 uses hidden`, and `entry: node.ts` / `focus: <file>` notes on folder boxes, included)"],
  ["V6", "groups (folders) enclose exactly their members and their titles are readable"],
  ["V7", "no arrow passes through a node"],
  ["V8", "parallel/reciprocal edges (A->B and B->A) are distinguishable"],
  ["V9", "self-loops look like loops (usually n/a: extract drops self edges)"],
  ["V10", "overall: would a human accept this diagram as is (yes/no)"],
  ["V-E1", "the entry point and its layer are identifiable (the green box: the file that starts the program, or the --focus file, and what sits above/below it)"],
  ["V-E2", "group titles read as folders (e.g. `engines/`), and a box such as `commands/ (12 files)` reads as a collapsed folder"],
];

/**
 * Markdown packet for one Sonnet vision reviewer: the PNGs (absolute paths inside `outDir`, the folder actually used),
 * the V1-V10 + V-E1/V-E2 rules and the reply format. `repos` carries each repo's `name` and `entry`.
 */
export function visionPacket(results, outDir, repos) {
  const pngDir = resolve(outDir, "png");
  const rows = results
    .filter((r) => existsSync(join(pngDir, `${r.case}.png`)))
    .map((r) => {
      const png = posix(join(pngDir, `${r.case}.png`));
      const d = r.draw ?? {};
      const entry = repos.find((p) => p.name === r.repo)?.entry;
      const note = r.duplicateOf ? `same .exd as ${r.duplicateOf} (no folder is open), judge it once` : r.view === "focus" ? entry : "-";
      return `| ${r.case} | ${r.view} | ${d.engine ?? "-"} | ${r.extract.nodes ?? "-"} nodes, ${r.extract.edges ?? "-"} edges | ${note} | \`${png}\` |`;
    });
  const views = [
    "- default: `extract <src>`; folders are groups, hubs (`used by N`) keep their box but lose incoming arrows",
    "- none: `--group none`; flat, labels are paths",
    "- focus: `--focus <entry> --depth 2`; `... +k more` stubs stand for unreached neighbours",
    "- max15: `--max-nodes 15`; folders collapse to `name/ (N files)`",
  ];
  return `# extract QA, vision review packet

You review rendered import-graph diagrams made by \`diagram-axi extract <repo> | draw --engine auto --png\`. You have the Read tool for
images only; open each PNG listed below (absolute paths) and judge it. Do not run commands, do not edit files.

## What the diagrams are

An arrow \`A -> B\` means A imports B (label \`x7\` = 7 imports; dashed = dynamic import; reciprocal \`<->\` = both ways). Boxes are
files or collapsed folders (\`utils/ (27 files)\`). Yellow = hub: its label has a one-line note \`used by N\` (and \`, K uses hidden\` when
only its heaviest outgoing arrows are drawn); its incoming arrows are hidden on purpose, so a hub without arrows is expected, not a
defect. Red = member of an import cycle. Green = the entry point of the program (package main/bin/exports or the root index) or the
\`--focus\` file: a file box carries the line \`entry\` / \`focus\`; a collapsed folder that contains it carries \`entry: <file>\` /
\`focus: <file>\`, naming the file inside (a green hub note reads \`entry, used by 20\`). Files and folders with no import arrow to the
rest of the picture are not drawn at all (the tool counts them as \`isolated\`). Boxes that would read the same carry their parent
folder (\`core/index.ts\`). The \`... +k more\` stubs of a \`focus\` view are joined to their file by a plain line without an arrowhead,
by design: they stand for k unreached neighbours, they are not arrows, so do not fail V1/V2 for a stub line. Views:

${views.join("\n")}

## Images (${rows.length})

| case | view | engine | graph | focus entry / note | png |
|---|---|---|---|---|---|
${rows.join("\n")}

## Checklist per image (pass / fail / n-a each; V10 yes / no)

${CHECKLIST.map(([k, t]) => `- ${k}: ${t}`).join("\n")}

Judge only what is drawn. Hubs losing their incoming arrows (a yellow box with no arrow on it) is by design: do not fail V1 for it, but
mention in the note when it makes the box look like a detached island, a label too crowded to read, or a picture so tall or wide that
text becomes small (say which).

## Reply format

Reply with one JSON array, nothing else, one object per image in the table order:

\`\`\`json
[
  {"case": "commander-default", "V1": "pass", "V2": "pass", "V3": "pass", "V4": "pass", "V5": "pass", "V6": "pass", "V7": "pass", "V8": "pass", "V9": "n/a", "V10": "yes", "V-E1": "pass", "V-E2": "pass", "note": "one line, empty when all pass"}
]
\`\`\`

For every fail give the failing rule, what you see and where in the \`note\` (for example "V4: 'used by 30' overlaps arrow label x4 near the top-left").
Save nothing; the caller stores the reply as verdicts-1.json / verdicts-2.json next to this packet (scripts/qa/vision-score.mjs scores them).
`;
}
