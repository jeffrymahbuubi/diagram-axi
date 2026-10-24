// `draw <file|->`: DSL -> .excalidraw [+ png/svg], or the d2 / mermaid engines (--engine, --target, native files).
// The excalidraw engine renders only on --png/--svg; d2 and mermaid always write an SVG.

import type { CommandModule } from "../cli/router.js";
import type { Direction } from "../dsl/ast.js";
import { recommendationLine } from "../engines/route.js";
import { layout } from "../layout/dagre-layout.js";
import { buildScene } from "../scene/build.js";
import { serialize } from "../scene/serialize.js";
import { summarize } from "../scene/summary.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { print } from "../output/toon.js";
import type { OutputFile } from "../render/outputs.js";
import { drawEngine } from "./draw-engine.js";
import {
  BROWSER_PATH_FLAG, D2_PATH_FLAG, ENGINE_FLAG, GEOMETRY_JSON_FLAG, KIND_FLAG, LAYOUT_FLAG, SKETCH_FLAG, TARGET_FLAG, checkLayoutFlag, getEngine,
  quietRoute, resolveInput, routeGraph,
} from "./engine-io.js";
import {
  STRICT_QUALITY_FLAG, TOOL, type DiagRow, arg, byPosition, diagTable, displayPath, existingTargets, fail, failParse, flagBool, flagStr,
  hasHard, outBase, outputsTable, parseDsl, qualityBlock, qualityFor, readRenderOptions, renderAndWrite, renderRequest,
  sceneLine, writeTarget,
} from "./shared.js";

