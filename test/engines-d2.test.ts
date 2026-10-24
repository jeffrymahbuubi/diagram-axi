// D2 engine (U2): translation goldens, compile-based validation, WASM render determinism, PNG in the browser.
// The optional binary: engines-d2-binary.test.ts. Geometry: engines-d2-geometry.test.ts.
// No network. Browser tests skip without a browser; binary tests skip without a d2 v0.9.0 binary
// (--d2-path / DIAGRAM_AXI_D2_PATH / cache / PATH).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { CACHE_DIR_ENV } from "../src/engines/cache.js";
import { D2_PATH_ENV, resolveD2Binary } from "../src/engines/d2/binary.js";
import { d2Engine } from "../src/engines/d2/index.js";
import { capScale, pageHtml } from "../src/engines/d2/png.js";
import { D2_RELEASE } from "../src/engines/d2/release.js";
import { renderD2 } from "../src/engines/d2/render.js";
import { translateGraph } from "../src/engines/d2/translate.js";
import { lintD2, toDiagnostic, validateD2 } from "../src/engines/d2/validate.js";
import { D2CompileError, d2Compile, d2WasmVersion, disposeD2, parseCompileErrors, stripD2Version, svgSize } from "../src/engines/d2/wasm.js";
import { engineFor, engineForExt, engineIds } from "../src/engines/registry.js";
import { findBrowser, type InstalledBrowser } from "../src/render/browser.js";

const update = process.env.UPDATE_GOLDEN === "1";
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const fixture = (name: string): string => readFileSync(here(`./fixtures/d2/${name}`), "utf8");
const goldenPath = (name: string): string => here(`./golden/d2/${name}`);

function matchGolden(name: string, actual: string): void {
  const file = goldenPath(name);
  if (update) writeFileSync(file, actual);
  else expect(actual, `golden ${name} (UPDATE_GOLDEN=1 rewrites)`).toBe(readFileSync(file, "utf8"));
}

/** The ten corpus cases whose translations are the bake-off `d2src` files, in both directions. */
const CASES = [
  "day-rag-agent",
  "day-microservices",
  "day-k8s-deployment",
  "day-cicd-pipeline",
  "day-decision-tree",
  "day-er-entity-map",
  "day-cache-aside",
  "edge-title-multiline",
  "edge-cjk-emoji",
  "edge-all-arrow-styles-and-flags",
];
const DIRECTIONS = ["DOWN", "RIGHT"] as const;
/** Small enough that the default PNG scale is not lowered by the 2048 px cap. */
const SMALL = "direction: right\na -> b";

const exd = (name: string): string => readFileSync(here(`./qa/corpus/${name}.exd`), "utf8");

afterAll(async () => {
  await disposeD2();
});

// ---- translation ----

describe("translate", () => {
  for (const name of CASES) {
    for (const direction of DIRECTIONS) {
      it(`${name} ${direction} equals the bake-off d2src`, () => {
        const { graph, diagnostics } = parse(exd(name));
        expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        const { source } = translateGraph(graph, { direction });
        matchGolden(`${name}-${direction}.d2`, source);
      });
    }
  }

  it("quotes reserved ids, escapes $ and newlines, qualifies container paths", () => {
    const { graph } = parse(['group style "Style" {', "  label[Cost $5]", "  shape(Two\\nlines)", "}", 'label -> shape : "x"'].join("\n"));
    const { source } = translateGraph(graph, { direction: "RIGHT" });
    expect(source).toContain('"style": "Style" {');
    expect(source).toContain('"label": "Cost \\$5" {');
    expect(source).toContain('"shape": "Two\\nlines" {');
    expect(source).toContain('"style"."label" -> "style"."shape"');
  });

  it("titles become a near: top-center text shape and never collide with a node id", () => {
    const { graph } = parse('title "My diagram"\nd2_title[Mine]\nd2_title -> b');
    const { source } = translateGraph(graph);
    expect(source).toContain('d2_title_: "My diagram" {');
    expect(source).toContain("near: top-center");
  });

  it("an explicit direction wins over the graph's, which wins over DOWN", () => {
    const { graph } = parse("dir RIGHT\na -> b");
    expect(translateGraph(graph, {}).source.startsWith("direction: right")).toBe(true);
    expect(translateGraph(graph, { direction: "UP" }).source.startsWith("direction: up")).toBe(true);
    expect(translateGraph(parse("a -> b").graph).source.startsWith("direction: down")).toBe(true);
  });

  it("reports what D2 cannot carry as losses: sketchy flag, empty group, fallback fonts", () => {
    const { graph } = parse(["a[One] :sketchy", 'group g "Empty" {', "}", "b[(Zhong wen)]", "c[Say hello] ", "a -> b"].join("\n"));
    const withCjk = parse('x[中文 label]\ny[Party 🎉]\nx -> y : "→ ok"').graph;
    const losses = translateGraph(graph).losses;
    expect(losses.map((l) => l.code).sort()).toEqual(["empty-group", "sketchy-flag"]);
    expect(losses.find((l) => l.code === "sketchy-flag")).toMatchObject({ line: 1, col: 1 });
    const fonts = translateGraph(withCjk).losses.filter((l) => l.code === "font-fallback");
    expect(fonts.length).toBe(2); // CJK node and emoji node; the arrow is plain non-ASCII punctuation
  });

  it("the engine object exposes translate with the title option", () => {
    const { graph } = parse("a -> b");
    const t = d2Engine.translate!(graph, { title: "Hello" });
    expect(t.source).toContain('d2_title: "Hello"');
    expect(t.losses).toEqual([]);
  });
});

