// `diagram-axi extract` through the built bin: TOON shape, files, exit codes, determinism, `check` on the output.
// Golden: test/golden/extract/ts-app-cli.exd (regenerate with UPDATE_GOLDEN=1).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixture, run, tempDir, write } from "./helpers/run.js";

const APP = fixture("extract/ts-app");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "golden", "extract", "ts-app-cli.exd");
const tokens = (s: string): number => Math.ceil(s.length / 4);
const read = (p: string): string => readFileSync(p, "utf8");

/** Runs `extract <path> ...` writing into a fresh temp dir; returns the run and the output base. */
function extract(args: string[], opts: { cwd?: string; path?: string } = {}) {
  const out = join(tempDir(), "imports");
  const r = run(["extract", opts.path ?? APP, "--out", out, ...args], { cwd: opts.cwd });
  return { r, out, exd: `${out}.exd`, map: `${out}.exd.map.json` };
}

describe("extract: output shape", () => {
  const { r, exd, map } = extract([]);
  it("prints the TOON summary and writes both files", () => {
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toMatch(/^extract: ok, 15 files, 23 import edges in .*ts-app \(js, ts\)$/);
    expect(lines[1]).toMatch(/^graph: 14 nodes \(14 files\) in 6 groups, 18 edges; hidden: 4 externals, 1 test file, 4 type-only$/);
    expect(lines[2]).toBe("cycles: 1 (src/app/cycle-a.ts, src/app/cycle-b.ts)");
    expect(lines[3]).toBe("unresolved: 0");
    expect(r.stdout).toContain("outputs[2]{kind,path,bytes}:");
    expect(r.stdout).toMatch(/\n {2}exd,.*imports\.exd,\d+\n {2}map,.*imports\.exd\.map\.json,\d+\n/);
    expect(existsSync(exd)).toBe(true);
    expect(existsSync(map)).toBe(true);
    expect(JSON.parse(read(map)).schema).toBe(1);
  });
  it("suggests d2 first in help[] when the router does", () => {
    expect(r.stdout).toMatch(/\nengine: suggest d2 \(cross-linked: \d+ cross-group edges\); add --engine d2\n/);
    expect(r.stdout).toMatch(/\nhelp\[\d\]:\n {2}diagram-axi draw .*imports\.exd --engine d2 --png\n {2}diagram-axi extract .* --focus .* --depth 2\n/);
  });
  it("stays within ~25 lines", () => {
    expect(r.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
  });
});

describe("extract: --engine", () => {
  it("--engine d2 drops the engine line and keeps d2 in the draw hint", () => {
    const { r } = extract(["--engine", "d2"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^engine:/m);
    expect(r.stdout).toMatch(/draw .*imports\.exd --engine d2 --png/);
  });
  it("--engine excalidraw draws without --engine", () => {
    const { r } = extract(["--engine", "excalidraw"]);
    expect(r.stdout).toMatch(/draw .*imports\.exd --png/);
    expect(r.stdout).not.toMatch(/^engine:/m);
  });
  it("--engine auto applies the suggestion", () => {
    const { r } = extract(["--engine", "auto"]);
    expect(r.stdout).toMatch(/^engine: d2 \(/m);
    expect(r.stdout).toMatch(/--engine d2 --png/);
  });
  it("a small graph prints no engine line", () => {
    const { r } = extract(["--max-nodes", "6", "--group", "none"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^engine: suggest/m);
  });
});

describe("extract: golden and check", () => {
  it("the ts-app default view is byte-stable (run from the fixture dir)", () => {
    const { r, exd } = extract([], { cwd: APP, path: "src" });
    expect(r.status).toBe(0);
    const text = read(exd);
    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, text);
    }
    expect(text).toBe(read(GOLDEN));
  });
  it("the emitted .exd passes `check` with 0 errors (warnings allowed)", () => {
    for (const args of [[], ["--group", "none"], ["--types", "--externals", "show"], ["--hubs", "show"]]) {
      const { exd } = extract(args);
      const c = run(["check", exd]);
      expect(c.status, c.stdout).toBe(0);
      expect(c.stdout).toMatch(/^check: ok, 0 errors,/);
      for (const m of c.stdout.matchAll(/^ {2}\d+,\d+,([a-z-]+),/gm)) expect(["cross-group-edges", "dense-graph"]).toContain(m[1]);
    }
  });
});

describe("extract: determinism", () => {
  it("two runs write byte-identical .exd and .map.json", () => {
    const a = extract(["--types", "--externals", "count"]);
    const b = extract(["--types", "--externals", "count"]);
    expect(read(a.exd)).toBe(read(b.exd));
    expect(read(a.map)).toBe(read(b.map));
  });
});

describe("extract: overwrite", () => {
  it("refuses without --force (exit 1), then replaces with it", () => {
    const first = extract([]);
    const again = run(["extract", APP, "--out", first.out]);
    expect(again.status).toBe(1);
    expect(again.stdout).toMatch(/^error: refusing to overwrite .*imports\.exd/);
    expect(again.stdout).toContain("--force");
    const forced = run(["extract", APP, "--out", first.out, "--force"]);
    expect(forced.status).toBe(0);
  });
  it("defaults to ./imports.exd in the cwd", () => {
    const dir = tempDir();
    const r = run(["extract", APP], { cwd: dir });
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "imports.exd"))).toBe(true);
    expect(existsSync(join(dir, "imports.exd.map.json"))).toBe(true);
    expect(r.stdout).toMatch(/\n {2}exd,imports\.exd,\d+\n {2}map,imports\.exd\.map\.json,\d+\n/);
  });
});

