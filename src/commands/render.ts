// `render <scene>`: .excalidraw -> png/svg with an installed browser; native .d2/.mmd render through their engine.

import { readFileSync } from "node:fs";
import type { Parsed } from "../cli/args.js";
import type { CommandModule } from "../cli/router.js";
import { detectSource, resolveEngine } from "../engines/detect.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { print } from "../output/toon.js";
import type { SceneData } from "../render/outputs.js";
import { summarize } from "../scene/summary.js";
import {
  BROWSER_PATH_FLAG, D2_PATH_FLAG, ENGINE_FLAG, KIND_FLAG, LAYOUT_FLAG, SKETCH_FLAG, checkLayoutFlag, engineRenderOptions, engineSceneLine, factsOf, getEngine,
  layoutOf, renderEngineFiles, resolveInput,
} from "./engine-io.js";
import {
  TOOL, arg, diagTable, displayPath, fail, flagBool, flagStr, outBase, outputsTable, readRenderOptions, renderAndWrite, renderRequest, sceneLine, type RenderOptions,
} from "./shared.js";

export const renderCommand: CommandModule = {
  spec: {
    name: "render",
    summary: "Render an existing .excalidraw file, or a native .d2/.mmd file, to PNG and/or SVG",
    args: [{ name: "scene", required: true, description: ".excalidraw, .d2 or .mmd file path" }],
    flags: [
      { name: "png", type: "boolean", description: "write <out>.png" },
      { name: "svg", type: "boolean", description: "write <out>.svg" },
      { name: "out", type: "string", description: "output path without extension (default: scene basename)" },
      ENGINE_FLAG,
      KIND_FLAG,
      SKETCH_FLAG,
      LAYOUT_FLAG,
      { name: "scale", type: "string", default: "1", description: "render scale factor, 0-16; PNG side is capped at 2048 px, raised (max 16384) for wide diagrams to keep text legible (d2 default 2.5)" },
      { name: "theme", type: "string", values: ["light", "dark"], description: "render theme (default: from scene, else light)" },
      { name: "transparent", type: "boolean", description: "render with a transparent background" },
      { name: "padding", type: "string", default: "20", description: "render padding in px (d2 default 32)" },
      { name: "timeout", type: "string", default: "30000", description: "render deadline in ms" },
      BROWSER_PATH_FLAG,
      D2_PATH_FLAG,
      { name: "fonts-url", type: "string", description: "CJK font mirror URL, or 'none' to disable downloads" },
    ],
    examples: [
      "diagram-axi render out/arch.excalidraw --png",
      "diagram-axi render out/arch.excalidraw --png --svg --scale 2 --theme dark",
      "diagram-axi render order.d2 --png --sketch",
    ],
  },
  async run(parsed) {
    const file = parsed.positionals[0]!;
    const flags = parsed.flags;
    const want = { png: flagBool(flags, "png"), svg: flagBool(flags, "svg") };
    if (!want.png && !want.svg) {
      throw new UsageError("nothing to render: pass --png and/or --svg", `${TOOL} render ${arg(file)} --png`);
    }
    const opts = readRenderOptions(flags, parsed.explicit);

    const detected = detectSource(file);
    if (detected) resolveEngine(detected, flagStr(flags, "engine"));
    if (detected?.sourceType === "exd") {
      return fail(`'${displayPath(file)}' is DSL source, not a scene`, `use draw: ${TOOL} draw ${arg(file)} --png`, [], [`${TOOL} draw ${arg(file)} --png`, `${TOOL} syntax example`]);
    }
    if (detected?.sourceType === "d2" || detected?.sourceType === "mmd") return renderNative(file, parsed, opts, want);

    const loaded = loadScene(file);
    if (!("scene" in loaded)) {
      return fail(loaded.message, loaded.suggestion, [], [`${TOOL} inspect ${arg(file)}`, `${TOOL} syntax example`]);
    }
    const { scene } = loaded;
    // Re-rendering replaces the derived PNG/SVG next to the scene; render has no --force.
    const outcome = await renderAndWrite(renderRequest(scene, want, opts), outBase(flagStr(flags, "out"), file));
    if (outcome.error || !outcome.result) {
      const err = outcome.error;
      return fail(
        err?.message ?? "render produced no output",
        err?.suggestion,
        [],
        [`${TOOL} render ${arg(file)} --png --browser-path <exe>`, `${TOOL} inspect ${arg(file)}`],
      );
    }

    const lines = ["render: ok", outputsTable(outcome.files), sceneLine(summarize(scene), [`browser ${outcome.result.browser}`])];
    if (outcome.result.warning) {
      lines.push(diagTable("warnings", [{ line: "", col: "", code: "render-warning", message: outcome.result.warning }]));
    }
    lines.push(
      helpBlock([
        `${TOOL} render ${arg(file)} ${want.png ? "--svg" : "--png"} --scale 2`,
        `${TOOL} inspect ${arg(file)}`,
        `${TOOL} syntax style`,
      ]),
    );
    print(lines.join("\n"));
    return 0;
  },
};

