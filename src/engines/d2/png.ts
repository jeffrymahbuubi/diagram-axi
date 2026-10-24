// D2 PNG, default path (user decision): the SVG D2's WASM produced, screenshot in the installed browser.
// D2 embeds its fonts in the SVG, so the pixels do not depend on the machine. The page lives on a virtual
// origin and every other request is aborted: no network, remote icons stay blank. Patterns follow
// src/render/render.ts (launch, deadline, cleanup).

import { AxiError } from "../../output/errors.js";
import type { InstalledBrowser } from "../../render/browser.js";
import { launchContext, type LaunchedBrowser } from "../../render/launch.js";
import { HARD_MAX_SIDE, MAX_PIXELS, MAX_SIDE } from "../../render/page.js";

const ORIGIN = "http://d2-render.local";
const LAUNCH_GRACE_MS = 15_000;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

/**
 * PNG pixels per SVG viewBox pixel when no scale is given: 2.5, what the bake-off rendered (d2 --scale 1.25; the
 * d2 CLI draws 2 PNG px per SVG px at --scale 1). The 2048 px cap lowers it for large diagrams.
 */
export const D2_DEFAULT_SCALE = 2.5;

export interface Scaled {
  scale: number;
  /** The caps lowered the requested scale. */
  reduced: boolean;
  warning?: string;
}

/**
 * The scale to render at: the request, lowered so the longest side stays within 2048 px (16384 px when the
 * scale was typed explicitly) and the area within 64 MP.
 */
export function capScale(width: number, height: number, requested: number, exact: boolean): Scaled {
  const side = exact ? HARD_MAX_SIDE : MAX_SIDE;
  const long = Math.max(width, height, 1);
  const bySide = side / long;
  const byArea = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
  const scale = Math.min(requested, bySide, byArea);
  if (scale >= requested * 0.999) return { scale: requested, reduced: false };
  const rounded = Math.floor(scale * 10000) / 10000;
  return {
    scale: rounded,
    reduced: true,
    warning: `scale reduced from ${requested} to ${rounded.toFixed(2)} to stay within ${side} px / 64 MP (${Math.round(width * rounded)}x${Math.round(height * rounded)} px)`,
  };
}

function launch(info: InstalledBrowser, timeout: number, width: number, height: number, scale: number): Promise<LaunchedBrowser> {
  return launchContext(info, {
    timeout,
    context: { viewport: { width: Math.max(1, width), height: Math.max(1, height) }, deviceScaleFactor: scale, serviceWorkers: "block" },
  });
}

/** Page markup: the D2 SVG at its natural pixel size (the outer element only has a viewBox). */
export function pageHtml(svg: string, width: number, height: number, transparent = false): string {
  const body = svg.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/^<svg /, `<svg width="${width}" height="${height}" `);
  return `<!doctype html><meta charset="utf-8"><title>D2 render</title><style>html,body{margin:0;padding:0;background:${transparent ? "transparent" : "#fff"}}svg{display:block}</style>${body}`;
}

export interface SvgPngOptions {
  svg: string;
  /** Natural size of the SVG (its viewBox), px. */
  width: number;
  height: number;
  scale: number;
  transparent?: boolean;
  timeoutMs: number;
  browser: InstalledBrowser;
}

export interface PngResult {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Screenshot of `svg` at `scale` (device pixel ratio). Always closes the browser. */
export async function svgToPng(o: SvgPngOptions): Promise<PngResult> {
  const html = pageHtml(o.svg, o.width, o.height, o.transparent === true);
  const deadline = Date.now() + o.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AxiError(`PNG rendering timed out after ${o.timeoutMs} ms`, "raise --timeout or lower --scale")), Math.max(0, deadline - Date.now()));
  });
  const launching = launch(o.browser, o.timeoutMs + LAUNCH_GRACE_MS, o.width, o.height, o.scale);
  launching.catch(() => undefined);

  const work = (async () => {
    const { context } = await launching.catch((error: unknown) => {
      if (error instanceof AxiError) throw error; // already worded (e.g. a busy profile pool)
      throw new AxiError(`could not start ${o.browser.name} at ${o.browser.path}: ${(error as Error).message.split("\n")[0]}`, "pass --browser-path <exe> to use another Chrome, Chromium, Edge or Firefox");
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const respond = url.origin === ORIGIN && url.pathname === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.abort();
      await respond.catch(() => undefined);
    });
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(async (transparent) => {
      await document.fonts.ready;
      if (transparent) document.querySelector("svg svg > rect")?.setAttribute("fill-opacity", "0");
    }, o.transparent === true);
    return page.screenshot({
      type: "png",
      omitBackground: o.transparent === true,
      clip: { x: 0, y: 0, width: o.width, height: o.height },
    });
  })();
  work.catch(() => undefined);

  try {
    const shot = await Promise.race([work, timeout]);
    if (shot.length < 24 || !shot.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new AxiError("the browser could not encode the diagram as PNG", "try a lower --scale");
    }
    return { png: shot, width: shot.readUInt32BE(16), height: shot.readUInt32BE(20) };
  } catch (error) {
    if (error instanceof AxiError) throw error;
    const first = ((error as Error).message ?? String(error)).split("\n")[0] ?? "";
    throw new AxiError(`PNG render failed: ${first.replace(/^page\.\w+: /, "")}`, "try a lower --scale or a smaller diagram");
  } finally {
    clearTimeout(timer);
    const launched = await launching.catch(() => undefined);
    await launched?.close();
  }
}
