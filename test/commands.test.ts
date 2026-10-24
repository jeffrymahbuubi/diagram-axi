// Command tests (U6): spawn the built bin for draw, render, inspect and check.
// Draw output is compared with an in-process parse -> layout -> buildScene -> serialize
// run on the same input, never with golden bytes.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Direction } from "../src/dsl/ast.js";
import { parse } from "../src/dsl/parser.js";
import { layout } from "../src/layout/dagre-layout.js";
import { BROWSER_ENV, findBrowser } from "../src/render/browser.js";
import { buildScene } from "../src/scene/build.js";
import { serialize } from "../src/scene/serialize.js";
import { fixture, run, tempDir, write } from "./helpers/run.js";

const ARCH = readFileSync(fixture("arch.exd"), "utf8");

/** The pipeline `draw` is expected to run, in process. */
function expected(dsl: string, flagDirection: Direction = "DOWN"): string {
  const { graph } = parse(dsl);
  return serialize(buildScene(graph, layout({ graph, direction: graph.direction ?? flagDirection })));
}

const browser = await findBrowser().catch(() => undefined);
const NO_BROWSER = { [BROWSER_ENV]: "/nonexistent" };

describe("draw", () => {
  it("AE1: writes the scene the in-process pipeline builds and prints the success TOON", () => {
    const dir = tempDir();
    const r = run(["draw", fixture("arch.exd"), "--out", "arch"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const file = join(dir, "arch.excalidraw");
    expect(readFileSync(file, "utf8")).toBe(expected(ARCH));
    const head = `draw: ok\noutputs[1]{kind,path,bytes}:\n  excalidraw,arch.excalidraw,${statSync(file).size}\n`;
    expect(r.stdout.startsWith(head)).toBe(true);
    expect(r.stdout.slice(head.length)).toMatch(
      /^scene: 7 nodes, 7 edges, 1 group, \d+x\d+ px, direction RIGHT, engine excalidraw, layout dagre\nquality: ok\nhelp\[3\]:\n {2}diagram-axi render arch\.excalidraw --png\n {2}diagram-axi inspect arch\.excalidraw\n {2}diagram-axi syntax style\n$/,
    );
    expect(r.stdout).not.toContain("warnings[");
  });

  it("defaults --out to the input path without its extension", () => {
    const dir = tempDir();
    write(dir, "sub/flow.exd", "a[A] -> b[B]\n");
    const r = run(["draw", "sub/flow.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  excalidraw,sub/flow.excalidraw,");
    expect(existsSync(join(dir, "sub", "flow.excalidraw"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["sub"]);
  });

  it("AE2: a parse error exits 1 with the exact message and suggestion and writes nothing", () => {
    const dir = tempDir();
    write(dir, "bad.exd", "a[A]\nb[B]\na -> b\napi[API -> db\n");
    const r = run(["draw", "bad.exd"], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("error: line 4, col 9: expected ']' to close label, found '->'\n");
    expect(r.stdout).toContain("suggestion: close the label: api[API] -> db\n");
    expect(r.stdout).toMatch(/\nhelp\[2\]:\n {2}diagram-axi syntax nodes\n {2}diagram-axi check bad\.exd$/m);
    expect(readdirSync(dir)).toEqual(["bad.exd"]);
  });

  it("AE3: draw --png without a browser still writes and lists the .excalidraw file, exit 1", () => {
    const dir = tempDir();
    write(dir, "d.exd", "a[A] -> b[B]\n");
    const r = run(["draw", "d.exd", "--png"], { cwd: dir, env: NO_BROWSER });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^error: .*\nsuggestion: .*--browser-path.*d\.excalidraw file was written/);
    expect(r.stdout).toMatch(/outputs\[1\]\{kind,path,bytes\}:\n {2}excalidraw,d\.excalidraw,\d+\n/);
    expect(existsSync(join(dir, "d.excalidraw"))).toBe(true);
    expect(existsSync(join(dir, "d.png"))).toBe(false);
  });

  it("reads stdin with --out, and rejects stdin without --out (exit 2)", () => {
    const dir = tempDir();
    const dsl = "a[A] -> b[B] -> c[C]\n";
    const ok = run(["draw", "-", "--out", "out/piped"], { cwd: dir, input: dsl });
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toContain("  excalidraw,out/piped.excalidraw,");
    expect(readFileSync(join(dir, "out", "piped.excalidraw"), "utf8")).toBe(expected(dsl));

    const bad = run(["draw", "-"], { cwd: dir, input: dsl });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toMatch(/^error: .*--out/);
  });

  it("refuses to overwrite without --force", () => {
    const dir = tempDir();
    write(dir, "d.exd", "a[A] -> b[B]\n");
    expect(run(["draw", "d.exd"], { cwd: dir }).status).toBe(0);
    const first = readFileSync(join(dir, "d.excalidraw"), "utf8");

    write(dir, "d.exd", "a[A] -> b[B] -> c[C]\n");
    const refused = run(["draw", "d.exd"], { cwd: dir });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("error: refusing to overwrite d.excalidraw\n");
    expect(refused.stdout).toContain("suggestion: pass --force");
    expect(readFileSync(join(dir, "d.excalidraw"), "utf8")).toBe(first);

    const forced = run(["draw", "d.exd", "--force"], { cwd: dir });
    expect(forced.status).toBe(0);
    expect(readFileSync(join(dir, "d.excalidraw"), "utf8")).toBe(expected("a[A] -> b[B] -> c[C]\n"));
  });

  it("direction: DSL dir beats --direction, which beats the DOWN default", () => {
    const dir = tempDir();
    const plain = "a[A] -> b[B]\n";
    write(dir, "plain.exd", plain);
    write(dir, "dsl.exd", `dir LEFT\n${plain}`);

    const down = run(["draw", "plain.exd", "--out", "o/down"], { cwd: dir });
    expect(down.stdout).toContain("direction DOWN");
    expect(readFileSync(join(dir, "o", "down.excalidraw"), "utf8")).toBe(expected(plain, "DOWN"));

    const right = run(["draw", "plain.exd", "--out", "o/right", "--direction", "RIGHT"], { cwd: dir });
    expect(right.stdout).toContain("direction RIGHT");
    expect(readFileSync(join(dir, "o", "right.excalidraw"), "utf8")).toBe(expected(plain, "RIGHT"));
    expect(readFileSync(join(dir, "o", "right.excalidraw"), "utf8")).not.toBe(expected(plain, "DOWN"));

    const wins = run(["draw", "dsl.exd", "--out", "o/dsl", "--direction", "RIGHT"], { cwd: dir });
    expect(wins.stdout).toContain("direction LEFT");
    expect(readFileSync(join(dir, "o", "dsl.excalidraw"), "utf8")).toBe(expected(`dir LEFT\n${plain}`, "RIGHT"));
  });

  it("lists parse warnings in a warnings table", () => {
    const dir = tempDir();
    write(dir, "w.exd", "a[A] -> b\n");
    const r = run(["draw", "w.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/warnings\[1\]\{line,col,code,message\}:\n {2}1,\d+,implicit-node,/);
  });

  it("exit codes: unknown flag, bad number, missing file, empty diagram", () => {
    const dir = tempDir();
    write(dir, "d.exd", "a[A] -> b[B]\n");
    write(dir, "empty.exd", "# nothing here\n");
    expect(run(["draw", "d.exd", "--nope"], { cwd: dir }).status).toBe(2);
    expect(run(["draw"], { cwd: dir }).status).toBe(2);
    expect(run(["draw", "d.exd", "--scale", "99"], { cwd: dir }).status).toBe(2);
    expect(run(["draw", "d.exd", "--padding", "-1"], { cwd: dir }).status).toBe(2);
    expect(run(["draw", "missing.exd"], { cwd: dir }).status).toBe(1);
    const empty = run(["draw", "empty.exd"], { cwd: dir });
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain("error: the diagram is empty");
    expect(readdirSync(dir).sort()).toEqual(["d.exd", "empty.exd"]);
  });

  it.skipIf(!browser)("--png --svg renders both files next to the scene", () => {
    const dir = tempDir();
    write(dir, "arch.exd", ARCH);
    const r = run(["draw", "arch.exd", "--png", "--svg"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^draw: ok\noutputs\[3\]\{kind,path,bytes\}:\n {2}excalidraw,arch\.excalidraw,\d+\n {2}png,arch\.png,\d+\n {2}svg,arch\.svg,\d+\n/);
    expect(r.stdout).toMatch(/direction RIGHT, engine excalidraw, layout dagre, browser \w+\n/);
    expect(readFileSync(join(dir, "arch.png")).subarray(1, 4).toString()).toBe("PNG");
    expect(readFileSync(join(dir, "arch.svg"), "utf8")).toContain("<svg");
  });
});

describe("render", () => {
  const scene = (dir: string) => {
    write(dir, "s.exd", "a[A] -> b[B]\n");
    expect(run(["draw", "s.exd"], { cwd: dir }).status).toBe(0);
    return "s.excalidraw";
  };

  it("AE3: a missing browser exits 1 and names --browser-path", () => {
    const dir = tempDir();
    const file = scene(dir);
    const r = run(["render", file, "--png"], { cwd: dir, env: NO_BROWSER });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^error: /);
    expect(r.stdout).toContain("--browser-path");
    expect(r.stdout).toMatch(/\nhelp\[\d\]:\n/);
    expect(existsSync(join(dir, "s.png"))).toBe(false);
  });

  it("needs --png or --svg (exit 2) and validates numeric flags (exit 2)", () => {
    const dir = tempDir();
    const file = scene(dir);
    const none = run(["render", file], { cwd: dir });
    expect(none.status).toBe(2);
    expect(none.stdout).toContain("--png");
    for (const flags of [["--scale", "0"], ["--scale", "17"], ["--scale", "x"], ["--padding", "-5"], ["--timeout", "0"], ["--timeout", "abc"]]) {
      expect(run(["render", file, "--png", ...flags], { cwd: dir }).status, flags.join(" ")).toBe(2);
    }
    expect(run(["render", file, "--png", "--bogus"], { cwd: dir }).status).toBe(2);
    expect(run(["render"], { cwd: dir }).status).toBe(2);
  });

  it("rejects missing files, invalid JSON, non-scenes and empty scenes with exit 1", () => {
    const dir = tempDir();
    write(dir, "bad.json", "{ not json");
    write(dir, "other.excalidraw", JSON.stringify({ type: "something", elements: [{}] }));
    write(dir, "empty.excalidraw", JSON.stringify({ type: "excalidraw", version: 2, elements: [] }));
    for (const f of ["missing.excalidraw", "bad.json", "other.excalidraw", "empty.excalidraw"]) {
      const r = run(["render", f, "--png"], { cwd: dir });
      expect(r.status, f).toBe(1);
      expect(r.stdout, f).toMatch(/^error: .+\nsuggestion: .+\nhelp\[\d\]:\n/);
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".png"))).toEqual([]);
  });

  it.skipIf(!browser)("renders a PNG and an SVG, with --out naming", () => {
    const dir = tempDir();
    const file = scene(dir);
    const r = run(["render", file, "--png", "--svg", "--out", "img/pic", "--scale", "2"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^render: ok\noutputs\[2\]\{kind,path,bytes\}:\n {2}png,img\/pic\.png,\d+\n {2}svg,img\/pic\.svg,\d+\n/);
    expect(r.stdout).toMatch(/\nscene: 2 nodes, 1 edge, 0 groups, \d+x\d+ px, browser \w+\n/);
    const png = readFileSync(join(dir, "img", "pic.png"));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "img", "pic.svg"), "utf8")).toContain("<svg");
  });
});

describe("inspect", () => {
  it("summarizes a .exd file in memory", () => {
    const dir = tempDir();
    write(dir, "arch.exd", ARCH);
    const r = run(["inspect", "arch.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^scene: 7 nodes, 7 edges, 1 group in arch\.exd\n/);
    expect(r.stdout).toContain("nodes[7]: web,mobile,api,auth,orders,db,cache\n");
    expect(r.stdout).toContain("edges[7]: web>api,");
    expect(r.stdout).toContain("groups[1]: edge\n");
    expect(r.stdout).toMatch(/\nsize: \d+x\d+ px\nquality: ok\nhelp\[2\]:\n/);
    expect(readdirSync(dir)).toEqual(["arch.exd"]);
  });

  it("summarizes a .excalidraw scene, with the same counts as its source", () => {
    const dir = tempDir();
    write(dir, "arch.exd", ARCH);
    expect(run(["draw", "arch.exd"], { cwd: dir }).status).toBe(0);
    const fromScene = run(["inspect", "arch.excalidraw"], { cwd: dir });
    const fromDsl = run(["inspect", "arch.exd"], { cwd: dir });
    expect(fromScene.status).toBe(0);
    expect(fromScene.stdout).toMatch(/^scene: 7 nodes, 7 edges, 1 group in arch\.excalidraw\n/);
    const body = (s: string) => s.split("\n").slice(1, 5).join("\n");
    expect(body(fromScene.stdout)).toBe(body(fromDsl.stdout));
  });

  it("--fields adds shapes, fonts, colors and unresolved tables", () => {
    const dir = tempDir();
    write(dir, "w.exd", "a[A] -> db[(DB)]\ndb -> c{C}\nc -> ghost\n");
    const r = run(["inspect", "w.exd", "--fields", "shapes,fonts,colors,unresolved"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\nshapes\[\d\]\{kind,count\}:\n/);
    expect(r.stdout).toContain("  cylinder,1\n");
    expect(r.stdout).toMatch(/\nfonts\[1\]\{font,texts\}:\n {2}Excalifont,\d+\n/);
    expect(r.stdout).toMatch(/\ncolors\[\d\]\{fill,nodes\}:\n/);
    expect(r.stdout).toMatch(/\nunresolved\[1\]\{kind,id,detail\}:\n {2}implicit-node,ghost,/);
    expect(r.stdout).not.toContain("\nnodes[");
    const bad = run(["inspect", "w.exd", "--fields", "nodes,wat"], { cwd: dir });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain("valid fields:");
  });

  it("reports unbound arrows in a foreign scene", () => {
    const dir = tempDir();
    const elements = [
      { id: "box", type: "rectangle", x: 0, y: 0, width: 100, height: 50, backgroundColor: "#fff" },
      { id: "ar", type: "arrow", x: 100, y: 25, width: 50, height: 0, points: [[0, 0], [50, 0]], startBinding: { elementId: "box" }, endBinding: null },
    ];
    write(dir, "f.excalidraw", JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} }));
    const r = run(["inspect", "f.excalidraw", "--fields", "edges,unresolved"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("edges[1]: box>?\n");
    expect(r.stdout).toMatch(/unresolved\[1\]\{kind,id,detail\}:\n {2}unbound-end,ar,/);
  });

  it("truncates long id lists at 800 chars unless --full", () => {
    const dir = tempDir();
    const dsl = Array.from({ length: 120 }, (_, i) => `node_number_${i}[N${i}]`).join("\n") + "\n";
    write(dir, "big.exd", dsl);
    const cut = run(["inspect", "big.exd", "--fields", "nodes"], { cwd: dir });
    expect(cut.status).toBe(0);
    expect(cut.stdout).toMatch(/\nnodes\[120\]: node_number_0,/);
    expect(cut.stdout).toMatch(/\n {2}\.\.\. \(truncated, \d+ chars total\)\n/);
    expect(cut.stdout).toContain("inspect big.exd --full");
    const full = run(["inspect", "big.exd", "--fields", "nodes", "--full"], { cwd: dir });
    expect(full.stdout).not.toContain("truncated");
    expect(full.stdout).toContain("node_number_119");
    expect(full.stdout.length).toBeGreaterThan(cut.stdout.length);
  });

  it("prints the definitive empty state for a diagram with no nodes", () => {
    const dir = tempDir();
    write(dir, "empty.exd", "# nothing yet\n");
    const r = run(["inspect", "empty.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      "scene: 0 nodes, 0 edges, 0 groups in empty.exd\nhelp[2]:\n  diagram-axi syntax example\n  diagram-axi draw --help\n",
    );
  });

  it("exit codes: parse error 1, bad json 1, missing file 1, no argument 2", () => {
    const dir = tempDir();
    write(dir, "bad.exd", "a[A\n");
    write(dir, "bad.excalidraw", "nope");
    const parseErr = run(["inspect", "bad.exd"], { cwd: dir });
    expect(parseErr.status).toBe(1);
    expect(parseErr.stdout).toMatch(/^error: line 1, col \d+: /);
    expect(run(["inspect", "bad.excalidraw"], { cwd: dir }).status).toBe(1);
    expect(run(["inspect", "missing.exd"], { cwd: dir }).status).toBe(1);
    expect(run(["inspect"], { cwd: dir }).status).toBe(2);
    expect(run(["inspect", "bad.exd", "--nope"], { cwd: dir }).status).toBe(2);
  });
});

describe("check", () => {
  it("prints the definitive ok form and exits 0", () => {
    const dir = tempDir();
    write(dir, "arch.exd", ARCH);
    const r = run(["check", "arch.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^check: ok, 0 errors, 0 warnings in arch\.exd\nquality: ok\nhelp\[\d\]:\n/);
  });

  it("AE4: an undeclared edge target is an implicit-node warning, exit 0; --strict exits 1", () => {
    const dir = tempDir();
    write(dir, "d.exd", "a[A]\na -> b\n");
    const r = run(["check", "d.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("check: ok, 0 errors, 1 warning in d.exd\n");
    expect(r.stdout).toMatch(/\nwarnings\[1\]\{line,col,code,message\}:\n {2}2,\d+,implicit-node,/);
    expect(r.stdout).not.toContain("errors[");
    const strict = run(["check", "d.exd", "--strict"], { cwd: dir });
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("check: failed (--strict), 0 errors, 1 warning");
  });

  it("errors exit 1 with an errors table (parse error, duplicate id)", () => {
    const dir = tempDir();
    write(dir, "p.exd", "a[A]\nb[B -> c\n");
    const p = run(["check", "p.exd"], { cwd: dir });
    expect(p.status).toBe(1);
    expect(p.stdout).toContain("check: failed, 1 error, 0 warnings in p.exd\n");
    expect(p.stdout).toMatch(/\nerrors\[1\]\{line,col,code,message\}:\n {2}2,5,expected-token,/);

    write(dir, "dup.exd", "a[One]\na[Two]\n");
    const d = run(["check", "dup.exd"], { cwd: dir });
    expect(d.status).toBe(1);
    expect(d.stdout).toMatch(/\n {2}2,\d+,duplicate-node,/);
  });

  it("lints size, nesting and label length", () => {
    const dir = tempDir();
    write(dir, "many.exd", Array.from({ length: 61 }, (_, i) => `n${i}[N${i}]`).join("\n") + "\n");
    expect(run(["check", "many.exd"], { cwd: dir }).stdout).toMatch(/\n {2}61,1,too-many-nodes,/);

    write(dir, "deep.exd", "group a {\n group b {\n  group c {\n   x[X]\n  }\n }\n}\n");
    expect(run(["check", "deep.exd"], { cwd: dir }).stdout).toMatch(/\n {2}3,\d+,deep-nesting,/);

    write(dir, "long.exd", `a[${"word ".repeat(10).trim()}]\nb[short\\nlabel]\n`);
    const long = run(["check", "long.exd"], { cwd: dir });
    expect(long.stdout).toMatch(/\n {2}1,1,long-label,/);
    expect(long.stdout.match(/long-label/g)).toHaveLength(1);

    const side = (p: string) => [1, 2, 3, 4].map((i) => `  ${p}${i}[${p.toUpperCase()}${i}]`);
    const links = ["a1 -> b1", "a2 -> b2", "a3 -> b3", "a4 -> b4", "a1 -> b2", "a2 -> b3", "a3 -> b4"];
    const cross = (n: number) => ["group A {", ...side("a"), "}", "group B {", ...side("b"), "}", ...links.slice(0, n)].join("\n") + "\n";
    write(dir, "cross.exd", cross(7));
    expect(run(["check", "cross.exd"], { cwd: dir }).stdout).toMatch(/\n {2}19,\d+,cross-group-edges,7 edges cross group boundaries; cross-group routes tangle past 6\n/);
    write(dir, "cross6.exd", cross(6));
    expect(run(["check", "cross6.exd"], { cwd: dir }).stdout).not.toContain("cross-group-edges");
  });

  it("reads stdin with -, and exit codes: no argument 2, missing file 1", () => {
    const dir = tempDir();
    const r = run(["check", "-"], { cwd: dir, input: "a -> b\n" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in stdin\n");
    expect(r.stdout).toContain("implicit-node");
    expect(run(["check"], { cwd: dir }).status).toBe(2);
    expect(run(["check", "d.exd", "--nope"], { cwd: dir }).status).toBe(2);
    expect(run(["check", "missing.exd"], { cwd: dir }).status).toBe(1);
  });
});