describe("extract: --focus", () => {
  it("zooms on a file and reports what was cut", () => {
    const { r, exd } = extract(["--focus", join(APP, "src/core/index.ts"), "--depth", "1"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^focus: src\/core\/index\.ts \(depth 1, both\), \d+ files reached$/m);
    expect(r.stdout).toMatch(/files? out of focus/);
    expect(read(exd)).toContain("index.ts");
    expect(r.stdout).toMatch(/--focus .*core\/index\.ts --depth 2/);
  });
  it("accepts a path relative to <path> as well", () => {
    expect(extract(["--focus", "src/core/index.ts"]).r.status).toBe(0);
  });
  it("a --focus outside <path> is a usage error", () => {
    const r = extract(["--focus", join(REPO, "package.json")]).r;
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^error: --focus .* is not under /);
  });
  it("a --focus under <path> that matches nothing is a usage error", () => {
    const r = extract(["--focus", join(APP, "src/nope.ts")]).r;
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^error: --focus .* matches no scanned file or folder/);
  });
});

describe("extract: flags", () => {
  it.each([
    [["--depth", "0"]],
    [["--depth", "x"]],
    [["--max-nodes", "-3"]],
    [["--group", "tree"]],
    [["--format", "xml"]],
    [["--bogus"]],
    [["--tsconfig", "nope/tsconfig.json"]],
  ])("%j exits 2", (args) => {
    const r = extract(args as string[]).r;
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^error: /);
  });
  it("a missing <path> argument exits 2", () => {
    expect(run(["extract"]).status).toBe(2);
  });
  it("--format json writes the scan graph instead of the .exd", () => {
    const { r, out } = extract(["--format", "json"]);
    expect(r.status).toBe(0);
    expect(existsSync(`${out}.exd`)).toBe(false);
    const g = JSON.parse(read(`${out}.json`));
    expect(g.schema).toBe(1);
    expect(g.files).toHaveLength(15);
    expect(r.stdout).toMatch(/\n {2}json,.*imports\.json,\d+\n/);
  });
  it("--group none is flat with path labels", () => {
    const { exd } = extract(["--group", "none"]);
    const text = read(exd);
    expect(text).not.toMatch(/^group /m);
    expect(text).toContain("core/index.ts");
  });
  it("--max-nodes bounds the view", () => {
    const { r } = extract(["--max-nodes", "6"]);
    expect(r.status).toBe(0);
    const n = Number(/^graph: (\d+) nodes/m.exec(r.stdout)?.[1]);
    expect(n).toBeLessThanOrEqual(6);
  });
  it("--exclude and --include are applied by the scanner", () => {
    expect(extract(["--exclude", "ui"]).r.stdout).toMatch(/^extract: ok, 14 files/);
    expect(extract(["--include", "src/core/**"]).r.stdout).toMatch(/^extract: ok, 3 files/);
  });
  it("--tests keeps test files", () => {
    const { r } = extract(["--tests"]);
    expect(r.stdout).not.toContain("test file");
  });
});

