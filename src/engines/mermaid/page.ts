// The Mermaid browser page (KTD3): a second page, separate from the Excalidraw renderer page so their
// globals and CSS never meet. It is served from a virtual origin (no server, no network), loads the
// IIFE bundle that scripts/build-mermaid.mjs writes to dist/render/ and the one embedded font. One page
// per session, reused across renders; the calls into it are serialized because they share
// `mermaid.initialize` state.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright-core";
import { AxiError } from "../../output/errors.js";
import { BROWSER_ENV, findBrowser, type InstalledBrowser } from "../../render/browser.js";
import { launchContext } from "../../render/launch.js";

export const MERMAID_ORIGIN = "http://mermaid-renderer.local";
const BUNDLE_NAME = "mermaid-elk.iife.js";

/**
 * Liberation Sans Regular (metric-compatible with Arial), the font Excalidraw's bundle ships; its
 * dist/fonts/<sha256>.woff2 is served to the page, so text measures the same on every machine.
 */
export const MERMAID_FONT_HASH = "006a2b28cbbeeaec937d1b367d0949f5f48ef4b2e7b4e1d8dc7a799d2d639be8";
/** Falls back to Arial (same metrics) for viewers that open the SVG without the font. */
export const MERMAID_FONT_FAMILY = '"Liberation Sans", Arial, Helvetica, sans-serif';

const FONT_PATH = `/fonts/${MERMAID_FONT_HASH}.woff2`;
const PAGE_HTML =
  `<!doctype html><meta charset="utf-8"><title>Mermaid render</title>` +
  `<style>@font-face{font-family:"Liberation Sans";src:url(${MERMAID_ORIGIN}${FONT_PATH}) format("woff2")}` +
  `html,body{margin:0}#host{display:inline-block}</style><div id="host"></div><script src="${MERMAID_ORIGIN}/mermaid.js"></script>`;

/** dist/render/mermaid-elk.iife.js: next to the compiled modules (dist/engines/mermaid -> dist/render), or from source. */
export function bundleUrl(): URL {
  const built = new URL(`../../render/${BUNDLE_NAME}`, import.meta.url);
  return existsSync(built) ? built : new URL(`../../../dist/render/${BUNDLE_NAME}`, import.meta.url);
}

function fontUrl(): URL {
  const built = new URL(`../../fonts/${MERMAID_FONT_HASH}.woff2`, import.meta.url);
  return existsSync(built) ? built : new URL(`../../../dist/fonts/${MERMAID_FONT_HASH}.woff2`, import.meta.url);
}

/** True when the bundle is built (the engine's `status` reads this; it never builds). */
export function bundleExists(): boolean {
  return existsSync(bundleUrl());
}

export interface MermaidBrowser {
  context: BrowserContext;
  info: InstalledBrowser;
  close(): Promise<void>;
}

/** Launches an installed browser (no download); closed by `close()`. */
export async function launchBrowser(browserPath?: string, timeoutMs = 30_000): Promise<MermaidBrowser> {
  const info = await findBrowser(browserPath);
  try {
    const launched = await launchContext(info, { timeout: timeoutMs, context: { serviceWorkers: "block" } });
    return { context: launched.context, info, close: () => launched.close() };
  } catch (error) {
    if (error instanceof AxiError) throw error; // already worded (e.g. a busy profile pool)
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    throw new AxiError(
      `could not start ${info.name} at ${info.path}: ${first.replace(/^browserType\.launch\w*: /, "")}`,
      `pass --browser-path <exe> or set ${BROWSER_ENV} to use another Chrome, Chromium, Edge or Firefox`,
    );
  }
}

export class MermaidPage {
  private tail: Promise<unknown> = Promise.resolve();
  closed = false;

  private constructor(private readonly page: Page) {}

