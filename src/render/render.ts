// renderScene: draws a scene to PNG and/or SVG with an installed browser, driven by playwright-core.
// Every request is answered in memory on a virtual origin (no server, no network). Adapted from the
// MIT-licensed excalidraw/cli (see NOTICE).

import { readFile } from "node:fs/promises";
import { AxiError } from "../output/errors.js";
import { BROWSER_ENV, findBrowser, type InstalledBrowser } from "./browser.js";
import { createFontLoader, parseFontsUrl } from "./fonts.js";
import { launchContext, type LaunchedBrowser } from "./launch.js";
import { FONT_PATH, HARD_MAX_SIDE, MAX_PIXELS, MAX_SIDE, MIN_FONT_PX, ORIGIN, PAGE_HTML, distDirectory, renderInBrowser } from "./page.js";
import type { RenderRequest, RenderResult, SceneData } from "./outputs.js";

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_BROWSER_OUTPUT_LINES = 10;
/** Extra time the browser launch itself may take beyond the render deadline, so cleanup is always bounded. */
const LAUNCH_GRACE_MS = 15_000;

/** Render `req.scene` to the requested formats in one browser page. Always closes the browser. */
export async function renderScene(req: RenderRequest): Promise<RenderResult> {
  validate(req);
  const elements = (req.scene.elements as { isDeleted?: boolean }[]).filter((element) => !element?.isDeleted);
  if (elements.length === 0) {
    throw new AxiError("cannot render an empty scene", "add at least one node to the diagram");
  }
  const browserInfo = await findBrowser(req.browserPath);

  const dist = distDirectory();
  const rendererSource = await readFile(new URL("renderer.js", dist)).catch(() => {
    throw new AxiError(
      `renderer bundle not found at ${new URL("renderer.js", dist).pathname}`,
      "run `npm run build` (scripts/build-renderer.mjs writes dist/renderer.js and dist/fonts/)",
    );
  });

  const deadline = Date.now() + req.timeoutMs;
  // Font downloads get half the deadline, which leaves time to draw with fallback glyphs if a mirror hangs.
  const fonts = createFontLoader({
    mirrors: parseFontsUrl(req.fontsUrl),
    deadline: Date.now() + Math.floor(req.timeoutMs / 2),
    distDirectory: dist,
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AxiError(`rendering timed out after ${req.timeoutMs} ms`, "try a smaller diagram or raise --timeout")),
      Math.max(0, deadline - Date.now()),
    );
  });
  // The launch is awaited again during cleanup, so a browser that starts after the deadline is still closed.
  const launching = launch(browserInfo, req.timeoutMs + LAUNCH_GRACE_MS);
  launching.catch(() => undefined);

  const work = (async () => {
    const { context } = await launching.catch((error: unknown) => {
      throw launchFailure(browserInfo, error);
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const respond = async () => {
        if (url.origin !== ORIGIN) {
          await route.abort();
        } else if (url.pathname === "/") {
          await route.fulfill({ contentType: "text/html", body: PAGE_HTML });
        } else if (url.pathname === "/renderer.js") {
          await route.fulfill({ contentType: "text/javascript", body: rendererSource });
        } else if (FONT_PATH.test(url.pathname)) {
          // The browser only requests the fonts the scene's text needs. A missing font makes it
          // fall back to the next family.
          const font = await fonts.load(url.pathname.slice("/fonts/".length, -".woff2".length));
          await (font ? route.fulfill({ contentType: "font/woff2", body: font }) : route.abort());
        } else {
          await route.abort();
        }
      };
      // Errors after a timeout closed the page are moot.
      await respond().catch(() => undefined);
    });
    await page.goto(`${ORIGIN}/`);
    return page
      .evaluate(renderInBrowser, {
        scene: { elements, appState: req.scene.appState ?? {}, files: req.scene.files ?? {} },
        options: {
          png: req.png,
          svg: req.svg,
          scale: req.scale,
          padding: req.padding,
          theme: req.theme,
          transparent: req.transparent,
          maxSide: MAX_SIDE,
          maxPixels: MAX_PIXELS,
          minFontPx: req.minFontPx ?? MIN_FONT_PX,
          hardMaxSide: HARD_MAX_SIDE,
          exactScale: req.exactScale === true,
        },
        moduleUrl: `${ORIGIN}/renderer.js`,
      })
      .catch((error: unknown) => {
        throw new AxiError(`render failed: ${cleanBrowserError(error)}`, "check the scene file; try a smaller diagram");
      });
  })();
  work.catch(() => undefined);

  let out: Awaited<typeof work>;
  try {
    out = await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    const launched = await launching.catch(() => undefined);
    await launched?.close();
  }

  return buildResult(out, browserInfo, fonts.warning(), req);
}