describe("extract: failures and unresolved", () => {
  it("a missing path, an empty folder and a file all exit 1 with a suggestion", () => {
    const dir = tempDir();
    for (const p of [join(dir, "nope"), dir, join(APP, "tsconfig.json")]) {
      const r = run(["extract", p, "--out", join(dir, "o")]);
      expect(r.status, p).toBe(1);
      expect(r.stdout).toMatch(/^error: /);
      expect(r.stdout).toContain("suggestion:");
    }
  });
  it("lists unresolved imports (8 rows, N of M) and still exits 0", () => {
    const dir = tempDir();
    write(dir, "src/a.ts", Array.from({ length: 10 }, (_, i) => `import "./missing${i}";`).join("\n") + "\n");
    write(dir, "src/b.ts", 'import "./a";\n');
    const r = run(["extract", join(dir, "src"), "--out", join(dir, "o")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("unresolved[8 of 10 total]{file,specifier,reason}:");
    expect(r.stdout).toMatch(/\n {2}a\.ts:1,\.\/missing0,not-found\n/);
    expect(r.stdout).toMatch(/^warnings\[\d\]:\n {2}no tsconfig found/m);
  });
});

describe("extract: help and syntax", () => {
  it("--help documents the flags once each, with examples", () => {
    const r = run(["extract", "--help"]);
    expect(r.status).toBe(0);
    for (const f of ["--focus", "--depth", "--dir", "--level", "--max-nodes", "--expand", "--group", "--include", "--exclude", "--externals", "--types", "--tests", "--hubs", "--tsconfig", "--out", "--format", "--engine", "--force"]) {
      expect(r.stdout.match(new RegExp(`${f}(?![a-z-])`, "g")), f).not.toBeNull();
    }
    expect(r.stdout.match(/--engine/g)).toHaveLength(1);
    expect(r.stdout).toContain("examples[");
  });
  it("root --help lists extract", () => {
    expect(run(["--help"]).stdout).toContain("  extract,");
  });
  it("`syntax extract` is a slice within 350 tokens", () => {
    for (const args of [["syntax", "extract"], ["syntax", "exd", "extract"]]) {
      const r = run(args);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^syntax: extract,/);
      expect(tokens(r.stdout)).toBeLessThanOrEqual(350);
    }
  });
});

describe("extract: this repo (smoke)", () => {
  it("scans src/, resolves everything and the .exd passes check", () => {
    const out = join(tempDir(), "imports");
    const r = run(["extract", "src", "--out", out], { cwd: REPO });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^extract: ok, \d+ files, \d+ import edges in src \(ts\)$/m);
    expect(r.stdout).toMatch(/^unresolved: 0$/m);
    const nodes = Number(/^graph: (\d+) nodes/m.exec(r.stdout)?.[1]);
    expect(nodes).toBeLessThanOrEqual(25);
    const c = run(["check", `${out}.exd`], { cwd: REPO });
    expect(c.status, c.stdout).toBe(0);
    expect(c.stdout).toMatch(/^check: ok, 0 errors,/);
  });
});

/** n files `f00.ts ...`; file i imports i+1 and i+2 (`two`) or only i+1. */
function ladder(n: number, two: boolean): string {
  const dir = tempDir();
  for (let i = 0; i < n; i++) {
    const to = [i + 1, ...(two ? [i + 2] : [])].filter((j) => j < n).map((j) => `import "./f${String(j).padStart(2, "0")}";`);
    write(dir, `src/f${String(i).padStart(2, "0")}.ts`, `${to.join("\n")}\nexport const v = ${i};\n`);
  }
  return join(dir, "src");
}

