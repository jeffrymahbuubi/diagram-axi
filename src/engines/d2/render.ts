// D2 render: compile + layout + SVG in WASM (one SVG code path), neutral geometry from the compiled
// diagram, PNG by screenshot of that SVG in the installed browser, else by the optional native binary.

import { AxiError, UsageError } from "../../output/errors.js";
import { findBrowser, type InstalledBrowser } from "../../render/browser.js";
import type { EngineRenderOptions, EngineRenderResult, Kind } from "../types.js";
import { d2BinaryPng, resolveD2Binary } from "./binary.js";
import { mayRunThrough, reorderEdgeBlocks, repairThroughNodes, throughHits } from "./detour.js";
import { diagramKind, diagramToNeutral } from "./geometry.js";
import { spreadLanes } from "./lane-spread.js";
import { placeLabels } from "./label-place.js";
import { capScale, D2_DEFAULT_SCALE, svgToPng } from "./png.js";
import { toDiagnostic } from "./validate.js";
import { D2_LAYOUTS, D2_PAD, D2CompileError, d2Compile, d2RenderSvg, svgSize, type D2Compiled, type D2CompileOptions, type D2Layout } from "./wasm.js";

export const D2_DEFAULT_LAYOUT: D2Layout = "elk";
/** Dark Mauve, D2's dark theme. */
export const D2_DARK_THEME = 200;
/** The d2 CLI writes 2 PNG px per SVG px at --scale 1, so our scale (PNG px per SVG px) is halved for it. */
const D2_CLI_PNG_FACTOR = 2;
/** `--layout tala` takes seconds above this many shapes. */
export const TALA_SLOW_NODES = 30;

export type D2RenderResult = EngineRenderResult & {
  /** Diagram kind as compiled (lifelines mean sequence, tables erd, ...). */
  kind: Kind;
  layout: D2Layout;
  /** How the PNG was made. */
  pngVia?: "browser" | "binary";
};

export function checkLayout(layout: string | undefined): D2Layout {
  const l = layout ?? D2_DEFAULT_LAYOUT;
  if (!(D2_LAYOUTS as readonly string[]).includes(l)) throw new UsageError(`unknown D2 layout '${l}'`, `use --layout ${D2_LAYOUTS.join("|")}`);
  return l as D2Layout;
}

/** compile() failure -> AxiError naming the first error; `check` lists them all. */
function compileFailure(err: unknown): never {
  if (!(err instanceof D2CompileError)) throw err;
  const first = toDiagnostic(err.errors[0]!);
  const where = first.line === undefined ? "" : `${first.line}:${first.col ?? 1} `;
  const more = err.errors.length > 1 ? ` (+${err.errors.length - 1} more)` : "";
  throw new AxiError(`D2 source does not compile: ${where}${first.message}${more}`, first.suggestion ?? "run `check` on the file to list every error");
}

/**
 * compile() plus the adapter's passes: lane spreading, label placement and, for an arrow that still runs through a node,
 * the detour repair. `through` counts the arrows still running through a node afterwards (graph diagrams only).
 */
async function layOut(source: string, options: D2CompileOptions): Promise<{ compiled: D2Compiled; through: number }> {
  const compiled = await d2Compile(source, options).catch(compileFailure);
  if (diagramKind(compiled.diagram) !== "graph") return { compiled, through: 0 };
  spreadLanes(compiled.diagram);
  placeLabels(compiled.diagram);
  if (!mayRunThrough(compiled.diagram)) return { compiled, through: 0 };
  let through = throughHits(diagramToNeutral(compiled.diagram).neutral).length;
  if (through > 0) {
    repairThroughNodes(compiled.diagram);
    through = throughHits(diagramToNeutral(compiled.diagram).neutral).length;
  }
  return { compiled, through };
}

export async function renderD2(source: string, o: EngineRenderOptions = {}): Promise<D2RenderResult> {
  const layout = checkLayout(o.layout);
  const pad = o.padding ?? D2_PAD;
  const dark = o.theme === "dark";
  const timeoutMs = o.timeoutMs ?? 30_000;
  const warnings: string[] = [];

  const options: D2CompileOptions = { layout, pad, ...(o.sketch ? { sketch: true } : {}), ...(dark ? { themeID: D2_DARK_THEME } : {}) };
  let { compiled, through } = await layOut(source, options);
  // Safety net: an arrow still runs through a node. ELK's routes depend on the order the edges are declared in, so compile
  // once more with the one fixed alternative order (reversed) and keep the better drawing.
  const alternative = through > 0 ? reorderEdgeBlocks(source) : undefined;
  if (alternative !== undefined) {
    const second = await layOut(alternative, options).catch(() => undefined);
    if (second && second.through < through) ({ compiled, through } = second);
  }
  const svg = await d2RenderSvg(compiled);
  const natural = svgSize(svg);
  const { neutral, kind } = diagramToNeutral(compiled.diagram);
  if (layout === "tala" && compiled.diagram.shapes.length > TALA_SLOW_NODES) {
    warnings.push(`slow: --layout tala takes seconds above ${TALA_SLOW_NODES} shapes (${compiled.diagram.shapes.length} here); use --layout elk for a faster draft`);
  }

  const result: D2RenderResult = { svg, width: natural.width, height: natural.height, browser: "d2-wasm", neutral, kind, layout };

  if (o.png) {
    const cap = capScale(natural.width, natural.height, o.scale ?? D2_DEFAULT_SCALE, o.exactScale === true);
    if (cap.warning) warnings.push(cap.warning);
    let browser: InstalledBrowser | undefined;
    let browserError: unknown;
    try {
      browser = await findBrowser(o.browserPath);
    } catch (err) {
      browserError = err;
    }
    if (browser) {
      try {
        const shot = await svgToPng({ svg, width: natural.width, height: natural.height, scale: cap.scale, transparent: o.transparent === true, timeoutMs, browser });
        Object.assign(result, { png: shot.png, width: shot.width, height: shot.height, browser: browser.name, pngVia: "browser" });
      } catch (err) {
        browserError = err;
      }
    }
    if (result.png === undefined) {
      const bin = await resolveD2Binary({ ...(o.d2Path ? { d2Path: o.d2Path } : {}) }).catch((e: unknown) => {
        throw browserError instanceof AxiError ? browserError : e;
      });
      if (!bin) {
        if (browserError instanceof AxiError) {
          throw new AxiError(browserError.message, `${browserError.suggestion ?? "pass --browser-path <exe>"}; or run \`engines install d2\` for browser-less PNG`);
        }
        throw browserError;
      }
      const png = await d2BinaryPng(bin, source, { layout, ...(o.sketch ? { sketch: true } : {}), dark, pad, scale: cap.scale / D2_CLI_PNG_FACTOR, timeoutMs });
      const buf = Buffer.from(png);
      Object.assign(result, { png, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), browser: "d2", pngVia: "binary" });
      if (browserError) warnings.push(`no usable browser; PNG written by the d2 binary${o.sketch ? " (its sketch strokes differ from the SVG's)" : ""}`);
    }
  }
  if (warnings.length > 0) result.warning = warnings.join("; ");
  return result;
}