function validate(req: RenderRequest) {
  if (!req.png && !req.svg) {
    throw new AxiError("nothing to render", "request --png and/or --svg");
  }
  if (!Number.isFinite(req.scale) || req.scale <= 0) {
    throw new AxiError(`invalid scale: ${req.scale}`, "use a positive number, e.g. --scale 2");
  }
  if (!Number.isFinite(req.padding) || req.padding < 0) {
    throw new AxiError(`invalid padding: ${req.padding}`, "use a non-negative number of px, e.g. --padding 20");
  }
  if (!Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0) {
    throw new AxiError(`invalid timeout: ${req.timeoutMs}`, "use a positive number of ms, e.g. --timeout 30000");
  }
  const scene: SceneData | undefined = req.scene;
  if (!scene || !Array.isArray(scene.elements)) {
    throw new AxiError("scene has no elements array", "pass a valid .excalidraw scene");
  }
}

function launch(info: InstalledBrowser, timeout: number): Promise<LaunchedBrowser> {
  return launchContext(info, { timeout, context: { serviceWorkers: "block" } });
}

function buildResult(
  out: { png?: string; svg?: string; scale: number; sideLimit: number; minFont: number; svgWidth?: number; svgHeight?: number },
  browser: InstalledBrowser,
  fontWarning: string | undefined,
  req: RenderRequest,
): RenderResult {
  const result: RenderResult = { width: 0, height: 0, browser: browser.name };
  if (out.png !== undefined) {
    const png = Buffer.from(out.png, "base64");
    if (png.length < 24 || !png.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new AxiError("the browser could not encode the scene as PNG", "try a smaller diagram or a lower --scale");
    }
    result.png = png;
    result.width = png.readUInt32BE(16);
    result.height = png.readUInt32BE(20);
  }
  if (out.svg !== undefined) {
    result.svg = out.svg;
    if (out.png === undefined) {
      result.width = Math.round(out.svgWidth ?? 0);
      result.height = Math.round(out.svgHeight ?? 0);
    }
  }
  const warnings: string[] = [];
  const sizeWarning = scaleWarning(out, req, result.width, result.height);
  if (sizeWarning) {
    warnings.push(sizeWarning);
  }
  if (fontWarning) {
    warnings.push(fontWarning);
  }
  if (warnings.length > 0) {
    result.warning = warnings.join("; ");
  }
  return result;
}

/**
 * The warning for a scale the size caps lowered, or undefined. Three cases: the usual 2048 px cap
 * applied; the cap was raised (up to 16384 px) to keep the smallest text legible; or even the raised cap
 * could not, so the text is below the minimum size and the diagram should change shape.
 */
export function scaleWarning(
  out: { scale: number; sideLimit: number; minFont: number },
  req: Pick<RenderRequest, "scale" | "minFontPx" | "exactScale">,
  width: number,
  height: number,
): string | undefined {
  if (out.scale >= req.scale * 0.999) return undefined;
  const reduced = `scale reduced from ${req.scale} to ${out.scale.toFixed(2)}`;
  const minFontPx = req.minFontPx ?? MIN_FONT_PX;
  const font = out.minFont * out.scale;
  const illegible = !req.exactScale && minFontPx > 0 && out.minFont > 0 && font < minFontPx * 0.99;
  if (illegible) {
    return `${reduced} to stay within ${out.sideLimit} px / 64 MP; text renders at ${font.toFixed(1)} px (under ${minFontPx} px), too wide or tall to read: change dir or split the diagram`;
  }
  if (out.sideLimit > MAX_SIDE && !req.exactScale) {
    return `${reduced}: output is ${width}x${height} px, beyond the usual ${MAX_SIDE} px cap, to keep text at least ${minFontPx} px; a diagram this wide or tall is hard to read, consider changing dir or splitting it`;
  }
  return `${reduced} to stay within ${out.sideLimit} px / 64 MP`;
}

function launchFailure(info: InstalledBrowser, error: unknown): AxiError {
  if (error instanceof AxiError) return error; // already worded (e.g. a busy profile pool)
  return new AxiError(
    `could not start ${info.name} at ${info.path}: ${describeLaunchError(error)}`,
    `pass --browser-path <exe> or set ${BROWSER_ENV} to use another Chrome, Chromium, Edge or Firefox`,
  );
}

/**
 * Playwright's launch errors repeat the browser's whole command line in a call log. Keeps the
 * reason and the last lines the browser printed to stderr, which usually say what went wrong.
 */
function describeLaunchError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const [reason = "", ...lines] = error.message.split("\n");
  const output = new Set(lines.flatMap((line) => /^\s*(?:- )?\[pid=\d+\]\[err\] (.+)$/.exec(line)?.[1] ?? []));
  return [
    reason.replace(/^browserType\.launch\w*: /, ""),
    ...[...output].slice(-MAX_BROWSER_OUTPUT_LINES).map((line) => `  ${line}`),
  ].join("\n");
}

/** Drops Playwright's wrapper prefix and the call log from an in-page error. */
function cleanBrowserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n")[0] ?? message;
  return first.replace(/^page\.evaluate: /, "").replace(/^Error: /, "");
}