// ---- WASM runtime ----

describe("wasm compile", () => {
  it("compiles a 3-node fixture: shapes with pos/size, connections with routes, cold start under 3 s", async () => {
    const t0 = performance.now();
    const r = await d2Compile("direction: right\na: A\nb: B\nc: C\na -> b: x\nb -> c", { layout: "elk" });
    const ms = performance.now() - t0;
    // 3 s is the local budget. A hosted Windows runner measured 4790 ms for this WASM cold start (CI run
    // 40092794378), so CI gets 8 s of headroom.
    expect(ms).toBeLessThan(process.env.CI ? 8000 : 3000);
    expect(r.diagram.shapes.map((s) => s.id)).toEqual(["a", "b", "c"]);
    for (const s of r.diagram.shapes) {
      expect(s.pos).toEqual({ x: expect.any(Number), y: expect.any(Number) });
      expect(s.width).toBeGreaterThan(0);
      expect(s.height).toBeGreaterThan(0);
    }
    expect(r.diagram.connections).toHaveLength(2);
    expect(r.diagram.connections[0]!.route.length).toBeGreaterThanOrEqual(2);
  });

  it("reports the D2 compiler version inside the WASM", async () => {
    expect(await d2WasmVersion()).toBe(D2_RELEASE.version);
  });

  it("rejects with every error and keeps D2's range text", async () => {
    const err = await d2Compile(fixture("bad1.d2")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(D2CompileError);
    expect((err as D2CompileError).errors.length).toBeGreaterThanOrEqual(4);
    expect((err as D2CompileError).errors[0]!.range).toMatch(/^index,\d+:\d+:\d+-\d+:\d+:\d+$/);
  });

  it("a non-JSON failure message becomes one position-less error", () => {
    expect(parseCompileErrors("boom")).toEqual([{ errmsg: "boom" }]);
    expect(parseCompileErrors("[]")).toEqual([{ errmsg: "[]" }]);
  });
});

// ---- validation ----

describe("validate", () => {
  it("a clean source has no diagnostics", async () => {
    expect(await validateD2(fixture("ok.d2"))).toEqual([]);
    expect(await d2Engine.validate(fixture("sequence.d2"))).toEqual([]);
  });

  it("bad1: semantic errors (which d2 validate would miss) come with line:col:endCol and suggestions", async () => {
    const ds = await validateD2(fixture("bad1.d2"));
    const errors = ds.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const d of errors) {
      expect(d.line).toBeGreaterThan(0);
      expect(d.col).toBeGreaterThan(0);
      expect(d.endCol).toBeGreaterThan(d.col!);
    }
    const byCode = new Map(errors.map((d) => [d.code, d]));
    expect(byCode.get("unknown-shape")).toMatchObject({ line: 2, col: 17, endCol: 22, suggestion: expect.stringContaining("hexagon") });
    expect(byCode.get("bad-color")?.suggestion).toMatch(/hex code/);
    expect(byCode.get("bad-number")).toBeDefined();
    expect(byCode.get("bad-near")?.suggestion).toMatch(/top-center/);
    expect(byCode.get("unknown-style")?.suggestion).toMatch(/stroke-dash/);
    expect(errors.filter((d) => d.suggestion).length).toBeGreaterThanOrEqual(1);
    // sorted by position
    expect(errors.map((d) => d.line)).toEqual([...errors.map((d) => d.line)].sort((a, b) => a! - b!));
  });

  it("bad2: unterminated map points at the opener with a closing-brace suggestion", async () => {
    const [d] = await validateD2(fixture("bad2.d2"));
    expect(d).toMatchObject({ code: "unterminated-map", line: 2, col: 4, suggestion: "add a closing }", severity: "error" });
    expect(d!.endCol).toBeUndefined(); // the range spans lines
  });

  it("bad3: connection without a destination", async () => {
    const [d] = await validateD2(fixture("bad3.d2"));
    expect(d).toMatchObject({ code: "missing-destination", line: 3, col: 3 });
    expect(d!.message).toBe("connection missing destination");
  });

  it("bad4: unterminated string", async () => {
    const [d] = await validateD2(fixture("bad4.d2"));
    expect(d).toMatchObject({ code: "unterminated-string", line: 1, col: 4 });
  });

  it("icons.d2: remote icons are warnings with positions, local icons and comments are not", async () => {
    const ds = await validateD2(fixture("icons.d2"));
    expect(ds.every((d) => d.code === "remote-icon" && d.severity === "warning")).toBe(true);
    expect(ds.map((d) => d.line)).toEqual([2, 6]);
    expect(ds[0]).toMatchObject({ col: 9, endCol: 9 + "https://icons.terrastruct.com/essentials/112-server.svg".length });
    expect(ds[1]!.message).toContain("http://example.com/db.svg");
  });

  it("lintD2 works on text alone and skips comments", () => {
    expect(lintD2("# icon: https://x.example/a.svg\na: A { icon: https://x.example/b.svg }")).toHaveLength(1);
  });

  it("toDiagnostic strips D2's file prefix and falls back to the message position", () => {
    expect(toDiagnostic({ errmsg: "index:4:7: something odd" })).toMatchObject({ code: "d2-error", message: "something odd", line: 4, col: 7 });
  });
});