export const drawCommand: CommandModule = {
  spec: {
    name: "draw",
    summary: "Turn exd DSL (file or stdin) or a native .d2/.mmd file into an editable diagram file, optionally rendering PNG/SVG",
    args: [{ name: "file", required: true, description: "DSL file path (.exd, .d2, .mmd), or - to read stdin" }],
    flags: [
      { name: "out", type: "string", description: "output path without extension (default: input basename)" },
      { name: "png", type: "boolean", description: "also render <out>.png (needs an installed browser)" },
      { name: "svg", type: "boolean", description: "also render <out>.svg (needs an installed browser; d2 and mermaid always write it)" },
      ENGINE_FLAG,
      KIND_FLAG,
      TARGET_FLAG,
      SKETCH_FLAG,
      LAYOUT_FLAG,
      {
        name: "direction",
        type: "string",
        default: "DOWN",
        values: ["DOWN", "RIGHT", "UP", "LEFT"],
        description: "layout rank direction; a direction line in the DSL overrides it",
      },
      { name: "scale", type: "string", default: "1", description: "render scale factor, 0-16; PNG side is capped at 2048 px, raised (max 16384) for wide diagrams to keep text legible (d2 default 2.5)" },
      { name: "theme", type: "string", values: ["light", "dark"], description: "render theme (default: light)" },
      { name: "transparent", type: "boolean", description: "render with a transparent background" },
      { name: "padding", type: "string", default: "20", description: "render padding in px (d2 default 32)" },
      { name: "timeout", type: "string", default: "30000", description: "render deadline in ms" },
      BROWSER_PATH_FLAG,
      D2_PATH_FLAG,
      { name: "fonts-url", type: "string", description: "CJK font mirror URL, or 'none' to disable downloads" },
      { name: "force", type: "boolean", description: "overwrite existing output files" },
      STRICT_QUALITY_FLAG,
      GEOMETRY_JSON_FLAG,
    ],
    examples: [
      "diagram-axi draw diagram.exd",
      "diagram-axi draw diagram.exd --out out/arch --png --svg --direction RIGHT",
      "cat diagram.exd | diagram-axi draw - --out out/arch --png",
      "diagram-axi draw login.mmd --png",
    ],
  },
  async run(parsed) {
    const file = parsed.positionals[0]!;
    const flags = parsed.flags;
    const stdin = file === "-";
    const out = flagStr(flags, "out");
    if (stdin && !out) {
      throw new UsageError("draw - (stdin) needs --out", `cat diagram.exd | ${TOOL} draw - --out out/diagram`);
    }
    const opts = readRenderOptions(flags, parsed.explicit);
    const want = { png: flagBool(flags, "png"), svg: flagBool(flags, "svg") };

    const resolved = await resolveInput(file, flags);
    if (resolved.sourceType === "excalidraw") {
      throw new UsageError("draw reads .exd, .d2 or .mmd sources, not a .excalidraw scene", `${TOOL} render ${arg(file)} --png`);
    }
    const kindRows: DiagRow[] = resolved.kindWarning ? [{ line: "", col: "", code: "unknown-kind", message: resolved.kindWarning }] : [];
    const flagDirection = flagStr(flags, "direction") as Direction;

    if (resolved.native) {
      return drawEngine({ file, stdin, out, flags, explicit: parsed.explicit, opts, engineId: resolved.engine, resolved, warnings: kindRows });
    }

    const { graph, errors, warnings } = parseDsl(resolved.text);
    if (errors[0]) return failParse(errors[0], file);
    if (graph.nodes.length === 0) {
      return fail("the diagram is empty: no nodes found", "declare nodes, e.g. a[Start] -> b[End]", [], [`${TOOL} syntax example`, `${TOOL} syntax nodes`]);
    }

    // The DSL `dir` line wins; the flag (default DOWN) applies otherwise.
    const direction = graph.direction ?? flagDirection;
    const route = await routeGraph(graph, flags);
    const engineLine = quietRoute(route, flags) || route.explicit ? undefined : recommendationLine(route);
    const diags = byPosition(warnings);

    if (route.engine !== "excalidraw") {
      return drawEngine({
        file, stdin, out, flags, explicit: parsed.explicit, opts, engineId: route.engine, resolved, graph, direction,
        warnings: diags, ...(engineLine ? { engineLine } : {}),
      });
    }
    if (flagStr(flags, "layout") !== undefined) checkLayoutFlag(await getEngine("excalidraw"), flags);

    const scene = buildScene(graph, layout({ graph, direction }));
    const base = outBase(out, stdin ? undefined : file);
    const scenePath = `${base}.excalidraw`;

    const targets = [scenePath, ...(want.png ? [`${base}.png`] : []), ...(want.svg ? [`${base}.svg`] : [])];
    const clash = existingTargets(targets, flagBool(flags, "force"));
    if (clash) {
      return fail(`refusing to overwrite ${clash}`, "pass --force to replace it, or choose another --out", [], [`${TOOL} draw ${arg(file)} --force`, `${TOOL} inspect ${arg(scenePath)}`]);
    }

    const written: OutputFile[] = [writeTarget({ kind: "excalidraw", path: scenePath, data: serialize(scene) })];
    const summary = summarize(scene);
    const rendering = want.png || want.svg;
    const outcome = rendering ? await renderAndWrite(renderRequest(scene, want, opts), base) : undefined;
    written.push(...(outcome?.files ?? []));

    const scenePathArg = arg(scenePath);
    if (outcome?.error) {
      return fail(
        outcome.error.message,
        `${outcome.error.suggestion ?? "check the render flags"}; the ${displayPath(scenePath)} file was written`,
        [outputsTable(written), ...(diags.length ? [diagTable("warnings", diags)] : [])],
        [`${TOOL} render ${scenePathArg} --png --browser-path <exe>`, `${TOOL} inspect ${scenePathArg}`],
      );
    }

    const rows: DiagRow[] = [...kindRows, ...diags];
    if (outcome?.result?.warning) rows.push({ line: "", col: "", code: "render-warning", message: outcome.result.warning });
    // Quality never fails the draw by itself; only --strict-quality turns HARD rows into exit 1 (files are written already).
    const quality = qualityFor(scene, graph, direction);
    const failedQuality = flagBool(flags, "strict-quality") && hasHard(quality);
    const lines = [
      failedQuality ? "draw: failed (--strict-quality), files written" : "draw: ok",
      ...(engineLine ? [engineLine] : []),
      outputsTable(written),
      sceneLine(summary, [`direction ${direction}`, "engine excalidraw", "layout dagre", ...(outcome?.result ? [`browser ${outcome.result.browser}`] : [])]),
      qualityBlock(quality),
    ];
    if (rows.length) lines.push(diagTable("warnings", rows));
    lines.push(
      helpBlock([
        `${TOOL} render ${scenePathArg} --png${rendering ? " --scale 2" : ""}`,
        `${TOOL} inspect ${scenePathArg}`,
        `${TOOL} syntax ${quality.length > 0 ? "tips" : "style"}`,
      ]),
    );
    print(lines.join("\n"));
    return failedQuality ? 1 : 0;
  },
};
