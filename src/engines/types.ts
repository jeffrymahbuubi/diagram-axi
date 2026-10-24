// Engine contract (KTD1). An engine turns diagram source into SVG/PNG and, where it can, into geometry
// the one quality checker understands. Engines are plain objects registered in registry.ts; commands
// never import engine internals.

import type { Direction, Graph } from "../dsl/ast.js";
import type { SceneElement } from "../quality/geom.js";
import type { RenderResult } from "../render/outputs.js";
import type { NeutralScene } from "./neutral.js";

export type EngineId = "excalidraw" | "d2" | "mermaid";

export type Kind = "graph" | "sequence" | "class" | "erd" | "state" | "timeline" | "gitgraph" | "mindmap";

export const KINDS: readonly Kind[] = ["graph", "sequence", "class", "erd", "state", "timeline", "gitgraph", "mindmap"];

/** Files a draw can write: the render outputs plus the translated engine source. */
export type EngineOutputKind = "excalidraw" | "d2" | "mmd" | "png" | "svg";

export interface Capabilities {
  kinds: Kind[];
  /** Extension of the engine's authoring source (`.exd` for the excalidraw engine, which translates a graph). */
  sourceExt: ".exd" | ".d2" | ".mmd";
  /** More extensions the engine reads (`.excalidraw` scenes). */
  extraExts?: string[];
  outputs: EngineOutputKind[];
  sketch: boolean;
  /** d2: dagre|elk|tala, mermaid: dagre|elk; empty when the engine has one layout. */
  layouts: string[];
  /** The source can be pasted into Markdown (Mermaid on GitHub). */
  inlineMarkdown: boolean;
  /** `geometry()` is implemented: the checker can run on this engine's output. */
  geometry: boolean;
}

/** Something a translation could not carry over (KTD2); surfaces as an `engine-loss` warning row. */
export interface Loss {
  code: string;
  detail: string;
  line?: number;
  col?: number;
}

export interface Diagnostic {
  line?: number;
  col?: number;
  endCol?: number;
  /** Absent means error. `validate` returns text lints (D2 `remote-icon`) as warnings next to the errors. */
  severity?: "error" | "warning";
  code: string;
  message: string;
  suggestion?: string;
}

export interface EngineStatus {
  status: "ready" | "missing" | "browser-missing";
  version?: string;
  /** How PNG is produced: browser screenshot, the optional binary, or not at all. */
  png?: "browser" | "binary" | "none";
  path?: string;
  /** Command that makes a missing engine ready. */
  install?: string;
}

/** Inputs of `status()`: it inspects the machine and never downloads or loads WASM. */
export interface StatusOptions {
  browserPath?: string;
  d2Path?: string;
}

export interface TranslateOptions {
  direction?: Direction;
  title?: string;
  layout?: string;
  sketch?: boolean;
  target?: "markdown" | "github" | "editable";
}

export interface ValidateOptions {
  browserPath?: string;
  timeoutMs?: number;
}

export interface EngineRenderOptions {
  /** Also produce a PNG (the SVG is always produced). */
  png?: boolean;
  scale?: number;
  /** --scale was typed: deliver it instead of the 2048 px default cap. */
  exactScale?: boolean;
  padding?: number;
  theme?: "light" | "dark";
  transparent?: boolean;
  timeoutMs?: number;
  browserPath?: string;
  fontsUrl?: string;
  layout?: string;
  sketch?: boolean;
  d2Path?: string;
}

export type EngineRenderResult = RenderResult & {
  svg: string;
  /** Engine geometry for `toScene`; engines with their own scene elements (excalidraw) return `elements` instead. */
  neutral?: NeutralScene;
  elements?: SceneElement[];
};

export interface Geometry {
  elements: SceneElement[];
  /** Checker rules that do not apply to this engine's output, reported as `rules_skipped`. */
  rulesSkipped: string[];
}

export interface Engine {
  id: EngineId;
  capabilities: Capabilities;
  /** Never downloads. */
  status(opts?: StatusOptions): Promise<EngineStatus>;
  /** Graph engines: portable graph -> engine source. */
  translate?(graph: Graph, o: TranslateOptions): { source: string; losses: Loss[] };
  /** Full compile/parse (+ render where the engine only fails at render time), with positions when available. */
  validate(source: string, o?: ValidateOptions): Promise<Diagnostic[]>;
  render(source: string, o?: EngineRenderOptions): Promise<EngineRenderResult>;
  /** `toScene(neutral)` plus the rule mask; absent when the engine has no geometry. */
  geometry?(r: EngineRenderResult): Geometry;
  detectKind(source: string): Kind | undefined;
}
