// `draw` for the d2 and mermaid engines: an `.exd` graph translated to the engine's source, or a native
// `.d2` / `.mmd` file rendered beside the input (never rewritten, KTD7). Writes <base>.d2|.mmd (translated
// only), <base>.svg always, <base>.png on --png.

import type { Direction, Graph } from "../dsl/ast.js";
import type { EngineId } from "../engines/types.js";
import { helpBlock } from "../output/suggest.js";
import { print } from "../output/toon.js";
import type { OutputFile } from "../render/outputs.js";
import {
  engineQuality, engineRenderOptions, engineSceneLine, factsOf, getEngine, layoutOf, nativeEngineLine, renderEngineFiles, checkLayoutFlag,
  writeGeometrySidecar, type Resolved,
} from "./engine-io.js";
import { TOOL, arg, diagTable, existingTargets, fail, flagBool, flagStr, outBase, outputsTable, writeTarget, type DiagRow, type RenderOptions } from "./shared.js";

type Flags = Record<string, string | boolean>;

export interface DrawEngineInput {
  file: string;
  stdin: boolean;
  out: string | undefined;
  flags: Flags;
  explicit: ReadonlySet<string>;
  opts: RenderOptions;
  engineId: EngineId;
  resolved: Resolved;
  /** Parsed `.exd` (translated sources only). */
  graph?: Graph;
  direction?: Direction;
  /** Parse warnings and kind-header warnings already collected. */
  warnings: DiagRow[];
  /** The `engine:` line to print, when it is not just the default. */
  engineLine?: string;
}

export async function drawEngine(i: DrawEngineInput): Promise<number> {
  const { flags } = i;
  const engine = await getEngine(i.engineId);
  const layoutFlag = checkLayoutFlag(engine, flags);
  const png = flagBool(flags, "png");
  const native = i.resolved.native;
  const base = outBase(i.out, i.stdin ? undefined : i.file);
  const force = flagBool(flags, "force");

  let source = i.resolved.text;
  const rows: DiagRow[] = [...i.warnings];
  let sourcePath: string | undefined;
  if (!native) {
    if (!engine.translate || !i.graph) throw new Error(`the ${engine.id} engine cannot translate .exd`);
    const target = flagStr(flags, "target") as "markdown" | "github" | "editable" | undefined;
    const tr = engine.translate(i.graph, {
      ...(i.direction ? { direction: i.direction } : {}),
      ...(layoutFlag ? { layout: layoutFlag } : {}),
      ...(flagBool(flags, "sketch") ? { sketch: true } : {}),
      ...(target ? { target } : {}),
    });
    source = tr.source;
    sourcePath = `${base}${engine.capabilities.sourceExt}`;
    for (const l of tr.losses) rows.push({ line: l.line ?? "", col: l.col ?? "", code: "engine-loss", message: `${l.code}: ${l.detail}` });
  }

  const geometryPath = flagBool(flags, "geometry-json") ? `${base}.geometry.json` : undefined;
  const targets = [...(sourcePath ? [sourcePath] : []), `${base}.svg`, ...(png ? [`${base}.png`] : []), ...(geometryPath ? [geometryPath] : [])];
  const clash = existingTargets(targets, force);
  const shown = native ? arg(i.file) : arg(sourcePath as string);
  if (clash) {
    return fail(`refusing to overwrite ${clash}`, "pass --force to replace it, or choose another --out", [], [`${TOOL} draw ${arg(i.file)} --force`, `${TOOL} inspect ${shown}`]);
  }

  const written: OutputFile[] = [];
  if (sourcePath) written.push(writeTarget({ kind: engine.id === "d2" ? "d2" : "mmd", path: sourcePath, data: source }));

  const ro = engineRenderOptions(flags, i.explicit, i.opts, png);
  const outcome = await renderEngineFiles(engine, source, ro, base, { png, svg: true });
  written.push(...outcome.files);
  const lead = native ? [`kind: ${i.resolved.kind}`] : [];
  if (outcome.error || !outcome.result) {
    const err = outcome.error;
    return fail(
      err?.message ?? "render produced no output",
      err?.suggestion,
      [...(written.length > 0 ? [outputsTable(written)] : []), ...(rows.length ? [diagTable("warnings", rows)] : [])],
      [`${TOOL} check ${shown}`, `${TOOL} syntax ${engine.id} example`],
    );
  }
  const res = outcome.result;
  if (res.warning) rows.push({ line: "", col: "", code: "render-warning", message: res.warning });

  const kind = i.resolved.kind;
  const layout = layoutOf(engine, res, kind, flags);
  if (geometryPath) writeGeometrySidecar(engine, res, kind, layout, base);
  const facts = factsOf(engine, res);
  const quality = await engineQuality(engine, res, kind, layout, flagBool(flags, "sketch"));
  const failedQuality = flagBool(flags, "strict-quality") && quality.hard;

  const lines = [failedQuality ? "draw: failed (--strict-quality), files written" : "draw: ok", ...lead];
  if (native) lines.push(nativeEngineLine(engine.id, i.resolved.sourceType));
  else if (i.engineLine) lines.push(i.engineLine);
  lines.push(
    outputsTable(written),
    engineSceneLine(facts, [...(i.direction ? [`direction ${i.direction}`] : []), `engine ${engine.id}`, ...(layout ? [`layout ${layout}`] : [])]),
    quality.block,
  );
  if (rows.length) lines.push(diagTable("warnings", rows));
  lines.push(
    helpBlock([
      `${TOOL} render ${shown} --png${png ? " --scale 2" : ""}`,
      `${TOOL} inspect ${shown}`,
      `${TOOL} syntax ${engine.id === "d2" && quality.rows.length > 0 ? "d2 style" : `${engine.id} example`}`,
    ]),
  );
  print(lines.join("\n"));
  return failedQuality ? 1 : 0;
}
