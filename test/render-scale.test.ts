// Wide / tall diagram policy for PNG output: the 2048 px side cap yields to a minimum rendered font size
// (11 px) up to 16384 px, an explicit --scale is honoured, and a diagram that is still too wide warns.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { drawCommand } from "../src/commands/draw.js";
import { renderCommand } from "../src/commands/render.js";
import { readRenderOptions } from "../src/commands/shared.js";
import { findBrowser, type InstalledBrowser } from "../src/render/browser.js";
import type { RenderRequest, SceneData } from "../src/render/outputs.js";
import { renderScene, scaleWarning } from "../src/render/render.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/render-smoke.excalidraw", import.meta.url), "utf8")) as SceneData;

/** The smoke scene plus one more text element `span` px to the right, so the scene is about `span` px wide. */
function wideScene(span: number, fontSize = 20): SceneData {
  const text = (fixture.elements as { type: string }[]).find((e) => e.type === "text");
  const far = { ...text, id: "far", index: "z9", x: span, y: 0, fontSize, containerId: null, boundElements: null };
  return { ...fixture, elements: [...fixture.elements, far] };
}

describe("scaleWarning", () => {
  const req = { scale: 1 };
  it("is silent when the scale was not reduced", () => {
    expect(scaleWarning({ scale: 1, sideLimit: 2048, minFont: 20 }, req, 800, 200)).toBeUndefined();
  });
  it("names the usual cap when it applied", () => {
    expect(scaleWarning({ scale: 0.9, sideLimit: 2048, minFont: 20 }, req, 2048, 300)).toBe("scale reduced from 1 to 0.90 to stay within 2048 px / 64 MP");
  });
  it("says the cap was raised for legibility", () => {
    const w = scaleWarning({ scale: 0.6, sideLimit: 16384, minFont: 20 }, req, 8000, 100) ?? "";
    expect(w).toMatch(/beyond the usual 2048 px cap/);
    expect(w).toMatch(/at least 11 px/);
    expect(w).toMatch(/dir/);
  });
  it("warns about illegible text and suggests dir or splitting when even 16384 px is not enough", () => {
    const w = scaleWarning({ scale: 0.3, sideLimit: 16384, minFont: 20 }, req, 16384, 20) ?? "";
    expect(w).toMatch(/text renders at 6\.0 px \(under 11 px\)/);
    expect(w).toMatch(/change dir or split/);
  });
  it("does not talk about legibility for an explicit scale", () => {
    const w = scaleWarning({ scale: 0.5, sideLimit: 16384, minFont: 20 }, { scale: 1, exactScale: true }, 16384, 50) ?? "";
    expect(w).toBe("scale reduced from 1 to 0.50 to stay within 16384 px / 64 MP");
  });
});

describe("explicit --scale detection", () => {
  it("marks --scale as explicit only when it was typed", () => {
    const typed = parseArgs(["a.exd", "--scale", "1"], drawCommand.spec);
    expect(typed.explicit.has("scale")).toBe(true);
    expect(readRenderOptions(typed.flags, typed.explicit).exactScale).toBe(true);
    const typedEq = parseArgs(["a.excalidraw", "--png", "--scale=2"], renderCommand.spec);
    expect(readRenderOptions(typedEq.flags, typedEq.explicit)).toMatchObject({ scale: 2, exactScale: true });
    const none = parseArgs(["a.exd", "--png"], drawCommand.spec);
    expect(none.explicit.has("scale")).toBe(false);
    expect(readRenderOptions(none.flags, none.explicit)).toMatchObject({ scale: 1 });
    expect(readRenderOptions(none.flags, none.explicit).exactScale).toBeUndefined();
  });
});

describe("renderer wide-diagram policy (browser)", () => {
  let browser: InstalledBrowser | undefined;
  beforeAll(async () => {
    browser = await findBrowser().catch(() => undefined);
  });
  const need = (ctx: TestContext) => {
    if (!browser) ctx.skip("no browser installed");
  };
  const render = (scene: SceneData, extra: Partial<RenderRequest> = {}) =>
    renderScene({ scene, png: true, svg: false, scale: 1, padding: 20, transparent: false, timeoutMs: 30_000, browserPath: browser?.path, ...extra });

  it("keeps the 2048 px default for diagrams whose text stays legible", async (ctx) => {
    need(ctx);
    // ~2900 px wide: the 2048 cap gives scale 0.7, text 14 px or more.
    const result = await render(wideScene(2800));
    expect(result.width).toBeGreaterThan(2000);
    expect(result.width).toBeLessThanOrEqual(2048);
    expect(result.warning).toMatch(/to stay within 2048 px/);
  });

  it("raises the side cap so the smallest text stays at least 11 px", async (ctx) => {
    need(ctx);
    // ~8000 px wide: the 2048 cap would give scale 0.26 (5 px text); the floor is 11/20 = 0.55.
    const result = await render(wideScene(8000));
    expect(result.width).toBeGreaterThan(2048);
    expect(result.width).toBeLessThanOrEqual(16384);
    expect(result.warning).toMatch(/beyond the usual 2048 px cap/);
    expect(result.warning).toMatch(/dir/);
  });

  it("uses the smallest font in the scene for the floor", async (ctx) => {
    need(ctx);
    // 16 px text needs scale 11/16 = 0.6875: ~4200 px scene -> at least ~2800 px wide.
    const result = await render(wideScene(4200, 16));
    expect(result.width).toBeGreaterThan(2700);
  });

  it("warns and suggests dir/splitting when even 16384 px cannot make the text legible", async (ctx) => {
    need(ctx);
    const result = await render(wideScene(40_000));
    expect(result.width).toBeLessThanOrEqual(16384);
    expect(result.warning).toMatch(/text renders at .* px \(under 11 px\)/);
    expect(result.warning).toMatch(/change dir or split/);
  });

  it("honours an explicit scale up to 16384 px", async (ctx) => {
    need(ctx);
    const result = await render(wideScene(5000), { scale: 1, exactScale: true });
    expect(result.width).toBeGreaterThan(5000);
    expect(result.warning).toBeUndefined();
    const small = await render(wideScene(5000), { scale: 0.2, exactScale: true });
    expect(small.width).toBeLessThan(1200);
    expect(small.warning).toBeUndefined();
  });

  it("leaves an explicit minFontPx of 0 as the plain 2048 px cap", async (ctx) => {
    need(ctx);
    const result = await render(wideScene(8000), { minFontPx: 0 });
    expect(result.width).toBeLessThanOrEqual(2048);
  });
});
