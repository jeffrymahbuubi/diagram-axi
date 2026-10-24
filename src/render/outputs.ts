// Render and output-file contracts shared by the scene, render and command
// units. Types only.

/** Minimal shape of a serialized Excalidraw scene; the scene unit owns the element types. */
export interface SceneData {
  type: "excalidraw";
  version: number;
  source?: string;
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export interface RenderRequest {
  scene: SceneData;
  png: boolean;
  svg: boolean;
  /** Default 1, capped by 2048 px max side and 64 MP; the side cap is raised to 16384 px for legibility (see page.ts). */
  scale: number;
  /** The scale was given explicitly: deliver it up to 16384 px (and 64 MP) instead of stopping at 2048 px. */
  exactScale?: boolean;
  /** Smallest text size in px the 2048 px cap may not push below; default 11, 0 turns the raise off. */
  minFontPx?: number;
  /** Default 20 px. */
  padding: number;
  /** Undefined = use the scene's own setting, else light. */
  theme?: "light" | "dark";
  transparent: boolean;
  /** Single deadline for the whole render; default 30000. */
  timeoutMs: number;
  /** --browser-path; falls back to DIAGRAM_AXI_BROWSER_PATH, then discovery. */
  browserPath?: string;
  /** CJK font mirror base URL, or "none" to disable downloads. */
  fontsUrl?: string;
}

export interface RenderResult {
  png?: Uint8Array;
  svg?: string;
  /** Output size in px of the exported image. */
  width: number;
  height: number;
  /** Short browser name for the summary line, e.g. "msedge". */
  browser: string;
  warning?: string;
}

export type RenderScene = (req: RenderRequest) => Promise<RenderResult>;

export type OutputKind = "excalidraw" | "d2" | "mmd" | "png" | "svg" | "exd" | "map" | "json";

/** One row of the `outputs[N]{kind,path,bytes}` TOON table. */
export interface OutputFile {
  kind: OutputKind;
  path: string;
  bytes: number;
}
