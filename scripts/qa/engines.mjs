// Engine side of the QA harness (U8, KTD5/KTD8): turns what `draw --engine <e> --svg --geometry-json` wrote
// into the one thing the shared checker reads, a scene, and masks the rules the engine cannot be measured on.
// No imports from run.mjs (run.mjs imports this file). ESM, no dependencies besides the built dist/.
//
//   engineArgs(engine, layout)      extra cli args for an engine render
//   readEngineGeometry(base)        parse <base>.geometry.json -> {engine, layout?, kind, rules_skipped[], neutral|elements}
//   sceneOf(geometry)               toScene(neutral) (dist/engines/neutral.js) or the stored elements
//   maskFindings(findings, skipped) drop findings of skipped rules
//   svgProblem(base)                null when <base>.svg exists and looks like an svg, else a reason
//   nativeSuite(engine)             the `native-<engine>` suite descriptor (test/qa/native/*.d2|.mmd)

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const ENGINES = ["excalidraw", "d2", "mermaid"];
export const DEFAULT_ENGINE = "excalidraw";
/** Layouts `--layout` accepts per engine (engines.ts capabilities). */
export const LAYOUTS = { excalidraw: [], d2: ["dagre", "elk", "tala"], mermaid: ["dagre", "elk"] };
const NATIVE_EXT = { d2: ".d2", mermaid: ".mmd" };

/** True for d2 and mermaid: the engines that go through the geometry sidecar. */
export const isEngine = (engine) => engine !== undefined && engine !== DEFAULT_ENGINE;

/** Exit-2 style validation shared by qa.mjs and fuzz.mjs: returns an error message or undefined. */
export function checkEngineArgs(engine, layout) {
  if (!ENGINES.includes(engine)) return { msg: `unknown engine ${engine}`, suggestion: `use --engine ${ENGINES.join("|")}` };
  if (layout !== undefined && !LAYOUTS[engine].includes(layout)) {
    return { msg: `--layout ${layout} does not apply to the ${engine} engine`, suggestion: LAYOUTS[engine].length ? `use --layout ${LAYOUTS[engine].join("|")}` : "drop --layout, the excalidraw engine lays out with dagre" };
  }
  return undefined;
}

/** Corpus suite of a native-source engine; the sources keep their kind in a `kind:` header comment. */
export const nativeSuite = (engine) => ({ suite: `native-${engine}`, dir: join("test", "qa", "native"), ext: NATIVE_EXT[engine], native: true });

/** Extra draw args for an engine render: forced engine, optional layout, svg, and the QA geometry sidecar. */
export function engineArgs(engine, layout) {
  return ["--engine", engine, ...(layout ? ["--layout", layout] : []), "--svg", "--geometry-json"];
}

/** Parse the sidecar. Throws with a readable message when it is missing or has no usable geometry. */
export function readEngineGeometry(base) {
  const g = JSON.parse(readFileSync(`${base}.geometry.json`, "utf8"));
  if (!g || typeof g !== "object" || !Array.isArray(g.rules_skipped)) throw new Error("geometry sidecar has no rules_skipped");
  if (!g.neutral && !Array.isArray(g.elements)) throw new Error("geometry sidecar has neither neutral nor elements");
  return g;
}

let toScenePromise;
/** Scene elements of a sidecar: `toScene(neutral)` from the built engine core, or the stored elements. */
export async function sceneOf(g) {
  if (!g.neutral) return g.elements;
  toScenePromise ??= import(pathToFileURL(join(ROOT, "dist", "engines", "neutral.js")).href).then((m) => m.toScene);
  return (await toScenePromise)(g.neutral);
}

/** Findings of rules the engine reports as not applicable never count (they are listed as rules_skipped). */
export function maskFindings(findings, skipped) {
  const s = new Set(skipped);
  return findings.filter((f) => !s.has(f.code));
}

/** A rendered svg must exist, be non-empty and start like an svg. */
export function svgProblem(base) {
  const file = `${base}.svg`;
  if (!existsSync(file)) return `${file} missing`;
  if (statSync(file).size === 0) return `${file} is empty`;
  return /<svg[\s>]/.test(readFileSync(file, "utf8").slice(0, 4096)) ? null : `${file} is not an svg`;
}

/** Rules skipped in every one of `lists` (the engine-wide mask), sorted. */
export function commonSkipped(lists) {
  if (lists.length === 0) return [];
  return lists[0].filter((r) => lists.every((l) => l.includes(r))).sort();
}