  /** Opens a new page in `context` and loads the bundle and the font; a fresh page has no render state. */
  static async open(context: BrowserContext): Promise<MermaidPage> {
    const [bundle, font] = await Promise.all([
      readFile(bundleUrl()).catch(() => {
        throw new AxiError(
          `mermaid bundle not found at ${bundleUrl().pathname}`,
          "run `npm run build` (scripts/build-mermaid.mjs writes dist/render/mermaid-elk.iife.js)",
        );
      }),
      readFile(fontUrl()).catch(() => {
        throw new AxiError(`font ${MERMAID_FONT_HASH}.woff2 not found in dist/fonts`, "run `npm run build` (scripts/build-renderer.mjs writes dist/fonts/)");
      }),
    ]);
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const respond = async () => {
        if (url.origin !== MERMAID_ORIGIN) await route.abort();
        else if (url.pathname === "/") await route.fulfill({ contentType: "text/html", body: PAGE_HTML });
        else if (url.pathname === "/mermaid.js") await route.fulfill({ contentType: "text/javascript", body: bundle });
        else if (url.pathname === FONT_PATH) await route.fulfill({ contentType: "font/woff2", body: font });
        else await route.abort();
      };
      await respond().catch(() => undefined);
    });
    await page.goto(`${MERMAID_ORIGIN}/`);
    const ready = await page.evaluate(async () => {
      await document.fonts.load('16px "Liberation Sans"');
      return { mermaid: typeof (window as unknown as { mermaid?: unknown }).mermaid, font: document.fonts.check('16px "Liberation Sans"') };
    });
    if (ready.mermaid !== "object" || !ready.font) {
      await page.close().catch(() => undefined);
      throw new AxiError("the mermaid page did not start (bundle or font failed to load)", "run `npm run build` and try again");
    }
    return new MermaidPage(page);
  }

  /** Runs `fn` in the page, one call at a time; rejects after `timeoutMs` and closes the page. */
  run<A, R>(fn: (arg: A) => R | Promise<R>, arg: A, timeoutMs = 30_000): Promise<R> {
    const job = this.tail.then(async () => {
      if (this.closed) throw new AxiError("the mermaid page is closed", "retry the command");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void this.close();
          reject(new AxiError(`mermaid timed out after ${timeoutMs} ms`, "try a smaller diagram or raise --timeout"));
        }, timeoutMs);
      });
      try {
        // Playwright serializes `fn` into the page; its argument and result are plain JSON.
        return await Promise.race([this.page.evaluate(fn as (a: unknown) => R | Promise<R>, arg as unknown) as Promise<R>, timeout]);
      } finally {
        clearTimeout(timer);
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  /** PNG of the `<svg>` currently in `#host`, at the SVG's own size (CSS px). */
  async screenshot(transparent: boolean): Promise<Buffer> {
    const job = this.tail.then(() => this.page.locator("#host svg").screenshot({ omitBackground: transparent, animations: "disabled" }));
    this.tail = job.catch(() => undefined);
    return job;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.page.close().catch(() => undefined);
  }
}

// ---- the process-wide session the engine object uses ----

interface Session {
  key: string;
  mermaidBrowser: MermaidBrowser;
  page: MermaidPage;
}

let current: Promise<Session> | undefined;

async function startSession(key: string, browserPath: string | undefined, timeoutMs: number): Promise<Session> {
  const mermaidBrowser = await launchBrowser(browserPath, timeoutMs);
  try {
    return { key, mermaidBrowser, page: await MermaidPage.open(mermaidBrowser.context) };
  } catch (error) {
    await mermaidBrowser.close();
    throw error;
  }
}

/** The shared browser + page, started on first use (cold start: browser launch plus the 6 MB bundle). */
export async function getSession(browserPath?: string, timeoutMs = 30_000): Promise<{ page: MermaidPage; browser: InstalledBrowser }> {
  const key = browserPath ?? "";
  if (current) {
    const existing = await current.catch(() => undefined);
    if (existing && existing.key === key && !existing.page.closed) return { page: existing.page, browser: existing.mermaidBrowser.info };
    await disposeSession();
  }
  current = startSession(key, browserPath, timeoutMs);
  current.catch(() => {
    current = undefined;
  });
  const s = await current;
  return { page: s.page, browser: s.mermaidBrowser.info };
}

/** Closes the shared browser. Callers that used the engine must call this before the process can exit. */
export async function disposeSession(): Promise<void> {
  const s = current;
  current = undefined;
  const session = await s?.catch(() => undefined);
  await session?.page.close();
  await session?.mermaidBrowser.close();
}