// ---- SVG ----

describe("svg", () => {
  const SVG_CASES = ["day-rag-agent", "day-microservices", "day-k8s-deployment", "day-cicd-pipeline", "day-decision-tree", "day-er-entity-map", "day-cache-aside", "edge-title-multiline", "edge-cjk-emoji", "edge-all-arrow-styles-and-flags"];

  for (const name of SVG_CASES) {
    it(`${name}-DOWN renders to the same bytes twice and matches the golden`, async () => {
      const source = readFileSync(goldenPath(`${name}-DOWN.d2`), "utf8");
      const a = await renderD2(source);
      const b = await renderD2(source);
      expect(a.svg).toBe(b.svg);
      matchGolden(`${name}-DOWN.svg`, stripD2Version(a.svg));
    });
  }

  for (const name of ["ok", "sequence", "sql"]) {
    it(`fixture ${name}.d2 matches its golden`, async () => {
      const r = await renderD2(fixture(`${name}.d2`));
      matchGolden(`${name}.svg`, stripD2Version(r.svg));
    });
  }

  it("keeps D2's version stamp out of goldens only", async () => {
    const r = await renderD2(fixture("ok.d2"));
    expect(r.svg).toContain(`data-d2-version="${D2_RELEASE.version}"`);
    expect(stripD2Version(r.svg)).not.toContain("data-d2-version");
  });

  it("reports the natural size from the viewBox and defaults to elk with pad 32", async () => {
    const r = await renderD2(fixture("ok.d2"));
    expect(r).toMatchObject({ layout: "elk", browser: "d2-wasm", kind: "graph" });
    expect({ width: r.width, height: r.height }).toEqual(svgSize(r.svg));
    const wide = await renderD2(fixture("ok.d2"), { padding: 100 });
    expect(wide.width).toBe(r.width + 2 * (100 - 32));
  });

  it("layout, sketch and dark theme change the output; all three layouts render", async () => {
    const plain = (await renderD2(fixture("ok.d2"))).svg;
    expect((await renderD2(fixture("ok.d2"), { sketch: true })).svg).not.toBe(plain);
    expect((await renderD2(fixture("ok.d2"), { theme: "dark" })).svg).not.toBe(plain);
    for (const layout of ["dagre", "elk", "tala"]) {
      const r = await renderD2(fixture("ok.d2"), { layout });
      expect(r.layout).toBe(layout);
      expect(r.svg).toContain("<svg");
    }
    expect((await renderD2(fixture("ok.d2"), { layout: "dagre" })).svg).not.toBe(plain);
  });

  it("an unknown layout is a usage error; a compile error names the first problem and suggests check", async () => {
    await expect(renderD2("a -> b", { layout: "spring" })).rejects.toMatchObject({ suggestion: "use --layout dagre|elk|tala" });
    const err = await renderD2(fixture("bad3.d2")).catch((e: unknown) => e as Error & { suggestion?: string });
    expect(err.message).toBe("D2 source does not compile: 3:3 connection missing destination");
    expect((err as { suggestion?: string }).suggestion).toContain("target after the arrow");
    const many = await renderD2(fixture("bad1.d2")).catch((e: unknown) => e as Error);
    expect(many.message).toMatch(/\(\+\d+ more\)$/);
  });

  it("warns that tala is slow above 30 shapes", async () => {
    const big = Array.from({ length: 31 }, (_, i) => `n${i}`).join("\n");
    const r = await renderD2(big, { layout: "tala" });
    expect(r.warning).toMatch(/slow: --layout tala/);
    expect((await renderD2(big, { layout: "elk" })).warning).toBeUndefined();
  });

  it("matches the CLI SVG byte for byte when a d2 binary is available", async (ctx) => {
    const bin = await resolveD2Binary().catch(() => undefined);
    if (!bin) return ctx.skip("no d2 v0.9.0 binary");
    const dir = mkdtempSync(join(tmpdir(), "dg-d2-cli-"));
    try {
      writeFileSync(join(dir, "ok.d2"), fixture("ok.d2"));
      execFileSync(bin.path, ["--layout", "dagre", "--pad", "100", join(dir, "ok.d2"), join(dir, "ok.svg")], { windowsHide: true });
      const cli = readFileSync(join(dir, "ok.svg"), "utf8");
      const wasm = (await renderD2(fixture("ok.d2"), { layout: "dagre", padding: 100 })).svg;
      expect(stripD2Version(wasm).trimEnd()).toBe(stripD2Version(cli).trimEnd());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- PNG ----

describe("png scale policy", () => {
  it("keeps a request within the caps, lowers it with a warning otherwise", () => {
    expect(capScale(400, 200, 2.5, false)).toEqual({ scale: 2.5, reduced: false });
    const big = capScale(4000, 1000, 2.5, false);
    expect(big.reduced).toBe(true);
    expect(big.scale).toBeCloseTo(0.512, 3);
    expect(big.warning).toMatch(/scale reduced from 2.5 to 0.51 to stay within 2048 px/);
    expect(capScale(4000, 1000, 2, true)).toEqual({ scale: 2, reduced: false }); // typed scale: 16384 px cap
    expect(capScale(10_000, 10_000, 2, true).reduced).toBe(true); // 64 MP cap
  });

  it("the page gives the outer svg its natural pixel size", () => {
    const html = pageHtml('<?xml version="1.0"?><svg xmlns="x" viewBox="0 0 449 132"></svg>', 449, 132);
    expect(html).toContain('<svg width="449" height="132" xmlns="x" viewBox="0 0 449 132">');
    expect(html).not.toContain("<?xml");
  });
});

describe("png via browser", () => {
  let browser: InstalledBrowser | undefined;
  beforeAll(async () => {
    browser = await findBrowser().catch(() => undefined);
  });
  const need = (ctx: TestContext) => {
    if (!browser) ctx.skip("no browser installed");
  };
  const dims = (png: Uint8Array) => ({ w: Buffer.from(png).readUInt32BE(16), h: Buffer.from(png).readUInt32BE(20) });

  it("renders the WASM SVG at the default scale 2.5 with the same svg as a no-png render", async (ctx) => {
    need(ctx);
    const plain = await renderD2(SMALL);
    const r = await renderD2(SMALL, { png: true });
    expect(Buffer.from(r.png!).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(r.svg).toBe(plain.svg);
    expect(dims(r.png!)).toEqual({ w: Math.round(plain.width * 2.5), h: Math.round(plain.height * 2.5) });
    expect({ width: r.width, height: r.height }).toEqual({ width: dims(r.png!).w, height: dims(r.png!).h });
    expect(r.browser).toBe(browser!.name);
    expect(r.pngVia).toBe("browser");
  });

  it("honors --scale, and caps the long side at 2048 px with a warning", async (ctx) => {
    need(ctx);
    const plain = await renderD2(fixture("ok.d2"));
    const two = await renderD2(fixture("ok.d2"), { png: true, scale: 2 });
    expect(dims(two.png!)).toEqual({ w: plain.width * 2, h: plain.height * 2 });
    const huge = Array.from({ length: 40 }, (_, i) => `n${i} -> n${i + 1}`).join("\n");
    const r = await renderD2(`direction: right\n${huge}`, { png: true, layout: "dagre" });
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2048);
    expect(r.warning).toMatch(/scale reduced from 2.5/);
  }, 90_000);

  it("transparent output is a different image than the opaque one", async (ctx) => {
    need(ctx);
    const opaque = await renderD2(fixture("ok.d2"), { png: true });
    const clear = await renderD2(fixture("ok.d2"), { png: true, transparent: true });
    expect(Buffer.from(clear.png!).equals(Buffer.from(opaque.png!))).toBe(false);
  });

  it("remote icons never reach the network: the render still succeeds offline", async (ctx) => {
    need(ctx);
    const r = await renderD2(fixture("icons.d2"), { png: true });
    expect(r.png!.length).toBeGreaterThan(1000);
  });

  it("with no browser and no binary, PNG fails with both fixes in the suggestion", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dg-d2-empty-"));
    const keep = { path: process.env.PATH, cache: process.env[CACHE_DIR_ENV], d2: process.env[D2_PATH_ENV] };
    try {
      process.env.PATH = empty;
      process.env[CACHE_DIR_ENV] = empty;
      delete process.env[D2_PATH_ENV];
      const err = await renderD2(fixture("ok.d2"), { png: true, browserPath: join(empty, "no-such-browser") }).catch((e: unknown) => e as Error & { suggestion?: string });
      expect(err.message).toMatch(/browser executable not found/);
      expect((err as { suggestion?: string }).suggestion).toMatch(/--browser-path.*engines install d2/);
    } finally {
      process.env.PATH = keep.path;
      if (keep.cache === undefined) delete process.env[CACHE_DIR_ENV];
      else process.env[CACHE_DIR_ENV] = keep.cache;
      if (keep.d2 !== undefined) process.env[D2_PATH_ENV] = keep.d2;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---- registry and status ----

describe("engine registration", () => {
  it("is registered after excalidraw and read by .d2 files", () => {
    expect(engineIds().slice(0, 2)).toEqual(["excalidraw", "d2"]);
    expect(engineFor("d2")).toBe(d2Engine);
    expect(engineForExt(".d2")).toBe(d2Engine);
    expect(d2Engine.capabilities).toMatchObject({ sourceExt: ".d2", geometry: true, sketch: true, layouts: ["dagre", "elk", "tala"], inlineMarkdown: false });
    expect(d2Engine.capabilities.kinds).toEqual(["graph", "sequence", "class", "erd"]);
  });

  it("detects kinds from D2 sources", () => {
    expect(d2Engine.detectKind(fixture("ok.d2"))).toBe("graph");
    expect(d2Engine.detectKind(fixture("sequence.d2"))).toBe("sequence");
    expect(d2Engine.detectKind(fixture("sql.d2"))).toBe("erd");
    expect(d2Engine.detectKind("# kind: class\na -> b")).toBe("class");
  });

  it("status never loads WASM or downloads, and names how PNG is made", async () => {
    const s = await d2Engine.status({});
    expect(["ready", "browser-missing"]).toContain(s.status);
    expect(s.version).toBe("0.9.0 (@d2lang/d2 0.1.34)");
    const none = await d2Engine.status({ browserPath: join(tmpdir(), "no-such-browser-for-d2-status") });
    // an explicit missing browser falls through to discovery's failure path only when nothing else is found
    expect(none.png === "browser" || none.png === "binary" || none.png === "none").toBe(true);
  });
});
