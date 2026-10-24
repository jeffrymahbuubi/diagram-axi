// `check <file>`: parse + semantic lint of an .exd file with line:col diagnostics, or a full engine
// compile/parse of a native .d2 / .mmd file. For .exd, errors come from the parser (it stops at the first
// one) and warnings are the parser's implicit-node plus the lint in src/lint/rules.ts; an `engine:` line
// recommends the engine (KTD4), and an explicit engine also validates the translation.

import type { CommandModule } from "../cli/router.js";
import type { Diagnostic, DiagnosticCode, Graph } from "../dsl/ast.js";
import { layout } from "../layout/dagre-layout.js";
import { recommendationLine } from "../engines/route.js";
import { STRICT_EXEMPT, lint } from "../lint/rules.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import { buildScene } from "../scene/build.js";
import { BROWSER_PATH_FLAG, ENGINE_FLAG, KIND_FLAG, TARGET_FLAG, getEngine, nativeEngineLine, quietRoute, resolveInput, routeGraph, type Resolved } from "./engine-io.js";
import {
  STRICT_QUALITY_FLAG, TOOL, arg, byPosition, diagTable, displayPath, flagBool, flagStr, hasHard, parseDsl, plural, qualityBlock, qualityFor,
} from "./shared.js";

type Flags = Record<string, string | boolean>;

const ENGINE_DIAG_FIELDS = ["line", "col", "endCol", "code", "message", "suggestion"];

/** `.d2` / `.mmd`: the engine's full compile or parse, all errors in one pass. */
async function checkNative(file: string, flags: Flags, r: Resolved): Promise<number> {
  const engine = await getEngine(r.engine);
  const browserPath = flagStr(flags, "browser-path");
  const diags = await engine.validate(r.text, browserPath ? { browserPath } : {});
  const at = (d: { line?: number; col?: number }): number => (d.line ?? 0) * 100000 + (d.col ?? 0);
  const rows = (list: typeof diags): Array<Record<string, unknown>> =>
    [...list].sort((a, b) => at(a) - at(b)).map((d) => ({ line: d.line, col: d.col, endCol: d.endCol, code: d.code, message: d.message, suggestion: d.suggestion }));
  const errors = rows(diags.filter((d) => d.severity !== "warning"));
  const warned = diags.filter((d) => d.severity === "warning");
  if (r.kindWarning) warned.push({ code: "unknown-kind", message: r.kindWarning });
  const warnings = rows(warned);
  const strict = flagBool(flags, "strict");
  const failed = errors.length > 0 || (strict && warnings.length > 0);
  const verdict = errors.length > 0 ? "failed" : failed ? "failed (--strict)" : "ok";
  const lines = [
    `check: ${verdict}, ${plural(errors.length, "error")}, ${plural(warnings.length, "warning")} in ${displayPath(file)}`,
    `kind: ${r.kind}`,
    nativeEngineLine(engine.id, r.sourceType),
  ];
  if (errors.length > 0) lines.push(emitList("errors", errors, ENGINE_DIAG_FIELDS));
  if (warnings.length > 0) lines.push(emitList("warnings", warnings, ENGINE_DIAG_FIELDS));
  lines.push(helpBlock(errors.length > 0 ? [`${TOOL} syntax ${engine.id} example`, `${TOOL} check ${arg(file)}`] : [`${TOOL} draw ${arg(file)} --png`, `${TOOL} inspect ${arg(file)}`]));
  print(lines.join("\n"));
  return failed ? 1 : 0;
}

/** An explicit engine: translate the graph and validate the translation; the losses are listed. */
async function checkTranslation(graph: Graph, engineId: string, flags: Flags): Promise<{ lines: string[]; failed: boolean }> {
  const engine = await getEngine(engineId);
  if (!engine.translate) return { lines: [], failed: false };
  const target = flagStr(flags, "target") as "markdown" | "github" | "editable" | undefined;
  const tr = engine.translate(graph, { ...(graph.direction ? { direction: graph.direction } : {}), ...(target ? { target } : {}) });
  const browserPath = flagStr(flags, "browser-path");
  const diags = (await engine.validate(tr.source, browserPath ? { browserPath } : {})).filter((d) => d.severity !== "warning");
  const lines = [
    diags.length === 0
      ? `translation: ok (${engine.id}, ${plural(tr.source.split("\n").length, "line")})`
      : `translation: failed (${engine.id}), ${plural(diags.length, "error")} in the translated source`,
  ];
  if (diags.length > 0) {
    const rows = diags.map((d) => ({ line: d.line, col: d.col, endCol: d.endCol, code: d.code, message: d.message, suggestion: d.suggestion }));
    lines.push(emitList("translation-errors", rows, ENGINE_DIAG_FIELDS));
  }
  if (tr.losses.length > 0) lines.push(emitList("losses", tr.losses.map((l) => ({ code: l.code, detail: l.detail })), ["code", "detail"]));
  return { lines, failed: diags.length > 0 };
}


// Suggestion order: new authoring lints by impact, then the older size lints, then everything else
// (implicit-node comes last: it is the most frequent and the least useful fix).
const SUGGESTION_RANK: readonly DiagnosticCode[] = [
  "parallel-edges", "busy-node", "diamond-hub", "dense-graph", "wordy-edge-label", "reciprocal-pair", "many-nodes",
  "too-many-nodes", "deep-nesting", "long-label",
];
const rankOf = (code: DiagnosticCode): number => {
  const i = SUGGESTION_RANK.indexOf(code);
  return i >= 0 ? i : code === "implicit-node" ? SUGGESTION_RANK.length + 1 : SUGGESTION_RANK.length;
};

