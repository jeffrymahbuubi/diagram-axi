// In-process version of the QA gate (node scripts/qa.mjs): every file of the QA corpus is laid out and
// built in all four directions and analysed with the checker's own rules (src/quality/analyze.ts);
// no HARD finding is allowed. The checker and the corpus are read-only inputs here.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeScene } from "../src/quality/analyze.js";
import type { Direction } from "../src/dsl/ast.js";
import { parse } from "../src/dsl/parser.js";
import { layout } from "../src/layout/dagre-layout.js";
import { buildScene } from "../src/scene/build.js";

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "qa", "corpus");
const files = readdirSync(corpusDir).filter((f) => f.endsWith(".exd")).sort();
const dirs: Direction[] = ["DOWN", "RIGHT", "UP", "LEFT"];
const DIR_LINE = /^([ \t]*)(?:dir|direction)\b[ \t]*:?[ \t]*[A-Za-z]+/m;

interface Finding {
  code: string;
  severity: "hard" | "soft";
  detail: string;
}

describe.each(files)("QA corpus %s", (file) => {
  const source = readFileSync(join(corpusDir, file), "utf8");
  it.each(dirs)("has no hard layout defect (%s)", (direction) => {
    const text = DIR_LINE.test(source) ? source.replace(DIR_LINE, `$1dir ${direction}`) : source;
    const { graph } = parse(text);
    const scene = buildScene(graph, layout({ graph, direction: graph.direction ?? direction }));
    const hard = (analyzeScene(scene).findings as Finding[]).filter((f) => f.severity === "hard");
    expect(hard.map((f) => `${f.code}: ${f.detail}`)).toEqual([]);
  });
});

// Regression: dagre throws "Not possible to find intersection inside of the rectangle" on this multigraph
// (three parallel stage->mq edges plus reciprocal pairs); the layout must degrade instead of failing.
describe("crash fixture: multi-edge", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "crash-multi-edge.exd"), "utf8");
  it.each(dirs)("lays out without throwing and is hard-clean (%s)", (direction) => {
    const { graph } = parse(source);
    const scene = buildScene(graph, layout({ graph, direction }));
    const hard = (analyzeScene(scene).findings as Finding[]).filter((f) => f.severity === "hard");
    expect(hard.map((f) => `${f.code}: ${f.detail}`)).toEqual([]);
  });
});
