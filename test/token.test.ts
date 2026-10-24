// Token-cost advantage over the Excalidraw MCP (plan U8). Uses chars/4 estimates;
// the MCP cheat sheet is extracted from excalidraw-mcp/src/server.ts when a copy
// is reachable, else the vendored char count in scripts/token-compare.mjs.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { measure } from "../scripts/token-compare.mjs";

interface Row {
  approach: string;
  chars: number;
  tokens: number;
}

const result = measure() as {
  rows: Row[];
  ratios: { dslVsMcp: number; sliceVsSheet: number; dslVsScene: number };
};
const row = (name: string): Row => {
  const r = result.rows.find((x) => x.approach === name);
  if (!r) throw new Error(`missing row ${name}`);
  return r;
};

describe("token cost vs Excalidraw MCP", () => {
  it("DSL + syntax slice is <= 1/4 of MCP JSON + cheat sheet", () => {
    expect(row("dsl+slice").tokens * 4).toBeLessThanOrEqual(row("mcp-json+sheet").tokens);
    expect(result.ratios.sliceVsSheet).toBeLessThanOrEqual(1 / 4);
  });

  it("DSL is <= 1/5 of MCP JSON", () => {
    expect(row("dsl").tokens * 5).toBeLessThanOrEqual(row("mcp-json").tokens);
    expect(result.ratios.dslVsMcp).toBeLessThanOrEqual(1 / 5);
  });

  it("DSL is <= 1/20 of the .excalidraw scene an agent would write for a plain Excalidraw CLI", () => {
    expect(row("dsl").tokens * 20).toBeLessThanOrEqual(row("excalidraw-scene").tokens);
    expect(result.ratios.dslVsScene).toBeLessThanOrEqual(1 / 20);
  });

  it("measures non-trivial inputs (guards against an empty fixture)", () => {
    expect(row("dsl").chars).toBeGreaterThan(100);
    expect(row("mcp-json").chars).toBeGreaterThan(1000);
    expect(row("mcp-json+sheet").chars).toBeGreaterThan(row("mcp-json").chars + 5000);
  });
});
