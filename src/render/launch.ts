// The one place that starts an installed browser, shared by the Excalidraw renderer, the D2 PNG step and
// the Mermaid session. Chromium-family browsers run on a persistent profile from a slot pool (see
// profile-slots.ts) so that Chromium's Windows blank-password check, a failed OS logon that is cached per
// profile, happens once per slot and not once per launch. Firefox is launched as before.

import { chromium, firefox, type BrowserContext, type BrowserContextOptions } from "playwright-core";
import { AxiError } from "../output/errors.js";
import type { InstalledBrowser } from "./browser.js";
import { acquireSlot, PROFILE_MODE_ENV, PROFILE_SLOTS_ENV, profilesDisabled, SlotsBusyError, type Slot } from "./profile-slots.js";

export interface LaunchOptions {
  /** Playwright launch timeout, ms. */
  timeout: number;
  /** Options for the page context (viewport, deviceScaleFactor, serviceWorkers, ...). */
  context?: BrowserContextOptions;
  /** Slot pool settings (tests). */
  slots?: Parameters<typeof acquireSlot>[0];
}

export interface LaunchedBrowser {
  /** Open pages from here with `context.newPage()`. */
  context: BrowserContext;
  /** Which profile the launch used: a pooled slot directory, or `temp` (a fresh profile, one OS logon). */
  profile: string;
  /** Closes the browser and frees the slot. Never throws. */
  close(): Promise<void>;
}

/**
 * Chromium flags on top of Playwright's defaults (which already pass --disable-extensions, --no-first-run
 * and --no-default-browser-check). The profile outlives the launch, so the HTTP cache is turned down to a
 * single byte: nothing a render saw can come back from disk in the next one.
 */
export const CHROMIUM_ARGS = ["--disk-cache-size=1", "--media-cache-size=1"];

/** Starts `info` headless. Rejects with Playwright's launch error; the caller words it. */
export async function launchContext(info: InstalledBrowser, options: LaunchOptions): Promise<LaunchedBrowser> {
  if (info.kind === "firefox") {
    // An installed Firefox is driven over WebDriver BiDi; Playwright's own Firefox protocol needs its patched build.
    const browser = await firefox.launch({ executablePath: info.path, channel: "moz-firefox", headless: true, timeout: options.timeout });
    return fromBrowser(browser, options);
  }

  // A busy pool waits (up to the launch timeout) and then fails: falling back to a temp profile would
  // cost one failed Windows logon per fallback, exactly when many browsers run in parallel.
  let slot: Slot | undefined;
  try {
    slot = profilesDisabled() ? undefined : await acquireSlot({ waitMs: options.timeout, failWhenBusy: true, ...options.slots });
  } catch (error) {
    if (!(error instanceof SlotsBusyError)) throw error;
    throw new AxiError(
      `${error.message}; another diagram-axi run is using them`,
      `wait and rerun, or raise ${PROFILE_SLOTS_ENV}; ${PROFILE_MODE_ENV}=temp uses a fresh profile (on Windows each one costs a failed OS logon)`,
    );
  }
  if (!slot) {
    // Opted out, or the pool directory is unusable: a fresh temp profile works the same but costs one OS logon.
    const browser = await chromium.launch({ executablePath: info.path, headless: true, timeout: options.timeout, args: CHROMIUM_ARGS });
    return fromBrowser(browser, options);
  }

  try {
    const context = await chromium.launchPersistentContext(slot.dir, {
      ...options.context,
      executablePath: info.path,
      headless: true,
      timeout: options.timeout,
      args: CHROMIUM_ARGS,
    });
    // Cookies are the only per-origin state a page could leave behind; none are wanted.
    await context.clearCookies().catch(() => undefined);
    return { context, profile: slot.dir, close: () => closeAll(() => context.close(), slot) };
  } catch (error) {
    slot.release();
    throw error;
  }
}

async function fromBrowser(browser: Awaited<ReturnType<typeof chromium.launch>>, options: LaunchOptions): Promise<LaunchedBrowser> {
  try {
    const context = await browser.newContext(options.context);
    return { context, profile: "temp", close: () => closeAll(() => browser.close()) };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function closeAll(close: () => Promise<void>, slot?: Slot): Promise<void> {
  try {
    await close();
  } catch {
    // already closed or crashed
  } finally {
    slot?.release();
  }
}
