// Hand-written and generated RawGraph fixtures for the aggregate/emit tests (no scanner involved).

import type { RawEdge, RawFile, RawGraph } from "../../../../src/extract/types.js";

export type EdgeSpec = [from: string, to: string, opts?: { line?: number; type?: boolean; dyn?: boolean }];
export type FileSpec = string | { path: string; test?: boolean; loc?: number };

export function raw(files: FileSpec[], edges: EdgeSpec[], extra: Partial<RawGraph> = {}): RawGraph {
  const fs: RawFile[] = files
    .map((f) => (typeof f === "string" ? { path: f } : f))
    .map((f) => ({ path: f.path, lang: "ts" as const, test: "test" in f ? (f.test ?? false) : /\.test\./.test(f.path), loc: "loc" in f ? (f.loc ?? 10) : 10, exports: 1 }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const es: RawEdge[] = edges.map(([from, to, o], i) => ({
    from, to, specifier: `./${to.split("/").pop()}`, line: o?.line ?? i + 1, typeOnly: o?.type ?? false, dynamic: o?.dyn ?? false, kind: o?.dyn ? "dynamic" : "import",
  }));
  return {
    schema: 1,
    meta: { root: "src", langs: ["ts"], extractor: { name: "fixture", version: "0" } },
    files: fs, edges: es, externals: [], builtins: [], unresolved: [], skipped: [], warnings: [],
    ...extra,
  };
}

/** ~15 files in 3 directories: a 2-file cycle, a type-only edge, a dynamic edge, a test, externals. */
export function smallApp(): RawGraph {
  return raw(
    [
      "index.ts", "cli/main.ts", "cli/args.ts", "cli/help.ts", "core/engine.ts", "core/parse.ts", "core/emit.ts", "core/types.ts",
      "util/log.ts", "util/path.ts", "util/fmt.ts", { path: "test/engine.test.ts" }, { path: "core/engine.test.ts" }, "dist/bundle.ts", "types.d.ts",
    ],
    [
      ["index.ts", "cli/main.ts"], ["index.ts", "core/engine.ts"],
      ["cli/main.ts", "cli/args.ts"], ["cli/main.ts", "cli/help.ts"], ["cli/main.ts", "core/engine.ts"], ["cli/main.ts", "util/log.ts"],
      ["cli/args.ts", "util/log.ts"], ["cli/help.ts", "util/fmt.ts"],
      ["core/engine.ts", "core/parse.ts"], ["core/engine.ts", "core/emit.ts"], ["core/engine.ts", "util/log.ts"], ["core/engine.ts", "util/path.ts"],
      ["core/engine.ts", "core/types.ts", { type: true }],
      ["core/parse.ts", "core/emit.ts"], ["core/parse.ts", "core/emit.ts", { line: 40 }], ["core/emit.ts", "core/parse.ts"],
      ["core/parse.ts", "core/types.ts", { type: true }], ["core/emit.ts", "util/fmt.ts", { dyn: true }],
      ["util/log.ts", "util/fmt.ts"], ["util/path.ts", "util/fmt.ts"],
      ["test/engine.test.ts", "core/engine.ts"], ["core/engine.test.ts", "core/engine.ts"], ["dist/bundle.ts", "index.ts"],
    ],
    {
      externals: [{ name: "zod", count: 3, files: 2 }, { name: "@scope/pkg", count: 1, files: 1 }, { name: "lodash", count: 2, files: 2 }],
      builtins: [{ name: "fs", count: 2, files: 2 }],
      unresolved: [{ file: "cli/main.ts", specifier: "./gone", line: 9, reason: "not-found" }],
    },
  );
}

/** A few directories where one file is imported by everything (a hub) and one pair is cyclic. */
export function hubApp(): RawGraph {
  const users = Array.from({ length: 12 }, (_, i) => `feat/u${String(i).padStart(2, "0")}.ts`);
  return raw(
    ["shared/ast.ts", "shared/util.ts", "main.ts", ...users],
    [
      ...users.map((u): EdgeSpec => [u, "shared/ast.ts"]),
      ...users.slice(0, 3).map((u): EdgeSpec => [u, "shared/util.ts"]),
      ["main.ts", "feat/u00.ts"], ["main.ts", "feat/u01.ts"], ["feat/u01.ts", "feat/u00.ts"], ["feat/u00.ts", "feat/u01.ts"],
    ],
  );
}

/** Deterministic pseudo-random: 12 packages x 5 subdirs x 5 files = 300 files, ~1200 edges, one global hub. */
export function synthetic(seed = 1, packages = 12): RawGraph {
  let s = seed >>> 0;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
  const pad = (n: number): string => String(n).padStart(2, "0");
  const files: string[] = [];
  for (let p = 0; p < packages; p++) for (let d = 0; d < 5; d++) for (let f = 0; f < 5; f++) files.push(`pkg${pad(p)}/s${d}/f${f}.ts`);
  const edges: EdgeSpec[] = [];
  for (const from of files) {
    const [pkg, sub] = from.split("/") as [string, string];
    const p = Number(pkg.slice(3));
    const d = Number(sub.slice(1));
    for (let k = 0; k < 4; k++) {
      const layered = rnd(100) >= 1; // ~1% of edges point "up" and create cycles
      const same = p === 0 || rnd(10) < 7;
      const tp = same ? p : layered ? rnd(p) : rnd(packages);
      const td = tp === p && layered ? d + rnd(5 - d) : rnd(5);
      const target = `pkg${pad(tp)}/s${td}/f${rnd(5)}.ts`;
      if (target !== from) edges.push([from, target, { type: rnd(10) === 0 }]);
    }
    if (rnd(3) === 0 && from !== "pkg00/s0/f0.ts") edges.push([from, "pkg00/s0/f0.ts"]);
  }
  return raw(files, edges);
}
