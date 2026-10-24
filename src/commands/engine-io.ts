// Engine plumbing shared by draw, render, check and inspect: the flag specs, source resolution (R3),
// lazy engine access, render options, the render-to-files step (with the PNG fallbacks of AE4), the
// quality block for engine geometry and the scene facts. Engines are only reached through the registry.

import type { FlagSpec } from "../cli/spec.js";
import type { Graph } from "../dsl/ast.js";
import { detectKind, detectSource, resolveEngine, type SourceType } from "../engines/detect.js";
import type { RouteResult, Target } from "../engines/route.js";
import { KINDS, type Engine, type EngineId, type EngineRenderOptions, type EngineRenderResult, type Kind } from "../engines/types.js";
import { AxiError, UsageError } from "../output/errors.js";
import type { OutputFile } from "../render/outputs.js";
import { analyzeScene } from "../quality/analyze.js";
import type { QualityRow } from "../quality/hints.js";
import { TOOL, flagBool, flagStr, qualityBlock, readSource, writeTarget, type RenderOptions } from "./shared.js";

type Flags = Record<string, string | boolean>;

// ---- flag specs ----

export const ENGINE_FLAG: FlagSpec = {
  name: "engine",
  type: "string",
  values: ["excalidraw", "d2", "mermaid", "auto"],
  description: "render engine; auto applies the engine line's suggestion (.d2 and .mmd files pick their own)",
};
export const KIND_FLAG: FlagSpec = {
  name: "kind",
  type: "string",
  values: [...KINDS],
  description: "diagram kind of a native source (default: a kind: header comment, else the first keyword)",
};
export const TARGET_FLAG: FlagSpec = {
  name: "target",
  type: "string",
  values: ["markdown", "github", "editable"],
  description: "where the diagram will live: markdown/github force mermaid, editable forces excalidraw",
};
export const SKETCH_FLAG: FlagSpec = { name: "sketch", type: "boolean", description: "hand-drawn strokes (d2 sketch, mermaid handDrawn)" };
export const LAYOUT_FLAG: FlagSpec = { name: "layout", type: "string", description: "d2: dagre|elk|tala (default elk); mermaid: dagre|elk (default elk)" };
export const D2_PATH_FLAG: FlagSpec = { name: "d2-path", type: "string", description: "d2 v0.9.0 binary for browser-less PNG (env DIAGRAM_AXI_D2_PATH)" };
export const BROWSER_PATH_FLAG: FlagSpec = {
  name: "browser-path",
  type: "string",
  description: "Chrome/Edge/Chromium/Firefox executable (env DIAGRAM_AXI_BROWSER_PATH)",
};
/** QA-only: writes the neutral model next to the output (scripts/qa reads it). */
export const GEOMETRY_JSON_FLAG: FlagSpec = { name: "geometry-json", type: "boolean", hidden: true, description: "write <out>.geometry.json (QA only)" };

// ---- engine access ----

let touched = false;

/** The engine with this id. Loaded on use so commands that never render skip the browser driver and WASM. */
export async function getEngine(id: string): Promise<Engine> {
  const { engineFor } = await import("../engines/registry.js");
  touched = true;
  return engineFor(id);
}

/** Closes what the engines opened (the Mermaid browser, the D2 worker). Called once before the process exits. */
export async function releaseEngines(): Promise<void> {
  if (!touched) return;
  const [m, d] = await Promise.all([import("../engines/mermaid/index.js"), import("../engines/d2/index.js")]);
  await Promise.all([m.disposeMermaid().catch(() => undefined), d.disposeD2().catch(() => undefined)]);
}

// ---- source resolution ----

export interface Resolved {
  sourceType: SourceType;
  /** Engine that reads this source: its own for native files, the flag (else excalidraw) for `.exd`. */
  engine: EngineId;
  native: boolean;
  kind: Kind;
  kindFrom: "flag" | "header" | "keyword" | "default";
  kindWarning?: string;
  text: string;
  /** `--engine` as typed. */
  engineFlag?: EngineId | "auto";
}

