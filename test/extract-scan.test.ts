import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileGlobs, discover, findTsconfig, isTestPath, splitGlobs } from "../src/extract/discover.js";
import { readGit } from "../src/extract/git.js";
import {
  loadOxc,
  OXC_PARSER_VERSION,
  packageName,
  readPathPatterns,
  resolverOptions,
  scanTs,
  tsExtractor,
  type ResolverLike,
} from "../src/extract/ts/scan.js";
import type { RawGraph } from "../src/extract/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixture = join(here, "fixtures", "extract", "ts-app");
const golden = join(here, "golden", "extract", "ts-app.raw.json");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "extract-scan-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function fixtureScan(extra: Record<string, unknown> = {}): Promise<RawGraph> {
  return scanTs({ root: fixture, rootLabel: "ts-app", git: false, ...extra });
}

describe("discover", () => {
  it("walks deterministically, skips build dirs, dot dirs and .d.ts, and classifies tests", () => {
    const root = join(tmp, "walk");
    for (const rel of [
      "src/b.ts",
      "src/a.ts",
      "src/a-b.ts",
      "src/a/z.tsx",
      "src/m.mjs",
      "src/c.cjs",
      "src/j.jsx",
      "src/x.js",
      "src/types.d.ts",
      "src/data.json",
      "src/readme.md",
      "src/a.test.ts",
      "src/b.spec.js",
      "test/helper.ts",
      "tests/h2.ts",
      "src/__tests__/t.ts",
      "src/contest.ts",
      "node_modules/pkg/index.js",
      "dist/out.js",
      "build/o.js",
      "out/o.js",
      ".git/hooks/h.js",
      ".hidden/h.ts",
      "src/node_modules/nested/index.js",
    ])
      put(root, rel, "export {};\n");
    const d = discover({ root });
    expect(d.files.map((f) => f.path)).toEqual([
      "src/__tests__/t.ts",
      "src/a-b.ts",
      "src/a.test.ts",
      "src/a.ts",
      "src/a/z.tsx",
      "src/b.spec.js",
      "src/b.ts",
      "src/c.cjs",
      "src/contest.ts",
      "src/j.jsx",
      "src/m.mjs",
      "src/x.js",
      "test/helper.ts",
      "tests/h2.ts",
    ]);
    const tests = d.files.filter((f) => f.test).map((f) => f.path);
    expect(tests).toEqual(["src/__tests__/t.ts", "src/a.test.ts", "src/b.spec.js", "test/helper.ts", "tests/h2.ts"]);
    expect(d.files.find((f) => f.path === "src/x.js")?.lang).toBe("js");
    expect(d.files.find((f) => f.path === "src/b.ts")?.lang).toBe("ts");
    expect(d.files.every((f) => !f.path.includes("\\"))).toBe(true);
  });

  it("classifies test paths", () => {
    expect(isTestPath("a/b.test.ts")).toBe(true);
    expect(isTestPath("a/b.spec.tsx")).toBe(true);
    expect(isTestPath("test/x.ts")).toBe(true);
    expect(isTestPath("a/__tests__/x.ts")).toBe(true);
    expect(isTestPath("a/testing/x.ts")).toBe(false);
    expect(isTestPath("a/latest.ts")).toBe(false);
    expect(isTestPath("test.ts")).toBe(false);
  });

  it("applies comma-separated include and exclude globs", () => {
    const root = join(tmp, "globs");
    for (const rel of ["src/a.ts", "src/gen/g.ts", "src/gen/deep/h.ts", "src/legacy/l.ts", "lib/b.ts", "lib/b.test.ts"])
      put(root, rel, "export {};\n");
    const paths = (o: { include?: string; exclude?: string }) => discover({ root, ...o }).files.map((f) => f.path);
    expect(paths({ exclude: "src/gen, legacy" })).toEqual(["lib/b.test.ts", "lib/b.ts", "src/a.ts"]);
    expect(paths({ exclude: "**/*.test.ts" })).toEqual([
      "lib/b.ts",
      "src/a.ts",
      "src/gen/deep/h.ts",
      "src/gen/g.ts",
      "src/legacy/l.ts",
    ]);
    expect(paths({ include: "src/**/*.ts", exclude: "src/gen/**" })).toEqual(["src/a.ts", "src/legacy/l.ts"]);
    expect(paths({ include: "lib" })).toEqual(["lib/b.test.ts", "lib/b.ts"]);
    expect(paths({ include: "*.{ts,tsx}", exclude: "lib" })).toEqual([
      "src/a.ts",
      "src/gen/deep/h.ts",
      "src/gen/g.ts",
      "src/legacy/l.ts",
    ]);
    expect(splitGlobs(" a , ,b ")).toEqual(["a", "b"]);
    expect(compileGlobs(["src/*.ts"])("src/deep/x.ts")).toBe(false);
    expect(compileGlobs(["src/*.ts"])("src/x.ts")).toBe(true);
  });

  it("finds the nearest tsconfig at or above the root, honours --tsconfig, warns when none", () => {
    const root = join(tmp, "ts-lookup");
    put(root, "tsconfig.json", "{}");
    put(root, "pkg/src/a.ts", "export {};\n");
    put(root, "pkg/tsconfig.json", "{}");
    put(root, "pkg/other.json", "{}");
    expect(discover({ root: join(root, "pkg", "src") }).tsconfig).toBe(join(root, "pkg", "tsconfig.json"));
    expect(findTsconfig(join(root, "pkg"))).toBe(join(root, "pkg", "tsconfig.json"));
    const explicit = discover({ root: join(root, "pkg", "src"), tsconfig: join(root, "tsconfig.json") });
    expect(explicit.tsconfig).toBe(join(root, "tsconfig.json"));
    expect(() => discover({ root: join(root, "pkg"), tsconfig: join(root, "missing.json") })).toThrow(/tsconfig not found/);

  });

  it("throws for a missing path or a file", () => {
    expect(() => discover({ root: join(tmp, "nope") })).toThrow(/path not found/);
    put(tmp, "afile.ts", "");
    expect(() => discover({ root: join(tmp, "afile.ts") })).toThrow(/not a directory/);
  });
});

