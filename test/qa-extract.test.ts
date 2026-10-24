// scripts/qa/extract.mjs: the pinned corpora and the vision packet text (no clone, no browser).

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOLDOUT, REPOS, SETS, VIEWS, hubStats, visionPacket } from "../scripts/qa/extract.mjs";
import { tempDir } from "./helpers/run.js";

describe("qa extract corpora", () => {
  it("pins 5 held-out repos to peeled 40-hex shas, 4 views each", () => {
    expect(HOLDOUT.map((r: { name: string }) => r.name)).toEqual(["axios", "react-router", "vue-core", "nest", "svelte"]);
    for (const r of HOLDOUT as Array<{ sha: string; url: string; tag: string; sub: string; entry: string }>) {
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(r.url).toMatch(/^https:\/\/github\.com\/.+\.git$/);
      expect(r.tag).not.toMatch(/rc|beta|alpha|next/);
      expect(r.entry.startsWith(`${r.sub}/`)).toBe(true);
    }
    expect(VIEWS).toHaveLength(4);
    const names = [...REPOS, ...HOLDOUT].map((r: { name: string }) => r.name);
    expect(new Set(names).size).toBe(names.length); // case ids <repo>-<view> never collide across sets
    expect(SETS.core.out).toBe("out/qa-extract-r4");
    expect(SETS.holdout.out).toBe("out/qa-extract-holdout-r1");
  });

  it("hubStats follows the one-line hub note and counts only labels with more than 2 lines as crowded", () => {
    const exd = [
      "a[helper/ (9 files)\\nused by 20, 2 uses hidden] :yellow",
      "b[index.ts\\nentry, used by 3] :green",
      "c[x.ts\\nused by 4\\nuses 9 (7 shown)] :yellow",
      "d[engines/ (3 files)\\n3 uses hidden] :yellow",
      "e[lonely.ts]",
      "a -> b",
      "b -> c",
    ].join("\n");
    const h = hubStats(exd);
    expect(h.hubs).toBe(4);
    expect(h.crowded).toBe(1);
    expect(h.islands).toBe(1); // d has no edge
    expect(h.isolated).toBe(1);
  });
});

describe("vision packet text", () => {
  const packet = visionPacket([], "C:/work/out/qa-extract-holdout-r1", [{ name: "axios", entry: "lib/axios.js" }]);

  it("describes the current label formats and the stub lines", () => {
    expect(packet).toContain("used by N");
    expect(packet).toContain("K uses hidden");
    expect(packet).toContain("entry: <file>");
    expect(packet).toContain("focus: <file>");
    expect(packet).toContain("plain line without an arrowhead");
    expect(packet).not.toContain("uses K (M shown)");
    expect(packet).toContain("verdicts-1.json / verdicts-2.json");
  });

  it("lists PNGs by absolute path inside the output folder actually used", () => {
    const out = tempDir();
    mkdirSync(join(out, "png"), { recursive: true });
    writeFileSync(join(out, "png", "axios-default.png"), "x");
    const results = [{ case: "axios-default", repo: "axios", view: "default", draw: { engine: "d2" }, extract: { nodes: 5, edges: 6 } }];
    const text = visionPacket(results, out, [{ name: "axios", entry: "lib/axios.js" }]);
    expect(text).toContain(join(out, "png", "axios-default.png").split("\\").join("/"));
    expect(resolve(out)).toBe(out);
  });
});