/** Source type, engine and kind of the input (`-` is `.exd` on stdin; unknown extensions are DSL, as before). */
export async function resolveInput(file: string, flags: Flags): Promise<Resolved> {
  const text = await readSource(file);
  const detected = (file === "-" ? undefined : detectSource(file)) ?? { engine: "excalidraw" as const, sourceType: "exd" as const };
  const engineFlag = flagStr(flags, "engine") as EngineId | "auto" | undefined;
  const engine = resolveEngine(detected, engineFlag);
  const native = detected.sourceType === "d2" || detected.sourceType === "mmd";
  const kindFlag = flagStr(flags, "kind");
  if (detected.sourceType === "exd" && kindFlag !== undefined && kindFlag !== "graph") {
    throw new UsageError(`--kind ${kindFlag} needs a native .d2 or .mmd source; .exd is always a graph`, `write the diagram as ${kindFlag === "erd" || kindFlag === "class" || kindFlag === "sequence" ? "x.d2" : "x.mmd"}`);
  }
  const k = detectKind(detected.sourceType, text, kindFlag);
  return {
    sourceType: detected.sourceType,
    engine,
    native,
    kind: k.kind,
    kindFrom: k.from,
    ...(k.warning ? { kindWarning: k.warning } : {}),
    text,
    ...(engineFlag ? { engineFlag } : {}),
  };
}

/** KTD4 for an `.exd` graph: the engine to use and the recommendation (nothing is switched silently). */
export async function routeGraph(graph: Graph, flags: Flags): Promise<RouteResult> {
  const { route } = await import("../engines/route.js");
  const engine = flagStr(flags, "engine") as EngineId | "auto" | undefined;
  const target = flagStr(flags, "target") as Target | undefined;
  return route(graph, { ...(engine ? { engine } : {}), ...(target ? { target } : {}), defaultEngine: "excalidraw" });
}

/** `engine: d2 (native .d2)` for a native source. */
export const nativeEngineLine = (engine: EngineId, sourceType: SourceType): string => `engine: ${engine} (native .${sourceType})`;

/** True when the engine line would only repeat the default (a fitting graph on excalidraw, nothing asked for). */
export function quietRoute(r: RouteResult, flags: Flags): boolean {
  return !r.explicit && !r.suggestion && r.engine === "excalidraw" && flagStr(flags, "engine") !== "auto" && r.reason.startsWith("fits");
}

/** Checks `--layout` against the engine's layouts. */
export function checkLayoutFlag(engine: Engine, flags: Flags): string | undefined {
  const layout = flagStr(flags, "layout");
  if (layout === undefined) return undefined;
  const known = engine.capabilities.layouts;
  if (known.length === 0) throw new UsageError(`--layout does not apply to the ${engine.id} engine`, "it lays out with dagre; use d2 or mermaid for elk or tala");
  if (!known.includes(layout)) throw new UsageError(`unknown ${engine.id} layout '${layout}'`, `use --layout ${known.join("|")}`);
  return layout;
}

// ---- render options and render-to-files ----

/** Render options for an engine: scale and padding only when typed, so each engine keeps its own defaults. */
export function engineRenderOptions(flags: Flags, explicit: ReadonlySet<string>, o: RenderOptions, png: boolean): EngineRenderOptions {
  const r: EngineRenderOptions = { png, transparent: o.transparent, timeoutMs: o.timeoutMs };
  if (explicit.has("scale")) {
    r.scale = o.scale;
    r.exactScale = true;
  }
  if (explicit.has("padding")) r.padding = o.padding;
  if (o.theme) r.theme = o.theme;
  if (o.browserPath) r.browserPath = o.browserPath;
  if (o.fontsUrl) r.fontsUrl = o.fontsUrl;
  const layout = flagStr(flags, "layout");
  if (layout) r.layout = layout;
  if (flagBool(flags, "sketch")) r.sketch = true;
  const d2Path = flagStr(flags, "d2-path");
  if (d2Path) r.d2Path = d2Path;
  return r;
}

