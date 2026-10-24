// Entry detection (package.json bin/main/module -> scanned source, index.* fallback) and extract's density limit.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACT_DENSE_MIN_NODES, EXTRACT_DENSE_RATIO, denseReason } from "../src/extract/density.js";
import { candidates, detectEntry, entryCandidates, exportLeaves, importLeaves, sourcemapSources } from "../src/extract/entry.js";
import { tsExtractor } from "../src/extract/ts/scan.js";
import { fixture, tempDir, write } from "./helpers/run.js";

describe("entry candidates", () => {
  it("maps build output back to sources", () => {
    expect(candidates("./dist/cjs/index.js")).toEqual(expect.arrayContaining(["dist/cjs/index.js", "dist/cjs/index.ts", "src/index.ts", "src/index.tsx", "index.ts"]));
    expect(candidates("lib/cli/main.mjs")).toContain("src/cli/main.ts");
    expect(candidates("bin/tool.js")).toEqual(["bin/tool.js", "bin/tool.ts", "bin/tool.tsx", "bin/tool.jsx", "bin/tool.mjs", "bin/tool.cjs"]);
  });
  it("ignores declaration files and globs", () => {
    expect(candidates("dist/index.d.ts")).toEqual([]);
    expect(candidates("dist/*.js")).toEqual([]);
    expect(candidates("")).toEqual([]);
  });
});

describe("detectEntry", () => {
  const set = (...p: string[]): Set<string> => new Set(p);
  it("prefers bin (sorted by name), then main, then module", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ main: "dist/lib.js", module: "dist/esm.js", bin: { zed: "dist/zed.js", abc: "dist/abc.js" } }));
    const src = join(dir, "src");
    expect(detectEntry(src, set("lib.ts", "esm.ts", "zed.ts", "abc.ts"))).toBe("abc.ts");
    expect(detectEntry(src, set("lib.ts", "esm.ts"))).toBe("lib.ts");
    expect(detectEntry(src, set("esm.ts"))).toBe("esm.ts");
  });
  it("finds package.json in a parent folder and ignores unreadable ones", () => {
    const dir = tempDir();
    write(dir, "package.json", "{ not json");
    expect(detectEntry(join(dir, "a/b"), set("index.js"))).toBe("index.js");
    expect(detectEntry(join(dir, "a/b"), set("x.ts"))).toBeUndefined();
  });
  it("a scan root deeper than the package (monorepo) resolves main relative to the package", () => {
    const dir = tempDir();
    write(dir, "packages/p/package.json", JSON.stringify({ main: "./src/index.ts" }));
    expect(detectEntry(join(dir, "packages/p"), set("src/index.ts"))).toBe("src/index.ts");
    expect(detectEntry(join(dir, "packages/p/src"), set("index.ts"))).toBe("index.ts");
  });
  it("falls back to index.* at the scan root, ts before js", () => {
    const dir = tempDir();
    expect(detectEntry(dir, set("index.js", "index.ts"))).toBe("index.ts");
    expect(detectEntry(dir, set("sub/index.ts"))).toBeUndefined();
  });
});

describe("denseReason", () => {
  const view = (n: number, m: number) => ({
    edges: Array.from({ length: m }, (_, i) => ({ from: `n${i % n}`, to: `n${(i + 1) % n}`, stub: false })),
  });
  it("needs EXTRACT_DENSE_MIN_NODES connected boxes and more than EXTRACT_DENSE_RATIO edges per box (one line from 12 boxes on)", () => {
    expect(EXTRACT_DENSE_MIN_NODES).toBe(12);
    expect(EXTRACT_DENSE_RATIO).toBe(1.5);
    expect(denseReason(view(12, 19))).toBe("dense: 19 edges on 12 boxes");
    expect(denseReason(view(12, 18))).toBeUndefined();
    expect(denseReason(view(14, 22))).toBe("dense: 22 edges on 14 boxes");
    expect(denseReason(view(16, 24))).toBeUndefined();
    expect(denseReason(view(16, 25))).toBe("dense: 25 edges on 16 boxes");
    expect(denseReason(view(11, 40))).toBeUndefined();
  });
  it("the QA round 1-3 numbers: rejected views are dense, accepted ones are not", () => {
    for (const [n, m] of [[23, 43], [18, 32], [14, 29], [25, 50], [15, 30], [24, 38], [14, 24], [13, 22]] as const) expect(denseReason(view(n, m)), `${n}/${m}`).toBeDefined();
    for (const [n, m] of [[8, 14], [19, 24], [20, 24], [12, 18]] as const) expect(denseReason(view(n, m)), `${n}/${m}`).toBeUndefined();
  });
  it("7 arrows into one box are dense even when the ratio is low; 6 are not (accepted views peak at 6)", () => {
    const into = (k: number) => ({
      edges: [
        ...Array.from({ length: k }, (_, i) => ({ from: `a${i}`, to: "hub", stub: false })),
        ...Array.from({ length: 12 - k - 1 }, (_, i) => ({ from: `b${i}`, to: `b${i + 1}`, stub: false })),
      ],
    });
    expect(denseReason(into(7))).toBe("dense: 7 arrows into one box");
    expect(denseReason(into(6))).toBeUndefined();
  });
  it("stub lines do not count", () => {
    expect(denseReason({ edges: [...view(12, 18).edges, ...Array.from({ length: 10 }, (_, i) => ({ from: "n0", to: `s${i}`, stub: true }))] })).toBeUndefined();
  });
});