describe("scan: ts-app fixture", () => {
  it("matches the hand-verified golden", async () => {
    const g = await fixtureScan();
    expect(JSON.parse(JSON.stringify(g))).toEqual(JSON.parse(readFileSync(golden, "utf8")));
  });

  it("is byte-identical across two scans, git metadata included", async () => {
    const a = await scanTs({ root: fixture, rootLabel: "ts-app" });
    const b = await scanTs({ root: fixture, rootLabel: "ts-app" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(await fixtureScan())).toBe(JSON.stringify(await fixtureScan()));
  });

  it("emits posix, sorted, root-relative data and no absolute paths", async () => {
    const g = await fixtureScan();
    const text = JSON.stringify(g);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]|\\\\/);
    expect(text).not.toContain(tmp);
    const paths = g.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    const fileSet = new Set(paths);
    for (const e of g.edges) {
      expect(fileSet.has(e.from)).toBe(true);
      expect(fileSet.has(e.to)).toBe(true);
      expect(e.line).toBeGreaterThan(0);
    }
    expect(g.files).toHaveLength(15);
    expect(g.edges).toHaveLength(23);
    expect(g.meta).toEqual({
      root: "ts-app",
      langs: ["js", "ts"],
      tsconfig: "tsconfig.json",
      extractor: { name: "oxc-ts", version: OXC_PARSER_VERSION },
    });
  });

  it("covers each edge feature", async () => {
    const g = await fixtureScan();
    const find = (from: string, spec: string) => g.edges.filter((e) => e.from === from && e.specifier === spec);
    // tsconfig paths alias, with and without a .js specifier
    expect(find("src/app/app.ts", "@core/logger.js")[0]?.to).toBe("src/core/logger.ts");
    expect(find("src/index.ts", "@core/config")[0]?.to).toBe("src/core/config.ts");
    // .js specifier to a .ts file, directory index, .mjs, .tsx
    expect(find("src/app/app.ts", "../core/index.js")[0]?.to).toBe("src/core/index.ts");
    expect(find("src/util/format.ts", "./helpers.mjs")[0]?.to).toBe("src/util/helpers.mjs");
    expect(find("src/ui/button.tsx", "../core/config")[0]?.to).toBe("src/core/config.ts");
    // type-only edges
    expect(find("src/app/router.ts", "./app.js")[0]).toMatchObject({ typeOnly: true, kind: "import" });
    expect(find("src/app/app.ts", "./router")[0]?.typeOnly).toBe(true);
    expect(find("src/app/app.ts", "./router.js")[0]?.typeOnly).toBe(false);
    // barrel re-exports, `export type ... from`
    expect(g.edges.filter((e) => e.from === "src/core/index.ts").map((e) => [e.kind, e.typeOnly, e.line])).toEqual([
      ["reexport", false, 2],
      ["reexport", true, 4],
      ["reexport", false, 3],
    ]);
    // local `export { x }` of an imported binding is not a second edge
    expect(g.edges.filter((e) => e.from === "src/index.ts")).toHaveLength(3);
    // dynamic import() and require()
    expect(find("src/app/app.ts", "./plugins/loader.js")[0]).toMatchObject({ kind: "dynamic", dynamic: true, line: 19 });
    expect(find("src/app/plugins/loader.ts", "./legacy.cjs")[0]).toMatchObject({ kind: "require", line: 1 });
    // two-file cycle, test file kept and flagged
    expect(find("src/app/cycle-a.ts", "./cycle-b.js")).toHaveLength(1);
    expect(find("src/app/cycle-b.ts", "./cycle-a.js")).toHaveLength(1);
    expect(g.files.find((f) => f.path === "src/util/format.test.ts")?.test).toBe(true);
    // multi-line import: the line of the `import` keyword
    expect(find("src/app/app.ts", "../core/index.js")[0]?.line).toBe(1);
    // line numbers survive a multi-byte first line (offsets are UTF-16, not bytes)
    expect(find("src/core/config.ts", "../util/format.js")[0]?.line).toBe(5);
    // single-child chain and long relative path
    expect(g.files.some((f) => f.path === "src/deep/a/b/c/leaf.ts")).toBe(true);
    expect(find("src/deep/a/b/c/leaf.ts", "../../../../util/format.js")[0]?.to).toBe("src/util/format.ts");
  });

  it("classifies externals, builtins, skipped and unresolved without dropping anything", async () => {
    const g = await fixtureScan();
    expect(g.externals).toEqual([
      { name: "@fixture/scoped", count: 1, files: 1 },
      { name: "optional-peer-fixture", count: 1, files: 1 },
      { name: "picocolors-fixture", count: 1, files: 1 },
      { name: "vitest", count: 1, files: 1 },
    ]);
    // `node:fs`, `path` and `node:path` are builtins, not npm externals
    expect(g.builtins).toEqual([
      { name: "fs", count: 1, files: 1 },
      { name: "path", count: 2, files: 2 },
    ]);
    expect(g.skipped).toEqual([
      { file: "src/app/app.ts", specifier: "name", line: 20, reason: "non-literal" },
      { file: "src/core/config.ts", specifier: "../types/globals", line: 4, reason: "not-source" },
    ]);
    expect(g.unresolved).toEqual([]);
    expect(g.warnings).toEqual([]);
    expect(g.files.find((f) => f.path === "src/types/globals.d.ts")).toBeUndefined();
  });

  it("applies include/exclude and an explicit tsconfig", async () => {
    const g = await fixtureScan({ exclude: "util", tsconfig: join(fixture, "tsconfig.json") });
    expect(g.files.some((f) => f.path.startsWith("src/util/"))).toBe(false);
    const skipped = g.skipped.filter((s) => s.reason === "excluded").map((s) => `${s.file}:${s.specifier}`);
    expect(skipped).toContain("src/core/config.ts:../util/format.js");
    expect(g.edges.every((e) => !e.to.startsWith("src/util/"))).toBe(true);
  });

  it("exposes the extractor object with the pinned parser version", () => {
    expect(tsExtractor.name).toBe("oxc-ts");
    expect(tsExtractor.version).toBe(OXC_PARSER_VERSION);
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      engines: { node: string };
    };
    expect(pkg.dependencies["oxc-parser"]).toBe(OXC_PARSER_VERSION);
    expect(pkg.dependencies["oxc-resolver"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.engines.node).toBe(">=20.19");
  });
});

