// The retry net in renderD2 (extract hardening F7c): when an arrow still runs through a node after the detour repair, the
// source is compiled once more with its edge blocks reversed and the better drawing is kept. The detour is switched off
// here, so the retry is the only thing that can clean the fixture.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/engines/d2/detour.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/engines/d2/detour.js")>();
  return { ...real, repairThroughNodes: () => ({ found: 0, repaired: 0 }) };
});

const { throughHits, reorderEdgeBlocks } = await import("../src/engines/d2/detour.js");
const { renderD2 } = await import("../src/engines/d2/render.js");
const { disposeD2 } = await import("../src/engines/d2/wasm.js");

afterAll(async () => {
  await disposeD2();
});

const source = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/d2/${name}`, import.meta.url)), "utf8");

describe("renderD2 retry with the reversed edge order", () => {
  it("cleans an order whose ELK routes run through a node, without any detour", async () => {
    const src = source("through-node-excalidraw.d2");
    const alt = reorderEdgeBlocks(src)!;
    expect(alt).toBeDefined();
    const out = await renderD2(src);
    expect(throughHits(out.neutral)).toEqual([]);
    // the drawing is the one the reversed source gives
    const direct = await renderD2(alt);
    expect(out.svg).toBe(direct.svg);
  }, 60_000);

  it("keeps the first drawing when the alternative is not better", async () => {
    // a source that is not in translate.ts's shape has no alternative order: no retry, the first compile stands
    const plain = "direction: down\na: A\nb: B\nc: C\na -> b\nb -> c\na -> c\n";
    expect(reorderEdgeBlocks(plain)).toBeUndefined();
    const out = await renderD2(plain);
    expect(out.svg).toContain("<svg");
    expect(throughHits(out.neutral)).toEqual([]);
  }, 60_000);
});