/** The suggestion to print: the first error, else the highest-ranked warning that has one (ties keep position order). */
export function topSuggestion(errors: Diagnostic[], warnings: Diagnostic[]): string | undefined {
  const err = errors.find((d) => d.suggestion);
  if (err) return err.suggestion;
  const ranked = warnings.filter((d) => d.suggestion).sort((a, b) => rankOf(a.code) - rankOf(b.code));
  return ranked[0]?.suggestion;
}

/** Lays the graph out (no files written) and returns the quality block plus whether it has a HARD row. */
function qualityOf(graph: Graph): { block: string; hard: boolean } {
  if (graph.nodes.length === 0) return { block: "quality: ok", hard: false };
  try {
    const direction = graph.direction ?? "DOWN";
    const rows = qualityFor(buildScene(graph, layout({ graph, direction })), graph, direction);
    return { block: qualityBlock(rows), hard: hasHard(rows) };
  } catch (err) {
    return { block: `quality: unavailable, layout failed (${(err as Error).message})`, hard: false };
  }
}

export const checkCommand: CommandModule = {
  spec: {
    name: "check",
    summary: "Lint an .exd DSL file, or compile-check a native .d2/.mmd file: errors exit 1, warnings exit 0 unless --strict",
    args: [{ name: "file", required: true, description: "DSL file path (.exd, .d2, .mmd), or - to read stdin" }],
    flags: [
      { name: "strict", type: "boolean", description: "treat warnings as errors (exit 1)" },
      ENGINE_FLAG,
      KIND_FLAG,
      TARGET_FLAG,
      BROWSER_PATH_FLAG,
      STRICT_QUALITY_FLAG,
    ],
    examples: [
      "diagram-axi check diagram.exd",
      "diagram-axi check diagram.exd --strict",
      "diagram-axi check login.d2",
    ],
  },
  async run(parsed) {
    const file = parsed.positionals[0]!;
    const strict = flagBool(parsed.flags, "strict");
    const resolved = await resolveInput(file, parsed.flags);
    if (resolved.sourceType === "excalidraw") {
      throw new UsageError("check reads .exd, .d2 or .mmd sources, not a .excalidraw scene", `${TOOL} inspect ${arg(file)}`);
    }
    if (resolved.native) return checkNative(file, parsed.flags, resolved);
    const { graph, errors, warnings } = parseDsl(resolved.text);

    const errorRows = byPosition(errors);
    const warningRows = byPosition(errors.length === 0 ? [...warnings, ...lint(graph)] : warnings);
    const strictRows = warningRows.filter((w) => !STRICT_EXEMPT.has(w.code));
    const quality = errorRows.length === 0 ? qualityOf(graph) : undefined;
    const failedQuality = flagBool(parsed.flags, "strict-quality") && quality?.hard === true;
    const failedStrict = strict && strictRows.length > 0;
    const usable = errorRows.length === 0 && graph.nodes.length > 0;
    const route = usable ? await routeGraph(graph, parsed.flags) : undefined;
    const translation = usable && route?.explicit && route.engine !== "excalidraw" ? await checkTranslation(graph, route.engine, parsed.flags) : undefined;
    const failed = errorRows.length > 0 || failedStrict || failedQuality || translation?.failed === true;
    const where = file === "-" ? "stdin" : displayPath(file);

    const verdict = errorRows.length > 0 ? "failed" : failedStrict ? "failed (--strict)" : failedQuality ? "failed (--strict-quality)" : translation?.failed ? "failed (translation)" : "ok";
    const lines = [`check: ${verdict}, ${plural(errorRows.length, "error")}, ${plural(warningRows.length, "warning")} in ${where}`];
    if (quality) lines.push(quality.block);
    // A fitting graph on the default engine says nothing (keeps the golden output); suggestions and forced engines are always shown.
    if (route && !route.explicit && !quietRoute(route, parsed.flags)) lines.push(recommendationLine(route));
    if (translation) lines.push(...translation.lines);
    if (errorRows.length > 0) lines.push(diagTable("errors", errorRows));
    if (warningRows.length > 0) lines.push(diagTable("warnings", warningRows));
    const suggestion = topSuggestion(errorRows, warningRows);
    if (suggestion) lines.push(`suggestion: ${suggestion}`);

    const named = file === "-" ? "<file.exd>" : arg(file);
    const help =
      errorRows.length > 0
        ? [`${TOOL} syntax ${errorRows[0]!.code === "unknown-color" || errorRows[0]!.code === "unknown-flag" ? "style" : "nodes"}`, `${TOOL} syntax example`]
        : strictRows.length > 0 && !strict
          ? [`${TOOL} check ${named} --strict`, `${TOOL} draw ${named} --png`]
          : [`${TOOL} draw ${named} --png`, `${TOOL} inspect ${named}`];
    if (new Set(warningRows.map((w) => w.code)).size > 1 || quality?.block.startsWith("quality[")) help.push(`${TOOL} syntax tips`);
    lines.push(helpBlock(help));
    print(lines.join("\n"));
    return failed ? 1 : 0;
  },
};