describe("detectEntry with edges", () => {
  const set = (...p: string[]): Set<string> => new Set(p);
  it("skips a stub that has no edge and takes the next candidate that has one", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ bin: { x: "./x.mjs" }, main: "./dist/index.js" }));
    write(dir, "x.mjs", 'import "./dist/cli.js";\n');
    expect(detectEntry(dir, set("x.mjs", "src/index.ts"))).toBe("x.mjs");
    expect(detectEntry(dir, set("x.mjs", "src/index.ts"), set("src/index.ts"))).toBe("src/index.ts");
  });
  it("follows the stub's own import (dist -> src) when the main does not help", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ bin: { x: "./x.mjs" } }));
    write(dir, "x.mjs", 'import "./dist/app.js";\n');
    expect(detectEntry(dir, set("x.mjs", "src/app.ts"), set("src/app.ts"))).toBe("src/app.ts");
  });
  it("is undefined when nothing starts a linked file", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ bin: { x: "./x.mjs" } }));
    write(dir, "x.mjs", 'import "./dist/gone.js";\n');
    expect(detectEntry(dir, set("x.mjs", "src/other.ts"), set("src/other.ts"))).toBeUndefined();
    expect(detectEntry(dir, set("x.mjs"), set())).toBeUndefined();
  });
});

// ---- F6: exports/imports leaves, basename fallback, sourcemaps (fixtures under test/fixtures/extract/pkg-exports) ----

const pkgFixture = (name: string): string => fixture(`extract/pkg-exports/${name}`);

/** The scanned file set and the files with an import edge for a fixture package, like `extract` computes them. */
async function scanned(root: string): Promise<{ files: Set<string>; linked: Set<string> }> {
  const raw = await tsExtractor.extract({ root, rootLabel: "." });
  const linked = new Set<string>();
  for (const e of raw.edges) if (e.from !== e.to && !e.typeOnly) (linked.add(e.from), linked.add(e.to));
  return { files: new Set(raw.files.map((f) => f.path)), linked };
}

describe("exportLeaves / importLeaves", () => {
  it('puts "." first, sorts the subpaths, walks conditions and arrays, drops .d.ts, globs, json and css', () => {
    const leaves = exportLeaves({
      "./z": "./dist/z.js",
      "./a": { types: "./dist/a.d.ts", default: ["./dist/a.js", "./dist/a.cjs"] },
      "./package.json": "./package.json",
      "./feat/*": "./dist/feat/*.js",
      "./x.css": "./x.css",
      ".": { src: "./src/index.ts", import: { types: "./i.d.mts", default: "./dist/index.mjs" } },
    });
    expect(leaves).toEqual(["./src/index.ts", "./dist/index.mjs", "./dist/a.js", "./dist/a.cjs", "./dist/z.js"]);
  });
  it("treats a string, an array or a bare condition object as the . entry", () => {
    expect(exportLeaves("./dist/i.js")).toEqual(["./dist/i.js"]);
    expect(exportLeaves(["./a.js", "./b.js"])).toEqual(["./a.js", "./b.js"]);
    expect(exportLeaves({ types: "./i.d.ts", import: "./i.mjs", require: "./i.cjs" })).toEqual(["./i.mjs", "./i.cjs"]);
    expect(exportLeaves(undefined)).toEqual([]);
    expect(exportLeaves(null)).toEqual([]);
  });
  it("imports: sorted by alias, package specifiers dropped", () => {
    expect(importLeaves({ "#b": { source: "./src/b.ts", default: "./dist/b.js" }, "#a": "./dist/a.js", "#dep": "some-package", "#c": { node: "some-package/x", default: "./c.mjs" } })).toEqual(["./dist/a.js", "./src/b.ts", "./dist/b.js", "./c.mjs"]);
    expect(importLeaves("nope")).toEqual([]);
  });
});