/** `.d2` / `.mmd`: rendered by their engine beside the input; the source is never rewritten. */
async function renderNative(file: string, parsed: Parsed, opts: RenderOptions, want: { png: boolean; svg: boolean }): Promise<number> {
  const flags = parsed.flags;
  const resolved = await resolveInput(file, flags);
  const engine = await getEngine(resolved.engine);
  checkLayoutFlag(engine, flags);
  const outcome = await renderEngineFiles(engine, resolved.text, engineRenderOptions(flags, parsed.explicit, opts, want.png), outBase(flagStr(flags, "out"), file), want);
  if (outcome.error || !outcome.result) {
    const err = outcome.error;
    return fail(
      err?.message ?? "render produced no output",
      err?.suggestion,
      outcome.files.length > 0 ? [outputsTable(outcome.files)] : [],
      [`${TOOL} check ${arg(file)}`, `${TOOL} syntax ${engine.id} example`],
    );
  }
  const res = outcome.result;
  const layout = layoutOf(engine, res, resolved.kind, flags);
  const lines = ["render: ok", `kind: ${resolved.kind}`, outputsTable(outcome.files), engineSceneLine(factsOf(engine, res), [`engine ${engine.id}`, ...(layout ? [`layout ${layout}`] : [])])];
  const rows = [...(resolved.kindWarning ? [{ line: "", col: "", code: "unknown-kind", message: resolved.kindWarning }] : []), ...(res.warning ? [{ line: "", col: "", code: "render-warning", message: res.warning }] : [])];
  if (rows.length) lines.push(diagTable("warnings", rows));
  lines.push(helpBlock([`${TOOL} render ${arg(file)} ${want.png ? "--svg" : "--png"} --scale 2`, `${TOOL} inspect ${arg(file)}`, `${TOOL} draw ${arg(file)} --png --force`]));
  print(lines.join("\n"));
  return 0;
}

/** Loads and validates a scene file; returns the scene, or a message and suggestion. */
function loadScene(file: string): { scene: SceneData } | { message: string; suggestion: string } {
  const name = displayPath(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (err as Error).message;
    return { message: `cannot read '${name}': ${reason}`, suggestion: "check the path; create a scene with draw <file.exd>" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return { message: `'${name}' is not valid JSON: ${(err as Error).message}`, suggestion: "pass a .excalidraw scene file; for DSL input use draw" };
  }
  const scene = data as Partial<SceneData> | null;
  if (!scene || typeof scene !== "object" || scene.type !== "excalidraw") {
    return { message: `'${name}' is not an Excalidraw scene (type is not "excalidraw")`, suggestion: "pass a .excalidraw file; for DSL input use draw" };
  }
  if (!Array.isArray(scene.elements) || scene.elements.length === 0) {
    return { message: `'${name}' has no elements to render`, suggestion: "add nodes with draw <file.exd>, or draw something in Excalidraw first" };
  }
  return { scene: scene as SceneData };
}
