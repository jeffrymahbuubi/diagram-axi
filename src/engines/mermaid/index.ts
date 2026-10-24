// The Mermaid engine (KTD3): .exd -> flowchart source, validation and rendering in our own browser page
// (a pinned mermaid + the ELK layout loader, bundled by scripts/build-mermaid.mjs), geometry from the DOM.

import { findBrowser } from "../../render/browser.js";
import type { Engine, EngineStatus, StatusOptions } from "../types.js";
import { geometryOf } from "./geometry.js";
import { bundleExists } from "./page.js";
import { checkMermaid, kindOfSource, renderMermaid, type MermaidRenderResult } from "./render.js";
import { translate } from "./translate.js";

/** Versions of the bundled packages (the exact pins in package.json). */
export const MERMAID_VERSION = "12.2.0";
export const MERMAID_ELK_VERSION = "1.0.1";

async function status(opts: StatusOptions = {}): Promise<EngineStatus> {
  if (!bundleExists()) {
    return { status: "missing", version: MERMAID_VERSION, png: "none", install: "run `npm run build` (writes dist/render/mermaid-elk.iife.js)" };
  }
  try {
    const browser = await findBrowser(opts.browserPath);
    return { status: "ready", version: MERMAID_VERSION, png: "browser", path: browser.path };
  } catch {
    return {
      status: "browser-missing",
      version: MERMAID_VERSION,
      png: "none",
      install: "pass --browser-path <exe> or set a Chrome, Chromium, Edge or Firefox executable",
    };
  }
}

export const mermaidEngine: Engine = {
  id: "mermaid",
  capabilities: {
    kinds: ["graph", "sequence", "class", "erd", "state", "timeline", "gitgraph", "mindmap"],
    sourceExt: ".mmd",
    extraExts: [".mermaid"],
    outputs: ["mmd", "png", "svg"],
    sketch: true,
    layouts: ["dagre", "elk"],
    inlineMarkdown: true,
    geometry: true,
  },
  status,
  translate,
  validate: (source, o) => checkMermaid(source, o ?? {}),
  render: renderMermaid,
  geometry: (r) => {
    const m = r as MermaidRenderResult;
    return geometryOf(m.neutral, m.kind);
  },
  detectKind: kindOfSource,
};

export { disposeSession as disposeMermaid } from "./page.js";
export type { MermaidRenderResult } from "./render.js";
export type { MermaidStats } from "./geometry.js";