export interface EngineOutcome {
  files: OutputFile[];
  result?: EngineRenderResult;
  error?: AxiError;
}

const asAxi = (err: unknown): AxiError =>
  err instanceof AxiError ? err : new AxiError(`render failed: ${err instanceof Error ? err.message : String(err)}`, "run `check` on the source; try a smaller diagram");

/** AE4: the d2 PNG needs a browser or the optional binary, and neither is there. */
const noPngRenderer = (engine: string): AxiError =>
  new AxiError(
    `no PNG renderer for ${engine} (browser not found, binary not installed)`,
    `--browser-path <chrome>, or ${TOOL} engines install d2 (needs network once), or --d2-path <exe>`,
  );

/**
 * Renders `source` and writes `<base>.svg` / `<base>.png` as asked. The SVG is kept when only the PNG
 * fails (d2: no browser and no binary, or the screenshot failed). Failures are returned, not thrown.
 */
export async function renderEngineFiles(
  engine: Engine,
  source: string,
  ro: EngineRenderOptions,
  base: string,
  want: { png: boolean; svg: boolean },
): Promise<EngineOutcome> {
  const files: OutputFile[] = [];
  const write = (res: EngineRenderResult, png: boolean): void => {
    if (want.svg) files.push(writeTarget({ kind: "svg", path: `${base}.svg`, data: res.svg }));
    if (png && res.png) files.push(writeTarget({ kind: "png", path: `${base}.png`, data: res.png }));
  };
  try {
    if (want.png && engine.id === "d2") {
      const st = await engine.status({ ...(ro.browserPath ? { browserPath: ro.browserPath } : {}), ...(ro.d2Path ? { d2Path: ro.d2Path } : {}) });
      if (st.status === "browser-missing") {
        const res = await engine.render(source, { ...ro, png: false });
        write(res, false);
        return { files, result: res, error: noPngRenderer(engine.id) };
      }
    }
    let res: EngineRenderResult;
    try {
      res = await engine.render(source, ro);
    } catch (err) {
      // The PNG step failed after the SVG could have been made: keep the SVG (d2 renders it in-process).
      if (want.png && engine.id === "d2") {
        const svgOnly = await engine.render(source, { ...ro, png: false }).catch(() => undefined);
        if (svgOnly) {
          write(svgOnly, false);
          return { files, result: svgOnly, error: asAxi(err) };
        }
      }
      throw err;
    }
    write(res, want.png);
    return { files, result: res };
  } catch (err) {
    return { files, error: asAxi(err) };
  }
}

// ---- scene facts and quality ----

/** Size of the drawing from the outer svg's viewBox (the PNG result's own size is in pixels, not drawing units). */
export function svgDrawingSize(svg: string, engine: EngineId): { width: number; height: number } {
  const m = /<svg\b[^>]*\sviewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(svg);
  if (!m) return { width: 0, height: 0 };
  const round = engine === "mermaid" ? Math.ceil : Math.round;
  return { width: round(Number(m[1])), height: round(Number(m[2])) };
}

export interface SceneFacts {
  /** Undefined when the kind has no node-edge geometry (timeline, mindmap, gitGraph). */
  nodes?: number;
  edges?: number;
  groups?: number;
  width: number;
  height: number;
  /** Per-kind aggregates (participants, messages, ...). */
  extra: Record<string, number>;
}