describe("extract: dense views suggest d2 (also flat ones)", () => {
  it("14 boxes with 25 edges (1.79 per box) pass the shared router but not extract's limit", () => {
    const { r } = extract(["--group", "none"], { path: ladder(14, true) });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^graph: 14 nodes .*, 25 edges/m);
    expect(r.stdout).toMatch(/^engine: suggest d2 \(dense: 25 edges on 14 boxes\); add --engine d2$/m);
    expect(r.stdout).toMatch(/\n {2}diagram-axi draw .*imports\.exd --engine d2 --png\n/);
  });
  it("--engine auto applies it; an explicit --engine wins and stays quiet", () => {
    const path = ladder(14, true);
    expect(extract(["--engine", "auto"], { path }).r.stdout).toMatch(/^engine: d2 \(dense: 25 edges on 14 boxes\)$/m);
    const ex = extract(["--engine", "excalidraw"], { path }).r.stdout;
    expect(ex).not.toMatch(/^engine:/m);
    expect(ex).toMatch(/draw .*imports\.exd --png/);
  });
  it("a chain of 14 boxes (13 edges) and a small dense graph stay on excalidraw without an engine line", () => {
    const chain = extract([], { path: ladder(14, false) }).r.stdout;
    expect(chain).not.toMatch(/^engine:/m);
    expect(chain).toMatch(/draw .*imports\.exd --png/);
    expect(extract([], { path: ladder(8, true) }).r.stdout).not.toMatch(/^engine:/m);
  });
});

describe("extract: entry, isolated", () => {
  function pkg(main: string | undefined): string {
    const dir = tempDir();
    if (main) write(dir, "package.json", JSON.stringify({ name: "p", main }));
    write(dir, "src/server.ts", 'import "./a";\nimport "./b";\n');
    write(dir, "src/a.ts", 'import "./b";\n');
    write(dir, "src/b.ts", "export const b = 1;\n");
    write(dir, "src/lone.ts", "export const l = 1;\n");
    return join(dir, "src");
  }
  it("marks the package main (dist/server.js -> src/server.ts) green with an entry line", () => {
    const { exd } = extract([], { path: pkg("dist/server.js") });
    expect(read(exd)).toContain("[server.ts\\nentry] :green");
  });
  it("without a package main, an index.* at the scan root is the entry; otherwise none", () => {
    const dir = pkg(undefined);
    expect(read(extract([], { path: dir }).exd)).not.toContain("entry");
    write(dir, "index.ts", 'import "./server";\n');
    expect(read(extract([], { path: dir }).exd)).toContain("[index.ts\\nentry] :green");
  });
  it("--focus marks its file `focus`, or `entry` when it is the entry", () => {
    const path = pkg("dist/server.js");
    expect(read(extract(["--focus", "a.ts", "--depth", "1"], { path }).exd)).toContain("[a.ts\\nfocus] :green");
    expect(read(extract(["--focus", "server.ts"], { path }).exd)).toContain("[server.ts\\nentry] :green");
  });
  it("reports isolated files in the graph line and the sidecar, and keeps them out of the picture", () => {
    const { r, exd, map } = extract([], { path: pkg("dist/server.js") });
    expect(r.stdout).toMatch(/^graph: 3 nodes \(3 files\), 3 edges; hidden: none; isolated: 1 file$/m);
    expect(read(exd)).not.toContain("lone");
    expect(JSON.parse(read(map)).hidden.isolated).toEqual({ files: 1, items: [{ path: "lone.ts", kind: "file", files: 1 }], more: 0 });
  });
});

describe("extract: budget, group none, hub importers", () => {
  it("--group none says so when no folder is open (it would change nothing)", () => {
    const dir = tempDir();
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(2, "0");
      write(dir, `src/d${n}/a.ts`, i < 29 ? `import "../d${String(i + 1).padStart(2, "0")}/a";\n` : "export {};\n");
      write(dir, `src/d${n}/b.ts`, 'import "./a";\n');
    }
    const r = extract(["--group", "none"], { path: join(dir, "src") }).r;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--group none changes nothing here");
    expect(extract([], { path: join(dir, "src") }).r.stdout).not.toContain("--group none");
  });
  it("a folder of files that only import a hub is one box with an arrow into the entry hub", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ main: "index.js" }));
    write(dir, "index.js", 'require("./lib/a");\nrequire("./lib/b");\n');
    write(dir, "lib/a.js", "module.exports = 1;\n");
    write(dir, "lib/b.js", 'require("./a");\n');
    for (let i = 0; i < 12; i++) write(dir, `examples/e${i}.js`, 'require("..");\n');
    const { r, exd } = extract([], { path: dir });
    expect(r.status).toBe(0);
    const text = read(exd);
    expect(text).toContain("[examples/ (12 files)]");
    expect(text).toMatch(/d_examples -> f_index_js : x12/);
    expect(r.stdout).toMatch(/^graph: 4 nodes /m);
  });
});