describe("detectEntry: exports, basename fallback, sourcemaps", () => {
  it("a source condition inside the scan is a candidate without naming the key (custom-source)", async () => {
    const root = pkgFixture("source-key");
    const { files, linked } = await scanned(root);
    expect(entryCandidates(root, files, linked)[0]).toBe("src/entry.ts");
    expect(detectEntry(root, files, linked)).toBe("src/entry.ts");
    expect(detectEntry(root, files)).toBe("src/entry.ts");
  });
  it('"." outranks the sorted subpaths even when ./extra is declared first; a subpath is the fallback when "." has no edge', async () => {
    const root = pkgFixture("source-key");
    const { files } = await scanned(root);
    expect(entryCandidates(root, files)).toEqual(["src/entry.ts", "src/extra.ts"]);
    expect(detectEntry(root, files, new Set(["src/extra.ts", "src/impl.ts"]))).toBe("src/extra.ts");
  });
  it("dist stem mismatch: dist/index.js with sources in src/public/index.ts resolves by the unique shallowest basename", async () => {
    const root = pkgFixture("stem");
    const { files, linked } = await scanned(root);
    expect(files).toContain("src/lib/helpers/index.ts");
    expect(detectEntry(root, files, linked)).toBe("src/public/index.ts");
    expect(detectEntry(root, files)).toBe("src/public/index.ts");
  });
  it("an ambiguous basename (two files at the shallowest depth) is no entry", async () => {
    const root = pkgFixture("ambiguous");
    const { files, linked } = await scanned(root);
    expect(files).toEqual(new Set(["src/a/main.ts", "src/b/main.ts", "src/shared.ts"]));
    expect(detectEntry(root, files, linked)).toBeUndefined();
    expect(detectEntry(root, files)).toBeUndefined();
    // a twin without an import edge does not make it ambiguous
    expect(detectEntry(root, files, new Set(["src/a/main.ts", "src/shared.ts"]))).toBe("src/a/main.ts");
  });
  it("basename fallback ranks below an index.* at the scan root, and below every direct manifest hit", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ main: "./dist/app.js", exports: { ".": "./dist/other.js" } }));
    const f = (...p: string[]) => new Set(p);
    expect(entryCandidates(dir, f("deep/er/app.ts", "index.js"))).toEqual(["index.js", "deep/er/app.ts"]);
    expect(entryCandidates(dir, f("src/app.ts", "src/other.ts"))).toEqual(["src/app.ts", "src/other.ts"]);
    // test files and declarations never match; the shallower of two wins
    expect(entryCandidates(dir, f("test/app.ts", "src/app.test.ts", "a/app.d.ts"))).toEqual([]);
    expect(entryCandidates(dir, f("a/b/app.ts", "a/app.ts"))).toEqual(["a/app.ts"]);
  });
  it("non-build-dir manifest paths get no basename fallback", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ main: "./bin/cli.js" }));
    expect(entryCandidates(dir, new Set(["src/cli.ts"]))).toEqual([]);
  });
  it("sourcemap: sources of <main>.map map to a scanned file (node_modules skipped)", async () => {
    const root = pkgFixture("sourcemap");
    const { files, linked } = await scanned(root);
    expect(entryCandidates(root, files, linked)).toEqual(["src/app/start.ts"]);
    expect(detectEntry(root, files, linked)).toBe("src/app/start.ts");
  });
  it("sourcemap: the source with the built file's stem comes first, then the listed order; absent or broken maps are skipped", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ main: "./out/cli.js", module: "./out/lib.js", exports: { ".": "./out/gone.js" } }));
    write(dir, "out/cli.js.map", JSON.stringify({ version: 3, sourceRoot: "../src", sources: ["a.ts", "cli.ts"] }));
    write(dir, "out/lib.js.map", "{ broken");
    const files = new Set(["src/a.ts", "src/cli.ts"]);
    expect(entryCandidates(dir, files)).toEqual(["src/cli.ts"]);
    expect(sourcemapSources(dir, join(dir, "out/cli.js"), files)).toEqual(["src/cli.ts", "src/a.ts"]);
    expect(sourcemapSources(dir, join(dir, "out/lib.js"), files)).toEqual([]);
    expect(sourcemapSources(dir, join(dir, "out/gone.js"), files)).toEqual([]);
  });
  it("the current order stays: bin, main, module, then exports, then root index", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ bin: "./b.js", main: "./m.js", module: "./mod.js", exports: { ".": "./e.js" } }));
    expect(entryCandidates(dir, new Set(["index.ts", "e.js", "mod.js", "m.js", "b.js"]))).toEqual(["b.js", "m.js", "mod.js", "e.js", "index.ts"]);
  });
  it("imports are the last manifest source", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ exports: "./e.js", imports: { "#x": "./x.js" } }));
    expect(entryCandidates(dir, new Set(["x.js", "e.js"]))).toEqual(["e.js", "x.js"]);
  });
});
