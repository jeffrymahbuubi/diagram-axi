// The renderer page: the virtual origin it is served from, where the build artefacts live, and the
// function Playwright serializes into the browser to call exportScene. Adapted from the MIT-licensed
// excalidraw/cli (see NOTICE), ported from @excalidraw/utils 0.1.5 exportToCanvas to 0.1.7 exportScene.

import { existsSync } from "node:fs";

/** scripts/build-renderer.mjs points the renderer's fonts at this origin; render.ts serves it in memory. */
export const ORIGIN = "http://excalidraw-renderer.local";
export const FONT_PATH = /^\/fonts\/[0-9a-f]{64}\.woff2$/;
export const PAGE_HTML = '<!doctype html><meta charset="utf-8"><title>Excalidraw render</title>';

/** Raster output limits: longest side in px (default) and total pixels. */
export const MAX_SIDE = 2048;
export const MAX_PIXELS = 64_000_000;
/**
 * Legibility policy for very wide or tall scenes: the 2048 px side cap yields to a minimum rendered font
 * size (the smallest text in the scene must come out at least MIN_FONT_PX tall), up to HARD_MAX_SIDE px.
 * Beyond that the render is still drawn, but with a warning (see render.ts).
 */
export const MIN_FONT_PX = 11;
export const HARD_MAX_SIDE = 16_384;

/**
 * The directory holding renderer.js and fonts/. The build writes it next to the compiled modules
 * (dist/render/page.js -> dist/), and when running from source (src/render/page.ts) it is ../../dist/.
 */
export function distDirectory(): URL {
  const sibling = new URL("../", import.meta.url);
  return existsSync(new URL("renderer.js", sibling)) ? sibling : new URL("../../dist/", import.meta.url);
}

export interface PageInput {
  scene: { elements: unknown[]; appState: Record<string, unknown>; files: Record<string, unknown> };
  options: {
    png: boolean;
    svg: boolean;
    scale: number;
    padding: number;
    theme?: "light" | "dark";
    transparent: boolean;
    maxSide: number;
    maxPixels: number;
    /** Raise the side cap up to hardMaxSide so the smallest text renders at least this many px (0 = off). */
    minFontPx: number;
    hardMaxSide: number;
    /** An explicit scale: deliver it, up to hardMaxSide, instead of stopping at maxSide. */
    exactScale: boolean;
  };
  moduleUrl: string;
}

export interface PageOutput {
  /** base64, no data: prefix */
  png?: string;
  svg?: string;
  /** Scale actually used after the size caps. */
  scale: number;
  /** Longest side allowed for this render (maxSide, or hardMaxSide when the cap was raised for legibility). */
  sideLimit: number;
  /** Smallest text size in the scene in px (0 when the scene has no text). */
  minFont: number;
  /** Size of the SVG export in px (only when SVG was requested). */
  svgWidth?: number;
  svgHeight?: number;
}

/** Serialized by Playwright and executed in the browser: it must not reference anything outside itself. */
export async function renderInBrowser({ scene, options, moduleUrl }: PageInput): Promise<PageOutput> {
  // FontFaceSet.load() rejects as soon as one matching face fails, while the others may still be
  // loading. Excalidraw catches that rejection and draws right away, with fallback glyphs for text
  // whose font arrives moments later. Wait for every pending face before passing the failure on.
  const fontSet = document.fonts;
  const loadFonts = fontSet.load.bind(fontSet);
  fontSet.load = async (font: string, text?: string) => {
    try {
      return await loadFonts(font, text);
    } catch (error) {
      await Promise.allSettled([...fontSet].filter((face) => face.status === "loading").map((face) => face.loaded));
      throw error;
    }
  };

  type Exporter = (opts: { type: "png" | "svg"; data: unknown; config: unknown }) => Promise<Blob | SVGSVGElement>;
  // Built with Function so a test transformer (vitest) cannot rewrite the import() of this serialized body.
  const importModule = new Function("url", "return import(url)") as (url: string) => Promise<{ exportScene: Exporter }>;
  const { exportScene } = await importModule(moduleUrl);

  const appState = scene.appState;
  const theme = options.theme ?? (appState.exportWithDarkMode ? "dark" : "light");
  const transparent = options.transparent || appState.exportBackground === false;
  const background = typeof appState.viewBackgroundColor === "string" ? appState.viewBackgroundColor : "#ffffff";

  const fontSizes = (scene.elements as { type?: string; fontSize?: number }[])
    .filter((el) => el?.type === "text" && typeof el.fontSize === "number" && el.fontSize > 0)
    .map((el) => el.fontSize as number);
  const minFont = fontSizes.length > 0 ? Math.min(...fontSizes) : 0;
  // The scale this render must reach before the soft 2048 px cap may be raised.
  const floor = options.exactScale ? options.scale : minFont > 0 ? Math.min(options.scale, options.minFontPx / minFont) : 0;
  let usedScale = options.scale;
  let sideLimit = options.maxSide;
  const config = {
    theme,
    padding: options.padding,
    canvasBackgroundColor: transparent ? false : background,
    // Receives the export size at scale 1, padding included.
    scale: (width: number, height: number) => {
      const w = Math.max(1, width);
      const h = Math.max(1, height);
      const area = Math.sqrt(options.maxPixels / (w * h));
      let scale = Math.min(options.scale, options.maxSide / w, options.maxSide / h, area);
      if (scale < floor) {
        // Too wide/tall for the soft cap at a legible scale: allow a longer side, up to the hard cap.
        scale = Math.min(floor, options.hardMaxSide / w, options.hardMaxSide / h, area);
        if (scale > Math.min(options.maxSide / w, options.maxSide / h)) sideLimit = options.hardMaxSide;
      }
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error("Scene bounds are too large to render.");
      }
      usedScale = scale;
      return scale;
    },
  };
  const data = { elements: scene.elements, files: scene.files, appState: { ...appState, exportWithDarkMode: theme === "dark" } };

  const output: PageOutput = { scale: usedScale, sideLimit, minFont };
  if (options.png) {
    const blob = (await exportScene({ type: "png", data, config })) as Blob;
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Could not read the PNG blob."));
      reader.readAsDataURL(blob);
    });
    output.png = url.slice(url.indexOf(",") + 1);
  }
  if (options.svg) {
    const svg = (await exportScene({ type: "svg", data, config })) as SVGSVGElement;
    output.svg = svg.outerHTML;
    output.svgWidth = svg.width.baseVal.value;
    output.svgHeight = svg.height.baseVal.value;
  }
  output.scale = usedScale;
  output.sideLimit = sideLimit;
  return output;
}
