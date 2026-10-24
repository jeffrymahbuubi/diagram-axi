// Renderer tests. They drive an installed Chrome/Edge through playwright-core, so the suite skips
// itself when no browser is found. They need dist/renderer.js and dist/fonts/ from
// `node scripts/build-renderer.mjs` (`npm run test:render` builds first).

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { chromium, type BrowserContext } from "playwright-core";
import { afterEach, beforeAll, describe, expect, it, vi, type TestContext } from "vitest";
import { renderError } from "../src/output/errors.js";
import { BROWSER_ENV, findBrowser, type InstalledBrowser } from "../src/render/browser.js";
import { profileRoot } from "../src/render/profile-slots.js";
import type { RenderRequest, SceneData } from "../src/render/outputs.js";
import { renderScene } from "../src/render/render.js";

const scene = JSON.parse(readFileSync(new URL("./fixtures/render-smoke.excalidraw", import.meta.url), "utf8")) as SceneData;

const request = (overrides: Partial<RenderRequest> = {}): RenderRequest => ({
  scene,
  png: true,
  svg: false,
  scale: 1,
  padding: 20,
  transparent: false,
  timeoutMs: 30_000,
  ...overrides,
});

/** RGBA of the top-left pixel of an 8-bit RGBA PNG (the first pixel is unaffected by row filters). */
function firstPixel(png: Uint8Array): number[] {
  const buffer = Buffer.from(png);
  expect(buffer.readUInt8(24)).toBe(8); // bit depth
  expect(buffer.readUInt8(25)).toBe(6); // color type: RGBA
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  return [...inflateSync(Buffer.concat(idat)).subarray(1, 5)];
}

describe("renderer (AE3)", () => {
  const saved = process.env[BROWSER_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[BROWSER_ENV];
    else process.env[BROWSER_ENV] = saved;
  });

  it("a missing DIAGRAM_AXI_BROWSER_PATH browser names --browser-path", async () => {
    process.env[BROWSER_ENV] = "/nonexistent";
    const error = await renderScene(request()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const text = renderError(error as never);
    expect(text).toContain("--browser-path");
    expect(text).toContain(BROWSER_ENV);
    expect(text).toContain("nonexistent");
  });

  it("an explicit --browser-path that does not exist also fails clearly", async () => {
    await expect(findBrowser("/nonexistent/chrome")).rejects.toThrow(/not found or not executable.*--browser-path/);
  });
});

describe("renderer (browser)", () => {
  let browser: InstalledBrowser | undefined;

  beforeAll(async () => {
    browser = await findBrowser().catch(() => undefined);
  });

  const needBrowser = (ctx: TestContext) => {
    if (!browser) ctx.skip("no browser installed");
  };

  it("renders PNG and SVG in one page", async (ctx) => {
    needBrowser(ctx);
    const result = await renderScene(request({ png: true, svg: true, browserPath: browser?.path }));
    expect(Buffer.from(result.png ?? []).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(Buffer.from(result.png ?? []).readUInt32BE(16)).toBe(result.width);
    expect(result.browser).toBe(browser?.name);
    expect(result.svg).toContain("<svg");
    expect(result.svg).toMatch(/@font-face\s*\{\s*font-family:\s*Excalifont/);
    expect(result.warning).toBeUndefined();
  });

  it("renders SVG alone with the scene size", async (ctx) => {
    needBrowser(ctx);
    const result = await renderScene(request({ png: false, svg: true, browserPath: browser?.path }));
    expect(result.png).toBeUndefined();
    expect(result.svg).toContain("<svg");
    expect(result.width).toBeGreaterThan(0);
  });

  it("honours transparent", async (ctx) => {
    needBrowser(ctx);
    const opaque = await renderScene(request({ browserPath: browser?.path }));
    const clear = await renderScene(request({ transparent: true, browserPath: browser?.path }));
    expect(firstPixel(opaque.png ?? new Uint8Array())).toEqual([255, 255, 255, 255]);
    expect(firstPixel(clear.png ?? new Uint8Array())[3]).toBe(0);
  });

  it("caps the output at 2048 px and says so", async (ctx) => {
    needBrowser(ctx);
    const result = await renderScene(request({ scale: 100, browserPath: browser?.path }));
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(2048);
    expect(result.width).toBeGreaterThan(1900);
    expect(result.warning).toMatch(/scale reduced/);
  });

  it("does not touch the network with --fonts-url none and warns about CJK text", async (ctx) => {
    needBrowser(ctx);
    const cjk = structuredClone(scene) as SceneData & { elements: { id: string; text?: string; originalText?: string }[] };
    const label = cjk.elements.find((element) => element.id === "a-t");
    if (label) {
      label.text = "客戶端";
      label.originalText = "客戶端";
    }
    // An empty font cache keeps the test independent of earlier downloads.
    const cache = mkdtempSync(join(tmpdir(), "diagram-axi-fonts-"));
    const savedEnv = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
    process.env.LOCALAPPDATA = cache;
    process.env.XDG_CACHE_HOME = cache;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const result = await renderScene(request({ scene: cjk, fontsUrl: "none", browserPath: browser?.path }));
      expect(result.warning).toMatch(/font downloads are disabled/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("a 1 ms timeout rejects with the timeout message and closes the browser", async (ctx) => {
    needBrowser(ctx);
    // Chromium launches on a pooled persistent profile (src/render/launch.ts); the context must be closed
    // and its profile slot released after the timeout.
    const launched: Promise<BrowserContext>[] = [];
    const closed: boolean[] = [];
    const original = chromium.launchPersistentContext.bind(chromium);
    const spy = vi.spyOn(chromium, "launchPersistentContext").mockImplementation((dir, options) => {
      const promise = original(dir, options);
      const index = launched.push(promise) - 1;
      closed[index] = false;
      promise.then((context) => context.on("close", () => (closed[index] = true))).catch(() => undefined);
      return promise;
    });
    try {
      await expect(renderScene(request({ timeoutMs: 1, browserPath: browser?.path }))).rejects.toThrow(
        /rendering timed out after 1 ms/,
      );
      expect(launched).toHaveLength(1);
      await launched[0];
      expect(closed[0]).toBe(true);
      const root = profileRoot();
      const mine = existsSync(root)
        ? readdirSync(root).filter((f) => f.endsWith(".lock") && readFileSync(join(root, f), "utf8").trim() === String(process.pid))
        : [];
      expect(mine).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