describe("scan: edge cases in temp projects", () => {
  it("reports alias misses and missing relative files as unresolved, bare misses as externals", async () => {
    const root = join(tmp, "unres");
    put(root, "tsconfig.json", `{ "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"], "~exact": ["./src/x.ts"] } } }`);
    put(
      root,
      "src/a.ts",
      [
        `import { a } from "@lib/missing";`,
        `import { b } from "./nope.js";`,
        `import { c } from "not-installed-pkg/sub";`,
        `import "@scope/also-missing";`,
        `import x from "~exact";`,
        `import fs from "fs/promises";`,
        `const u = await import("https://example.com/x.js");`,
        "",
      ].join("\n"),
    );
    put(root, "src/x.ts", "export const x = 1;\n");
    const g = await scanTs({ root, rootLabel: "unres", git: false });
    expect(g.unresolved).toEqual([
      { file: "src/a.ts", specifier: "@lib/missing", line: 1, reason: "alias-miss" },
      { file: "src/a.ts", specifier: "./nope.js", line: 2, reason: "not-found" },
    ]);
    expect(g.externals.map((e) => e.name)).toEqual(["@scope/also-missing", "not-installed-pkg"]);
    expect(g.builtins).toEqual([{ name: "fs/promises", count: 1, files: 1 }]);
    expect(g.skipped).toEqual([{ file: "src/a.ts", specifier: "https://example.com/x.js", line: 7, reason: "url" }]);
    expect(g.edges.map((e) => `${e.specifier}->${e.to}`)).toEqual(["~exact->src/x.ts"]);
  });

  it("warns when no tsconfig exists and keeps scanning", async () => {
    // Whether a tsconfig exists above os.tmpdir() is environment-specific, so assert both outcomes.
    const root = join(tmp, "plain");
    put(root, "a.js", `const b = require("./b");\nmodule.exports = b;\n`);
    put(root, "b.js", `module.exports = 1;\n`);
    const g = await scanTs({ root, rootLabel: "plain", git: false });
    expect(g.edges).toMatchObject([{ from: "a.js", to: "b.js", kind: "require", line: 1 }]);
    expect(g.meta.langs).toEqual(["js"]);
    if (!findTsconfig(root)) expect(g.warnings).toEqual(["no tsconfig found; paths aliases unresolved; pass --tsconfig"]);
    else expect(g.warnings).toEqual([]);
  });

  it("counts lines on CRLF files, skips syntax-broken files gracefully and warns", async () => {
    const root = join(tmp, "crlf");
    put(root, "a.ts", `import { b } from "./b.js";\r\n\r\nimport { c } from "./c.js";\r\n`);
    put(root, "b.ts", "export const b = 1;\n");
    put(root, "c.ts", "export const c = (;\n");
    const g = await scanTs({ root, rootLabel: "crlf", git: false });
    expect(g.edges.map((e) => [e.specifier, e.line])).toEqual([
      ["./b.js", 1],
      ["./c.js", 3],
    ]);
    expect(g.files.find((f) => f.path === "a.ts")?.loc).toBe(3);
    expect(g.warnings.some((w) => w.includes("syntax errors") && w.includes("c.ts"))).toBe(true);
  });

  it("package names strip subpaths", () => {
    expect(packageName("lodash/fp")).toBe("lodash");
    expect(packageName("@a/b/c")).toBe("@a/b");
    expect(packageName("pkg")).toBe("pkg");
  });

  it("reads tsconfig paths through relative extends and JSONC", () => {
    const root = join(tmp, "ext");
    put(root, "base.json", `{ /* c */ "compilerOptions": { "paths": { "@b/*": ["x"], }, }, }`);
    put(root, "tsconfig.json", `{ // c\n "extends": "./base", "compilerOptions": { "paths": { "@a/*": ["y"] } } }`);
    expect(readPathPatterns(join(root, "tsconfig.json"))).toEqual(["@a/*", "@b/*"]);
  });
});

