// U6: engine wiring through the built bin. AE1-AE5 as golden TOON, native sources, routing flags, the
// `engines` command, help and home budgets. WASM (d2) paths always run; paths that need a browser
// (Mermaid, PNG) skip when none is installed. Nothing here touches the network.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_ENV, findBrowser } from "../src/render/browser.js";
import { fixture, run, tempDir, write } from "./helpers/run.js";

const browser = await findBrowser().catch(() => undefined);
const NO_BROWSER = { [BROWSER_ENV]: "/nonexistent" };
const tokens = (s: string): number => Math.ceil(s.length / 4);

/** 8 nodes in 2 groups, 26 edges, one pair with 3 edges: the router suggests d2 (AE1/AE2). */
function dense(): string {
  const lines = ["dir RIGHT", 'group front "Front" {', ...[0, 1, 2, 3].map((i) => `  n${i}[Node ${i}]`), "}", 'group back "Back" {', ...[4, 5, 6, 7].map((i) => `  n${i}[Node ${i}]`), "}"];
  for (let i = 0; i < 8; i++) for (const d of [1, 2, 3]) lines.push(`n${i} -> n${(i + d) % 8}`);
  lines.push("n0 -> n1 : retry", "n0 -> n1 : audit");
  return lines.join("\n") + "\n";
}

const OUTPUTS3 = /^draw: ok\noutputs\[3\]\{kind,path,bytes\}:\n {2}d2,dense\.d2,\d+\n {2}svg,dense\.svg,\d+\n {2}png,dense\.png,\d+\n/;

