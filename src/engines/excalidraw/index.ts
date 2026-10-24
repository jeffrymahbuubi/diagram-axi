// The current pipeline (parse -> layout -> buildScene -> renderScene) wrapped as the first engine
// (KTD1). No logic is copied: translate calls layout + buildScene, render calls renderScene, geometry
// returns the scene's own elements. The engine's "source" is the serialized `.excalidraw` scene; `.exd`
// is the portable DSL that translate() turns into it.

import { parse } from "../../dsl/parser.js";
import { AxiError } from "../../output/errors.js";
import { findBrowser } from "../../render/browser.js";
import type { RenderRequest, SceneData } from "../../render/outputs.js";
import type { SceneElement } from "../../quality/geom.js";
import { layout } from "../../layout/dagre-layout.js";
import { buildScene } from "../../scene/build.js";
import { serialize } from "../../scene/serialize.js";
import type { Diagnostic, Engine, EngineRenderOptions, EngineRenderResult, EngineStatus, Geometry, StatusOptions } from "../types.js";

/** `@excalidraw/utils` version the renderer bundle is built from (package.json pin). */
export const EXCALIDRAW_VERSION = "0.1.7";

const OPEN_SCENE = /^\s*\{/;

async function status(opts: StatusOptions = {}): Promise<EngineStatus> {
  try {
    const browser = await findBrowser(opts.browserPath);
    return { status: "ready", version: EXCALIDRAW_VERSION, png: "browser", path: browser.path };
  } catch {
    // Scenes still draw without a browser; only SVG/PNG rendering needs one.
    return {
      status: "browser-missing",
      version: EXCALIDRAW_VERSION,
      png: "none",
      install: "pass --browser-path <exe> or set a Chrome, Chromium, Edge or Firefox executable",
    };
  }
}

/** Parse scene text; throws AxiError when it is not a renderable `.excalidraw` scene. */
function readScene(source: string): SceneData {
  if (!OPEN_SCENE.test(source)) {
    throw new AxiError("the excalidraw engine renders a .excalidraw scene, not .exd text", "translate the graph first (draw), or pass the scene JSON");
  }
  let data: unknown;
  try {
    data = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } catch (err) {
    throw new AxiError(`scene is not valid JSON: ${(err as Error).message}`, "pass a .excalidraw scene file");
  }
  const scene = data as Partial<SceneData> | null;
  if (!scene || typeof scene !== "object" || scene.type !== "excalidraw") {
    throw new AxiError('not an Excalidraw scene (type is not "excalidraw")', "pass a .excalidraw file; for DSL input use draw");
  }
  if (!Array.isArray(scene.elements) || scene.elements.length === 0) {
    throw new AxiError("scene has no elements to render", "add nodes with draw <file.exd>");
  }
  return scene as SceneData;
}

async function validate(source: string): Promise<Diagnostic[]> {
  if (OPEN_SCENE.test(source)) {
    try {
      readScene(source);
      return [];
    } catch (err) {
      const e = err as AxiError;
      return [{ code: "invalid-scene", message: e.message, ...(e.suggestion ? { suggestion: e.suggestion } : {}) }];
    }
  }
  const { diagnostics } = parse(source);
  return diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => ({ line: d.line, col: d.col, code: d.code, message: d.message, ...(d.suggestion ? { suggestion: d.suggestion } : {}) }));
}

async function render(source: string, o: EngineRenderOptions = {}): Promise<EngineRenderResult> {
  const scene = readScene(source);
  const req: RenderRequest = {
    scene,
    png: o.png === true,
    svg: true,
    scale: o.scale ?? 1,
    padding: o.padding ?? 20,
    transparent: o.transparent === true,
    timeoutMs: o.timeoutMs ?? 30_000,
  };
  if (o.exactScale) req.exactScale = true;
  if (o.theme) req.theme = o.theme;
  if (o.browserPath) req.browserPath = o.browserPath;
  if (o.fontsUrl) req.fontsUrl = o.fontsUrl;
  // Loaded on use: the browser driver stays out of commands that never render.
  const { renderScene } = await import("../../render/render.js");
  const result = await renderScene(req);
  if (result.svg === undefined) throw new AxiError("the renderer returned no SVG", "try again; if it persists, run `render` on the scene");
  const elements = (scene.elements as SceneElement[]).filter((e) => !e.isDeleted);
  return { ...result, svg: result.svg, elements };
}

function geometry(r: EngineRenderResult): Geometry {
  return { elements: r.elements ?? [], rulesSkipped: [] };
}

export const excalidrawEngine: Engine = {
  id: "excalidraw",
  capabilities: {
    kinds: ["graph"],
    sourceExt: ".exd",
    extraExts: [".excalidraw"],
    outputs: ["excalidraw", "png", "svg"],
    sketch: true,
    layouts: [],
    inlineMarkdown: false,
    geometry: true,
  },
  status,
  translate(graph, o) {
    const direction = graph.direction ?? o.direction ?? "DOWN";
    const scene = buildScene(graph, layout({ graph, direction }), o.title === undefined ? {} : { title: o.title });
    return { source: serialize(scene), losses: [] };
  },
  validate,
  render,
  geometry,
  detectKind: () => "graph",
};