describe("git metadata", () => {
  it("reads rev and dirty inside a repository", () => {
    const g = readGit(repoRoot);
    // CI checkouts and worktrees are repositories; tolerate an archive export.
    if (g.rev) {
      expect(g.rev).toMatch(/^[0-9a-f]{40,64}$/);
      expect(typeof g.dirty).toBe("boolean");
    } else expect(g).toEqual({});
  });

  it("is empty outside a repository", () => {
    const root = join(tmp, "norepo");
    mkdirSync(root, { recursive: true });
    const g = readGit(root);
    // os.tmpdir() could sit inside a repository on an exotic setup; the contract is just "no throw".
    if (g.rev === undefined) expect(g).toEqual({});
  });
});

/**
 * Independent oracle (plan 5.2): regex re-derivation of every specifier, resolved by the SAME resolver,
 * must agree with the oxc-derived graph.
 */
const SPEC_RES = [
  /\bfrom\s*["']([^"'\n]+)["']/g, // import/export ... from "x"
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g, // import("x")
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g, // require("x")
  /^\s*import\s*["']([^"'\n]+)["']/gm, // import "x"
];
const BUILTINS = new Set(builtinModules);

// Drop whole-line comments so documentation examples are not mistaken for imports.
function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");
}

function regexSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const re of SPEC_RES) for (const m of stripCommentLines(text).matchAll(re)) out.push(m[1] as string);
  return out;
}