export function factsOf(engine: Engine, res: EngineRenderResult): SceneFacts {
  const size = svgDrawingSize(res.svg, engine.id);
  const stats = (res as { stats?: { nodes: number; edges: number; clusters: number; extra: Record<string, number> } }).stats;
  const neutral = res.neutral;
  const hasGeometry = !!neutral && neutral.nodes.length > 0;
  if (stats) {
    return hasGeometry
      ? { nodes: stats.nodes, edges: stats.edges, groups: stats.clusters, ...size, extra: stats.extra }
      : { ...size, extra: stats.extra };
  }
  if (neutral && hasGeometry) {
    return {
      nodes: neutral.nodes.filter((n) => n.kind === "node").length,
      edges: neutral.edges.length,
      groups: neutral.nodes.filter((n) => n.kind === "zone").length,
      ...size,
      extra: {},
    };
  }
  return { ...size, extra: {} };
}

/** The layout an engine drew with, for the `scene:` line; undefined when the kind has none. */
export function layoutOf(engine: Engine, res: EngineRenderResult, kind: Kind, flags: Flags): string | undefined {
  if (engine.id === "excalidraw") return "dagre";
  const used = (res as { layout?: string }).layout;
  if (used) return used;
  if (engine.id === "mermaid") {
    const layoutKinds: Kind[] = ["graph", "state", "class", "erd"];
    return layoutKinds.includes(kind) ? (flagStr(flags, "layout") ?? "elk") : undefined;
  }
  return flagStr(flags, "layout");
}

export interface EngineQuality {
  rows: QualityRow[];
  block: string;
  hard: boolean;
}

/** Checker findings on the engine's geometry, minus the rules it cannot be measured on, as quality rows. */
export async function engineQuality(engine: Engine, res: EngineRenderResult, kind: Kind, layout: string | undefined, sketch: boolean): Promise<EngineQuality> {
  if (kind !== "graph") return { rows: [], block: `quality: n/a (kind ${kind} has no graph rules)`, hard: false };
  const geom = engine.geometry?.(res);
  if (!geom || geom.elements.length === 0) return { rows: [], block: "quality: n/a (no geometry for this diagram)", hard: false };
  try {
    const skipped = new Set(geom.rulesSkipped);
    const findings = analyzeScene({ elements: geom.elements }).findings.filter((f) => !skipped.has(f.code));
    findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "hard" ? -1 : 1));
    let rows: QualityRow[] = [];
    if (engine.id === "d2") {
      const { d2QualityRows } = await import("../engines/d2/index.js");
      rows = d2QualityRows(findings, { layout: (layout ?? "elk") as "elk" | "dagre" | "tala", sketch });
    } else if (engine.id === "mermaid") {
      const { mermaidHints } = await import("../engines/mermaid/hints.js");
      rows = mermaidHints(findings, { ...(layout ? { layout } : {}), kind });
    }
    return { rows, block: qualityBlock(rows), hard: rows.some((r) => r.severity === "hard") };
  } catch (err) {
    return { rows: [], block: `quality: unavailable, the layout checker could not read this diagram (${(err as Error).message})`, hard: false };
  }
}

/** `scene: 20 nodes, 34 edges, 2 groups, 1587x1047 px, ...` or, without geometry, `scene: nodes/edges n/a, ...`. */
export function engineSceneLine(f: SceneFacts, extra: string[]): string {
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const counts =
    f.nodes === undefined ? ["nodes/edges n/a"] : [plural(f.nodes, "node"), plural(f.edges ?? 0, "edge"), plural(f.groups ?? 0, "group")];
  return `scene: ${[...counts, `${f.width}x${f.height} px`, ...extra].join(", ")}`;
}

/** Writes the QA sidecar `<base>.geometry.json`: the neutral model plus what the checker needs to mask rules. */
export function writeGeometrySidecar(engine: Engine, res: EngineRenderResult, kind: Kind, layout: string | undefined, base: string): void {
  const geom = engine.geometry?.(res);
  const body = {
    engine: engine.id,
    ...(layout ? { layout } : {}),
    kind,
    rules_skipped: geom?.rulesSkipped ?? [],
    ...(res.neutral ? { neutral: res.neutral } : { elements: res.elements ?? [] }),
  };
  writeTarget({ kind: "svg", path: `${base}.geometry.json`, data: JSON.stringify(body) });
}