describe("AE1: engine line on check and draw", () => {
  it("check suggests d2 for a dense graph and names the reason", () => {
    const dir = tempDir();
    write(dir, "dense.exd", dense());
    const r = run(["check", "dense.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^check: ok, 0 errors, \d+ warnings? in dense\.exd\nquality/);
    expect(r.stdout).toContain("\nengine: suggest d2 (dense: 26 edges, 1 parallel pair); add --engine d2\n");
    expect(r.stdout.match(/^engine: /gm)).toHaveLength(1);
  });

  it("check suggests d2 for a label line over 40 chars, and stays silent at 40", () => {
    const dir = tempDir();
    write(dir, "long.exd", `a[${"x".repeat(41)}] -> b[B]\n`);
    expect(run(["check", "long.exd"], { cwd: dir }).stdout).toContain("\nengine: suggest d2 (text: 1 long label); add --engine d2\n");
    write(dir, "ok.exd", `a[${"x".repeat(40)}] -> b[B]\n`);
    expect(run(["check", "ok.exd"], { cwd: dir }).stdout).not.toContain("engine:");
  });

  it("draw keeps the default engine, writes the scene and prints the same suggestion once", () => {
    const dir = tempDir();
    write(dir, "dense.exd", dense());
    const r = run(["draw", "dense.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^draw: ok\nengine: suggest d2 \(dense: 26 edges, 1 parallel pair\); add --engine d2\noutputs\[1\]\{kind,path,bytes\}:\n {2}excalidraw,dense\.excalidraw,\d+\n/);
    expect(r.stdout).toMatch(/\nscene: 8 nodes, 26 edges, 2 groups, \d+x\d+ px, direction RIGHT, engine excalidraw, layout dagre\n/);
    expect(existsSync(join(dir, "dense.d2"))).toBe(false);
  });

  it("a graph that fits on the default engine prints no engine line, unless --engine auto asks", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B]\n");
    expect(run(["draw", "a.exd"], { cwd: dir }).stdout).not.toContain("engine:");
    expect(run(["check", "a.exd"], { cwd: dir }).stdout).not.toContain("engine:");
    expect(run(["check", "a.exd", "--engine", "auto"], { cwd: dir }).stdout).toContain("\nengine: excalidraw (fits: 2 nodes, 1 edges)\n");
    expect(run(["check", "a.exd", "--target", "markdown"], { cwd: dir }).stdout).toContain("\nengine: mermaid (target markdown)\n");
  });

  it("--engine auto applies the suggestion", () => {
    const dir = tempDir();
    write(dir, "dense.exd", dense());
    const r = run(["draw", "dense.exd", "--engine", "auto"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^draw: ok\nengine: d2 \(dense: 26 edges, 1 parallel pair\)\noutputs\[2\]\{kind,path,bytes\}:\n {2}d2,dense\.d2,\d+\n {2}svg,dense\.svg,\d+\n/);
  });
});

describe("AE2: draw an .exd with the d2 engine", () => {
  it("writes the translated .d2 and the .svg, with engine and layout in scene:", () => {
    const dir = tempDir();
    write(dir, "dense.exd", dense());
    const r = run(["draw", "dense.exd", "--engine", "d2"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^draw: ok\noutputs\[2\]\{kind,path,bytes\}:\n {2}d2,dense\.d2,\d+\n {2}svg,dense\.svg,\d+\n/);
    expect(r.stdout).toMatch(/\nscene: 8 nodes, 26 edges, 2 groups, \d+x\d+ px, direction RIGHT, engine d2, layout elk\n/);
    expect(r.stdout).toMatch(/\nquality(: ok|\[[^\]]+\]\{code,detail,fix\}:)/);
    expect(r.stdout).toMatch(/\nhelp\[3\]:\n {2}diagram-axi render dense\.d2 --png\n {2}diagram-axi inspect dense\.d2\n {2}diagram-axi syntax d2 (style|example)\n$/);
    expect(r.stdout).not.toContain("\nengine:");
    expect(readFileSync(join(dir, "dense.d2"), "utf8")).toContain("direction: right");
    expect(readFileSync(join(dir, "dense.svg"), "utf8")).toContain("<svg");
  });

  it.skipIf(!browser)("--png adds the third output", () => {
    const dir = tempDir();
    write(dir, "dense.exd", dense());
    const r = run(["draw", "dense.exd", "--engine", "d2", "--png"], { cwd: dir });
    expect(r.status, `${r.stdout}
${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(OUTPUTS3);
    expect([...readFileSync(join(dir, "dense.png")).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });

  it("--layout dagre is reported; an unknown layout and --layout on excalidraw are usage errors", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B]\n");
    expect(run(["draw", "a.exd", "--engine", "d2", "--layout", "dagre", "--out", "o/d"], { cwd: dir }).stdout).toContain("engine d2, layout dagre");
    const bad = run(["draw", "a.exd", "--engine", "d2", "--layout", "nope"], { cwd: dir });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain("use --layout dagre|elk|tala");
    const ex = run(["draw", "a.exd", "--layout", "elk"], { cwd: dir });
    expect(ex.status).toBe(2);
    expect(ex.stdout).toContain("--layout does not apply to the excalidraw engine");
  });

  it("refuses to overwrite the translated source without --force", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B]\n");
    expect(run(["draw", "a.exd", "--engine", "d2"], { cwd: dir }).status).toBe(0);
    const again = run(["draw", "a.exd", "--engine", "d2"], { cwd: dir });
    expect(again.status).toBe(1);
    expect(again.stdout).toContain("error: refusing to overwrite a.d2, a.svg\n");
    expect(run(["draw", "a.exd", "--engine", "d2", "--force"], { cwd: dir }).status).toBe(0);
  });

  it("reads stdin with --out", () => {
    const dir = tempDir();
    const r = run(["draw", "-", "--engine", "d2", "--out", "o/piped"], { cwd: dir, input: "a[A] -> b[B]\n" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  d2,o/piped.d2,");
  });

  it("--kind on an .exd, --engine on a conflicting native file and unknown engines are usage errors", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B]\n");
    write(dir, "x.d2", "a -> b\n");
    const kind = run(["draw", "a.exd", "--kind", "sequence"], { cwd: dir });
    expect(kind.status).toBe(2);
    expect(kind.stdout).toContain("needs a native .d2 or .mmd source");
    const clash = run(["draw", "x.d2", "--engine", "mermaid"], { cwd: dir });
    expect(clash.status).toBe(2);
    expect(clash.stdout).toMatch(/^error: --engine mermaid conflicts with the \.d2 source, which belongs to d2\nsuggestion: drop --engine, or use --engine d2\n/);
    expect(run(["draw", "a.exd", "--engine", "svg"], { cwd: dir }).status).toBe(2);
  });

  it("hidden --geometry-json writes the neutral model and stays out of --help", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B]\n");
    const r = run(["draw", "a.exd", "--engine", "d2", "--geometry-json"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("geometry.json");
    const g = JSON.parse(readFileSync(join(dir, "a.geometry.json"), "utf8")) as { engine: string; layout: string; kind: string; rules_skipped: string[]; neutral: { nodes: unknown[]; edges: unknown[] } };
    expect(g).toMatchObject({ engine: "d2", layout: "elk", kind: "graph" });
    expect(g.rules_skipped).toContain("label-stored-offset");
    expect(g.neutral.nodes).toHaveLength(2);
    expect(g.neutral.edges).toHaveLength(1);
    expect(run(["draw", "--help"]).stdout).not.toContain("geometry-json");
  });
});

describe("AE3: native Mermaid file", () => {
  it.skipIf(!browser)("draw login.mmd writes the svg beside the input and never rewrites the source", () => {
    const dir = tempDir();
    const src = readFileSync(fixture("mermaid/sequence.mmd"), "utf8");
    write(dir, "login.mmd", src);
    const r = run(["draw", "login.mmd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^draw: ok\nkind: sequence\nengine: mermaid \(native \.mmd\)\noutputs\[1\]\{kind,path,bytes\}:\n {2}svg,login\.svg,\d+\n/);
    expect(r.stdout).toMatch(/\nscene: \d+ nodes?, \d+ edges?, \d+ groups?, \d+x\d+ px, engine mermaid\nquality: n\/a \(kind sequence has no graph rules\)\n/);
    expect(readFileSync(join(dir, "login.mmd"), "utf8")).toBe(src);
    expect(existsSync(join(dir, "login.png"))).toBe(false);

    const png = run(["draw", "login.mmd", "--png", "--force"], { cwd: dir });
    expect(png.status).toBe(0);
    expect(png.stdout).toMatch(/\noutputs\[2\]\{kind,path,bytes\}:\n {2}svg,login\.svg,\d+\n {2}png,login\.png,\d+\n/);
    expect(readFileSync(join(dir, "login.mmd"), "utf8")).toBe(src);
  });

  it.skipIf(!browser)("an .exd drawn with --engine mermaid writes .mmd + .svg, and --target markdown picks mermaid", () => {
    const dir = tempDir();
    write(dir, "n.exd", "a[A] -> b[B] -> c[C]\n");
    const r = run(["draw", "n.exd", "--engine", "mermaid"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^draw: ok\noutputs\[2\]\{kind,path,bytes\}:\n {2}mmd,n\.mmd,\d+\n {2}svg,n\.svg,\d+\n/);
    expect(r.stdout).toMatch(/\nscene: 3 nodes, 2 edges, 0 groups, \d+x\d+ px, direction DOWN, engine mermaid, layout elk\nquality: ok\n/);

    const md = run(["draw", "n.exd", "--target", "markdown", "--out", "m/n"], { cwd: dir });
    expect(md.status).toBe(0);
    expect(md.stdout).toMatch(/^draw: ok\nengine: mermaid \(target markdown\)\noutputs\[2\]\{kind,path,bytes\}:\n {2}mmd,m\/n\.mmd,/);
  });

  it("without a browser the .mmd is still written and the error names --browser-path", () => {
    const dir = tempDir();
    write(dir, "n.exd", "a[A] -> b[B]\n");
    const r = run(["draw", "n.exd", "--engine", "mermaid"], { cwd: dir, env: NO_BROWSER });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^error: browser executable not found/);
    expect(r.stdout).toContain("--browser-path");
    expect(r.stdout).toMatch(/\noutputs\[1\]\{kind,path,bytes\}:\n {2}mmd,n\.mmd,\d+\n/);
    expect(existsSync(join(dir, "n.svg"))).toBe(false);
  });
});

describe("AE4: d2 PNG with no renderer", () => {
  it("writes the .d2 and .svg, exits 1 and says how to get a PNG renderer", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B]\n");
    const r = run(["draw", "a.exd", "--engine", "d2", "--png"], {
      cwd: dir,
      env: { ...NO_BROWSER, DIAGRAM_AXI_CACHE_DIR: join(dir, "cache"), DIAGRAM_AXI_D2_PATH: undefined },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /^error: no PNG renderer for d2 \(browser not found, binary not installed\)\nsuggestion: --browser-path <chrome>, or diagram-axi engines install d2 \(needs network once\), or --d2-path <exe>\noutputs\[2\]\{kind,path,bytes\}:\n {2}d2,a\.d2,\d+\n {2}svg,a\.svg,\d+\nhelp\[2\]:\n/,
    );
    expect(existsSync(join(dir, "a.png"))).toBe(false);
    expect(existsSync(join(dir, "a.svg"))).toBe(true);
  });
});

describe("AE5: check a native .d2 file", () => {
  it("lists every compile error with line, col and endCol, exit 1", () => {
    const dir = tempDir();
    write(dir, "bad.d2", readFileSync(fixture("d2/bad1.d2"), "utf8"));
    const r = run(["check", "bad.d2"], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^check: failed, \d+ errors, 0 warnings in bad\.d2\nkind: graph\nengine: d2 \(native \.d2\)\nerrors\[\d+\]\{line,col,endCol,code,message,suggestion\}:\n/);
    expect(r.stdout).toContain('\n  2,17,22,unknown-shape,"unknown shape ""bogus""",');
    expect(r.stdout).toMatch(/\nhelp\[2\]:\n {2}diagram-axi syntax d2 example\n {2}diagram-axi check bad\.d2\n$/);
  });

  it("an ok file passes, remote icons are warnings, --strict makes them fail", () => {
    const dir = tempDir();
    write(dir, "ok.d2", readFileSync(fixture("d2/ok.d2"), "utf8"));
    write(dir, "icons.d2", readFileSync(fixture("d2/icons.d2"), "utf8"));
    const ok = run(["check", "ok.d2"], { cwd: dir });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("check: ok, 0 errors, 0 warnings in ok.d2\nkind: graph\nengine: d2 (native .d2)\nhelp[2]:\n  diagram-axi draw ok.d2 --png\n  diagram-axi inspect ok.d2\n");
    const icons = run(["check", "icons.d2"], { cwd: dir });
    expect(icons.status).toBe(0);
    expect(icons.stdout).toMatch(/^check: ok, 0 errors, 2 warnings in icons\.d2\n/);
    expect(icons.stdout).toMatch(/\nwarnings\[2\]\{line,col,endCol,code,message,suggestion\}:\n {2}2,\d+,\d+,remote-icon,/);
    expect(run(["check", "icons.d2", "--strict"], { cwd: dir }).status).toBe(1);
  });

  it("the kind comes from --kind, a header comment or the first keyword", () => {
    const dir = tempDir();
    write(dir, "seq.d2", readFileSync(fixture("d2/sequence.d2"), "utf8"));
    write(dir, "sql.d2", readFileSync(fixture("d2/sql.d2"), "utf8"));
    write(dir, "h.d2", "# kind: class\na -> b\n");
    expect(run(["check", "seq.d2"], { cwd: dir }).stdout).toContain("\nkind: sequence\n");
    expect(run(["check", "sql.d2"], { cwd: dir }).stdout).toContain("\nkind: erd\n");
    expect(run(["check", "h.d2"], { cwd: dir }).stdout).toContain("\nkind: class\n");
    expect(run(["check", "h.d2", "--kind", "sequence"], { cwd: dir }).stdout).toContain("\nkind: sequence\n");
    expect(run(["check", "h.d2", "--kind", "bogus"], { cwd: dir }).status).toBe(2);
  });

  it.skipIf(!browser)("Mermaid: a parse error carries line:col; an ok file passes", () => {
    const dir = tempDir();
    write(dir, "bad.mmd", readFileSync(fixture("mermaid/bad-jison.mmd"), "utf8"));
    write(dir, "state.mmd", readFileSync(fixture("mermaid/state.mmd"), "utf8"));
    const bad = run(["check", "bad.mmd"], { cwd: dir });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/^check: failed, 1 error, 0 warnings in bad\.mmd\nkind: \w+\nengine: mermaid \(native \.mmd\)\nerrors\[1\]\{line,col,endCol,code,message,suggestion\}:\n {2}\d+,\d+,,mermaid-syntax,/);
    const ok = run(["check", "state.mmd"], { cwd: dir });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^check: ok, 0 errors, 0 warnings in state\.mmd\nkind: state\nengine: mermaid \(native \.mmd\)\n/);
  });

  it("an .exd with an explicit engine also validates the translation", () => {
    const dir = tempDir();
    write(dir, "g.exd", 'group g "G" {\n}\na[A] -> b[B]\n');
    const r = run(["check", "g.exd", "--engine", "d2"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\ntranslation: ok \(d2, \d+ lines\)\n/);
    expect(r.stdout).toMatch(/\nlosses\[1\]\{code,detail\}:\n {2}empty-group,/);
    expect(r.stdout).not.toContain("\nengine:");
  });
});

describe("native files through render and inspect", () => {
  it("render writes svg beside a .d2, needs --png or --svg, and sends .exd to draw", () => {
    const dir = tempDir();
    write(dir, "ok.d2", readFileSync(fixture("d2/ok.d2"), "utf8"));
    write(dir, "a.exd", "a[A] -> b[B]\n");
    const r = run(["render", "ok.d2", "--svg"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^render: ok\nkind: graph\noutputs\[1\]\{kind,path,bytes\}:\n {2}svg,ok\.svg,\d+\nscene: 5 nodes, 4 edges, 1 group, \d+x\d+ px, engine d2, layout elk\n/);
    expect(run(["render", "ok.d2"], { cwd: dir }).status).toBe(2);
    const exd = run(["render", "a.exd", "--svg"], { cwd: dir });
    expect(exd.status).toBe(1);
    expect(exd.stdout).toMatch(/^error: 'a\.exd' is DSL source, not a scene\nsuggestion: use draw: diagram-axi draw a\.exd --png\n/);
  });

  it("render --sketch changes the svg and a broken source reports the first error", () => {
    const dir = tempDir();
    write(dir, "ok.d2", readFileSync(fixture("d2/ok.d2"), "utf8"));
    write(dir, "bad.d2", readFileSync(fixture("d2/bad1.d2"), "utf8"));
    expect(run(["render", "ok.d2", "--svg", "--out", "plain"], { cwd: dir }).status).toBe(0);
    expect(run(["render", "ok.d2", "--svg", "--sketch", "--out", "sketch"], { cwd: dir }).status).toBe(0);
    expect(readFileSync(join(dir, "sketch.svg"), "utf8")).not.toBe(readFileSync(join(dir, "plain.svg"), "utf8"));
    const bad = run(["render", "bad.d2", "--svg"], { cwd: dir });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/^error: D2 source does not compile: \d+:\d+ .* \(\+4 more\)\n/);
  });

  it("draw and inspect of a native sequence and an ER file report kind and n/a quality", () => {
    const dir = tempDir();
    write(dir, "seq.d2", readFileSync(fixture("d2/sequence.d2"), "utf8"));
    write(dir, "sql.d2", readFileSync(fixture("d2/sql.d2"), "utf8"));
    const d = run(["draw", "seq.d2"], { cwd: dir });
    expect(d.status).toBe(0);
    expect(d.stdout).toMatch(/^draw: ok\nkind: sequence\nengine: d2 \(native \.d2\)\noutputs\[1\]\{kind,path,bytes\}:\n {2}svg,seq\.svg,\d+\nscene: .*engine d2, layout elk\nquality: n\/a \(kind sequence has no graph rules\)\n/);
    expect(readFileSync(join(dir, "seq.d2"), "utf8")).toBe(readFileSync(fixture("d2/sequence.d2"), "utf8"));
    const i = run(["inspect", "sql.d2"], { cwd: dir });
    expect(i.status).toBe(0);
    expect(i.stdout).toMatch(/^scene: \d+ nodes?, \d+ edges?, \d+ groups? in sql\.d2\nengine: d2 \(native \.d2\)\nkind: erd\nlayout: elk\nnodes\[\d+\]: .*\nedges\[\d+\]: .*\ngroups\[\d+\]: .*\nsize: \d+x\d+ px\nquality: n\/a \(kind erd has no graph rules\)\nhelp\[2\]:\n/);
  });

  it("inspect --engine d2 counts an .exd from the d2 geometry", () => {
    const dir = tempDir();
    write(dir, "a.exd", "a[A] -> b[B] -> c[C]\n");
    const r = run(["inspect", "a.exd", "--engine", "d2", "--fields", "nodes,edges,size,shapes"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^scene: 3 nodes, 2 edges, 0 groups in a\.exd\nengine: d2\nkind: graph\nlayout: elk\nnodes\[3\]: a,b,c\nedges\[2\]: a>b,b>c\nsize: \d+x\d+ px\nshapes\[1\]\{kind,count\}:\n {2}rectangle,3\n/);
  });

  it.skipIf(!browser)("inspect of a Mermaid state file reports per-kind aggregates", () => {
    const dir = tempDir();
    write(dir, "state.mmd", readFileSync(fixture("mermaid/state.mmd"), "utf8"));
    const r = run(["inspect", "state.mmd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^scene: \d+ nodes?, \d+ edges?, \d+ groups? in state\.mmd\nengine: mermaid \(native \.mmd\)\nkind: state\n/);
    const timeline = write(dir, "t.mmd", readFileSync(fixture("mermaid/timeline.mmd"), "utf8"));
    const t = run(["inspect", timeline], { cwd: dir });
    expect(t.stdout).toMatch(/^scene: nodes\/edges n\/a \(kind timeline\) in /);
  });

  it("inspect rejects an .svg", () => {
    const dir = tempDir();
    write(dir, "x.svg", "<svg/>");
    const r = run(["inspect", "x.svg"], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("error: an .svg has no source to measure");
  });
});

describe("syntax [engine] [topic]", () => {
  it("serves exd by default and the native references by engine", () => {
    expect(run(["syntax", "nodes"]).stdout).toMatch(/^syntax: nodes,/);
    expect(run(["syntax", "exd", "nodes"]).stdout).toMatch(/^syntax: nodes,/);
    expect(run(["syntax", "d2", "erd"]).stdout).toContain("sql_table");
    expect(run(["syntax", "mermaid", "state"]).stdout).toMatch(/^syntax: mermaid state,/);
    expect(run(["syntax", "routing"]).stdout).toMatch(/^syntax: routing,/);
    expect(run(["syntax", "--engine", "d2", "erd"]).stdout).toContain("sql_table");
    const index = run(["syntax"]).stdout;
    expect(index).toContain("d2: sequence class erd style example; mermaid: state timeline gitgraph mindmap example; routing");
    expect(tokens(index)).toBeLessThanOrEqual(350);
    expect(tokens(run(["syntax", "d2"]).stdout)).toBeLessThanOrEqual(350);
  });

  it("unknown topics are usage errors that list the valid ones", () => {
    const d2 = run(["syntax", "d2", "bogus"]);
    expect(d2.status).toBe(2);
    expect(d2.stdout).toContain("valid topics: sequence, class, erd, style, example");
    const exd = run(["syntax", "bogus"]);
    expect(exd.status).toBe(2);
    expect(exd.stdout).toContain("other references: d2, mermaid, routing");
    expect(run(["syntax", "d2", "erd", "extra"]).status).toBe(2);
  });
});

describe("engines", () => {
  it("lists status, versions and the PNG path, then the optional binary", () => {
    const dir = tempDir();
    const r = run(["engines"], { cwd: dir, env: { DIAGRAM_AXI_CACHE_DIR: join(dir, "cache"), DIAGRAM_AXI_D2_PATH: undefined } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^engines\[3\]\{engine,status,version,png\}:\n {2}excalidraw,(ready|browser-missing),0\.1\.7,(browser|none)\n {2}d2,(ready|browser-missing),0\.9\.0 \(@d2lang\/d2 0\.1\.34\),(browser|binary|none)\n {2}mermaid,(ready|browser-missing),12\.2\.0 \+ elk 1\.0\.1,(browser|none)\n/,
    );
    expect(r.stdout).toContain("d2-binary: not installed (optional, for PNG without a browser)\n");
    expect(r.stdout).toMatch(/\nhelp\[3\]:\n {2}diagram-axi engines install d2\n/);
  });

  it("without a browser every engine says so and how to fix it", () => {
    const r = run(["engines"], { env: NO_BROWSER });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  excalidraw,browser-missing,0.1.7,none\n");
    expect(r.stdout).toContain("  d2,browser-missing,0.9.0 (@d2lang/d2 0.1.34),none\n");
    expect(r.stdout).toMatch(/\ninstall\[3\]\{engine,command\}:\n/);
    expect(r.stdout).toContain("run `engines install d2` for browser-less PNG");
  });

  it("shows only the engine asked for", () => {
    const r = run(["engines", "--engine", "mermaid"]);
    expect(r.stdout).toMatch(/^engines\[1\]\{engine,status,version,png\}:\n {2}mermaid,/);
    expect(r.stdout).not.toContain("d2-binary");
  });

  it("install d2 is a no-op when the pinned binary is already in the cache (no network)", () => {
    const dir = tempDir();
    const exe = process.platform === "win32" ? "d2.exe" : "d2";
    const cache = join(dir, "cache");
    mkdirSync(join(cache, "engines", "d2", "v0.9.0", "d2-v0.9.0", "bin"), { recursive: true });
    writeFileSync(join(cache, "engines", "d2", "v0.9.0", "d2-v0.9.0", "bin", exe), "");
    const r = run(["engines", "install", "d2"], { cwd: dir, env: { DIAGRAM_AXI_CACHE_DIR: cache } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^engines install d2: ok\nd2-binary: 0\.9\.0 at .*d2(\.exe)? \(already installed\)\nhelp\[2\]:\n/);
  });

  it("install needs a name and knows only d2", () => {
    expect(run(["engines", "install"]).status).toBe(2);
    const r = run(["engines", "install", "mermaid"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("only d2 has an optional download");
  });
});

describe("help and home", () => {
  it.each([["draw"], ["render"], ["check"], ["inspect"], ["syntax"], ["engines"], ["engines", "install"]])("%s --help lists --engine exactly once", (...cmd) => {
    const r = run([...cmd, "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.match(/--engine/g)).toHaveLength(1);
  });

  it("home adds the engines line, scans .d2 and .mmd and stays within 350 tokens", () => {
    const dir = tempDir();
    write(dir, "docs/flows/order.d2", "a -> b\n# note\n");
    write(dir, "docs/flows/login.mmd", "sequenceDiagram\n  A->>B: hi\n");
    write(dir, "docs/arch.excalidraw", JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "a" }] }));
    const r = run([], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\nengines: excalidraw (ready|browser-missing), d2 (ready|browser-missing) \(png (browser|binary|none)\), mermaid (ready|browser-missing)\n/);
    expect(r.stdout).toMatch(/scenes\[3\]\{path,elements,modified\}:\n/);
    expect(r.stdout).toContain("  docs/flows/order.d2,1,");
    expect(r.stdout).toContain("  docs/flows/login.mmd,2,");
    expect(r.stdout).toContain("  docs/arch.excalidraw,1,");
    expect(tokens(r.stdout)).toBeLessThanOrEqual(350);
    const empty = run([], { cwd: tempDir() });
    expect(empty.stdout).toContain("scenes: 0 .excalidraw files found under . (also .d2, .mmd)");
    expect(tokens(empty.stdout)).toBeLessThanOrEqual(350);
  });

  it("home with no browser reports the state of every engine", () => {
    const r = run([], { cwd: tempDir(), env: NO_BROWSER });
    expect(r.stdout).toContain("\nengines: excalidraw browser-missing, d2 browser-missing (png none), mermaid browser-missing\n");
  });
});