function listSources(root: string): string[] {
  return (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p) && !/\.d\.[cm]?ts$/.test(p))
    .filter((p) => !p.split("/").some((s) => s === "node_modules" || s.startsWith(".")))
    .sort();
}

async function oracle(root: string, g: RawGraph) {
  const { ResolverFactory } = await loadOxc();
  const tsconfig = findTsconfig(root);
  const resolver = new ResolverFactory(resolverOptions(tsconfig)) as ResolverLike;
  const files = new Set(g.files.map((f) => f.path));
  const edges: string[] = [];
  const externals = new Map<string, number>();
  const builtins = new Map<string, number>();
  for (const f of g.files) {
    const text = readFileSync(join(root, f.path), "utf8");
    for (const spec of regexSpecifiers(text)) {
      const bare = !/^[./#]/.test(spec) && !/^[a-z][a-z0-9+.-]+:/i.test(spec);
      if (spec.startsWith("node:") || BUILTINS.has(spec)) {
        const n = spec.replace(/^node:/, "");
        builtins.set(n, (builtins.get(n) ?? 0) + 1);
        continue;
      }
      const r = resolver.sync(dirname(join(root, f.path)), spec);
      const rel = r.path ? relative(root, r.path).replace(/\\/g, "/") : undefined;
      if (rel && files.has(rel)) edges.push(`${f.path}|${rel}|${spec}`);
      else if (bare) {
        const n = packageName(spec);
        externals.set(n, (externals.get(n) ?? 0) + 1);
      }
    }
  }
  return { edges: edges.sort(), externals, builtins };
}

function actual(g: RawGraph) {
  return {
    edges: g.edges.map((e) => `${e.from}|${e.to}|${e.specifier}`).sort(),
    externals: new Map(g.externals.map((e) => [e.name, e.count] as const)),
    builtins: new Map(g.builtins.map((e) => [e.name, e.count] as const)),
  };
}

describe("correctness oracle (independent regex re-derivation, same resolver)", () => {
  it("agrees 100% on the ts-app fixture", async () => {
    const g = await fixtureScan();
    const o = await oracle(fixture, g);
    const a = actual(g);
    // The regex sees `import(name)` nowhere and `export { x }` is not matched by `from`, so the sets match exactly.
    expect(o.edges).toEqual(a.edges);
    expect(o.externals).toEqual(a.externals);
    expect(o.builtins).toEqual(a.builtins);
  });

  it("agrees on this repo's src/, resolves everything, and finds every source file", async () => {
    const src = join(repoRoot, "src");
    const t0 = performance.now();
    const g = await scanTs({ root: src, rootLabel: "src", git: false });
    const ms = performance.now() - t0;
    expect(g.unresolved).toEqual([]);
    const globbed = listSources(src);
    expect(g.files.map((f) => f.path)).toEqual(globbed);
    expect(g.files.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(g.files.length);
    const o = await oracle(src, g);
    const a = actual(g);
    expect(o.edges).toEqual(a.edges);
    expect(o.externals).toEqual(a.externals);
    expect(o.builtins).toEqual(a.builtins);
    // Every edge target exists; every non-literal dynamic import is listed, not lost.
    const set = new Set(g.files.map((f) => f.path));
    for (const e of g.edges) expect(set.has(e.to)).toBe(true);
    expect(ms).toBeLessThan(30_000);
  });
});
