// The D2 engine (KTD1, KTD6): `.d2` sources, translated from the portable graph (`.exd`), validated by a
// full WASM compile, rendered to SVG by the same WASM and to PNG by the browser (or the optional binary).

import { findBrowser } from "../../render/browser.js";
import { detectKind } from "../detect.js";
import { toScene } from "../neutral.js";
import type { Engine, EngineRenderResult, EngineStatus, Geometry, StatusOptions } from "../types.js";
import { resolveD2Binary } from "./binary.js";
import { rulesSkippedFor, titlesOutsideZones } from "./geometry.js";
import { renderD2, type D2RenderResult } from "./render.js";
import { D2_RELEASE } from "./release.js";
import { translateGraph } from "./translate.js";
import { validateD2 } from "./validate.js";
import { D2_LAYOUTS, D2_WASM_PACKAGE_VERSION } from "./wasm.js";

export { translateGraph } from "./translate.js";
export { D2_RELEASE } from "./release.js";
export { D2_PATH_ENV, cachedBinaryPath, installD2Binary, resolveD2Binary } from "./binary.js";
export { D2_DEFAULT_LAYOUT, renderD2 } from "./render.js";
export { D2_WASM_PACKAGE_VERSION, disposeD2, stripD2Version } from "./wasm.js";
export { d2QualityRows } from "./hints.js";

const VERSION = `${D2_RELEASE.version.replace(/^v/, "")} (@d2lang/d2 ${D2_WASM_PACKAGE_VERSION})`;

/** The WASM package is installed (checked without loading its 41 MB module). */
function wasmInstalled(): boolean {
  try {
    import.meta.resolve("@d2lang/d2");
    return true;
  } catch {
    return false;
  }
}

async function status(opts: StatusOptions = {}): Promise<EngineStatus> {
  if (!wasmInstalled()) {
    return { status: "missing", version: VERSION, png: "none", install: `npm install @d2lang/d2@${D2_WASM_PACKAGE_VERSION}` };
  }
  try {
    const browser = await findBrowser(opts.browserPath);
    return { status: "ready", version: VERSION, png: "browser", path: browser.path };
  } catch {
    // SVG needs no browser; PNG then needs the optional binary.
    const bin = await resolveD2Binary({ ...(opts.d2Path ? { d2Path: opts.d2Path } : {}) }).catch(() => undefined);
    if (bin) return { status: "ready", version: VERSION, png: "binary", path: bin.path };
    return {
      status: "browser-missing",
      version: VERSION,
      png: "none",
      install: "run `engines install d2` for browser-less PNG, or pass --browser-path <exe>",
    };
  }
}

function geometry(r: EngineRenderResult): Geometry {
  const kind = (r as Partial<D2RenderResult>).kind ?? "graph";
  const rulesSkipped = rulesSkippedFor(kind);
  // dagre draws container titles above the box (OUTSIDE_TOP_*); that is the layout's design, not a containment defect.
  if (r.neutral && titlesOutsideZones(r.neutral)) rulesSkipped.push("group-containment");
  return { elements: r.neutral ? toScene(r.neutral) : [], rulesSkipped: rulesSkipped.sort() };
}

export const d2Engine: Engine = {
  id: "d2",
  capabilities: {
    kinds: ["graph", "sequence", "class", "erd"],
    sourceExt: ".d2",
    outputs: ["d2", "png", "svg"],
    sketch: true,
    layouts: [...D2_LAYOUTS],
    inlineMarkdown: false,
    geometry: true,
  },
  status,
  translate(graph, o) {
    return translateGraph(o.title === undefined ? graph : { ...graph, title: o.title }, o);
  },
  validate: (source) => validateD2(source),
  render: renderD2,
  geometry,
  detectKind: (source) => detectKind("d2", source).kind,
};
