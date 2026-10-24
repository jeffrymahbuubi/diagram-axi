// Lint tests: the seven authoring-rule lints (plan 2026-10-23, section 1), their literal
// suggestions (they must parse and clear the lint), --strict handling and the curated corpus.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/dsl/ast.js";
import { parse } from "../src/dsl/parser.js";
import { lint } from "../src/lint/rules.js";
import { fixture, run, tempDir, write } from "./helpers/run.js";

function parsed(src: string) {
  const r = parse(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r;
}
const lintOf = (src: string): Diagnostic[] => lint(parsed(src).graph);
const codes = (src: string): string[] => lintOf(src).map((d) => d.code);
const only = (src: string, code: string): Diagnostic => {
  const hit = lintOf(src).filter((d) => d.code === code);
  expect(hit).toHaveLength(1);
  return hit[0] as Diagnostic;
};
/** `star(n, shape)` = hub `h` plus n leaves, edges h -> l1..ln. */
const star = (n: number, hub = "h[Hub]"): string => `${hub}\n` + Array.from({ length: n }, (_, i) => `h -> l${i + 1}[L${i + 1}]`).join("\n") + "\n";
const text = (d: Diagnostic, prefix: string): string => {
  expect(d.suggestion?.startsWith(prefix)).toBe(true);
  return (d.suggestion as string).slice(prefix.length);
};

describe("parallel-edges", () => {
  const src = "a[A]\nb[B]\na -> b : x\na -> b : y\na -> b : z\n";

  it("AE-L1: three edges between one pair, merged suggestion", () => {
    const d = only(src, "parallel-edges");
    expect(d).toMatchObject({ line: 3, severity: "warning", message: "3 edges between 'a' and 'b'; parallel arrows crowd arrowheads and labels" });
    expect(d.suggestion).toBe("merge them: a -> b : x\\ny\\nz");
    expect(codes(src)).toEqual(["parallel-edges"]);
  });

  it("two edges are fine; self-loops are excluded", () => {
    expect(codes("a[A]\nb[B]\na -> b : x\na -> b : y\n")).toEqual([]);
    expect(codes("a[A]\nb[B]\na -> a\na -> a\na -> a\na -> b\n")).toEqual([]);
  });

  it("both directions merge into <->, unlabeled edges are dropped from the label", () => {
    const d = only("app[App]\nauthz[Authz]\napp -> authz : redirect\nauthz -> app : code\napp -> authz\napp -> authz : secret\n", "parallel-edges");
    expect(d.message).toBe("4 edges between 'app' and 'authz'; parallel arrows crowd arrowheads and labels");
    expect(d.suggestion).toBe("merge them: app <-> authz : redirect\\ncode\\nsecret");
  });

  it("no labels at all -> bare edge", () => {
    expect(only("a[A]\nb[B]\na -> b\na -> b\na -> b\n", "parallel-edges").suggestion).toBe("merge them: a -> b");
  });

  it("one warning per pair", () => {
    const two = "a[A]\nb[B]\nc[C]\n" + "a -> b\n".repeat(3) + "b -> c\n".repeat(3);
    expect(codes(two)).toEqual(["parallel-edges", "parallel-edges"]);
  });

  it("applying the suggestion parses and clears the lint", () => {
    const merged = `a[A]\nb[B]\n${text(only(src, "parallel-edges"), "merge them: ")}\n`;
    expect(codes(merged)).toEqual([]);
    const g = parsed(merged).graph;
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.label).toBe("x\ny\nz");
  });

  it("quotes labels that contain #", () => {
    const d = only("a[A]\nb[B]\na -> b : \"issue #1\"\na -> b : two\na -> b : three\n", "parallel-edges");
    expect(d.suggestion).toBe('merge them: a -> b : "issue #1\\ntwo\\nthree"');
    expect(parsed(`a[A]\nb[B]\n${text(d, "merge them: ")}\n`).graph.edges[0]?.label).toBe("issue #1\ntwo\nthree");
  });
});

describe("diamond-hub and busy-node", () => {
  it("AE-L2: diamond with 5 edges", () => {
    const src = star(5, "h{T}");
    const d = only(src, "diamond-hub");
    expect(d).toMatchObject({ line: 1, col: 1, message: "diamond 'h' has 5 connections; diamonds route poorly past 4" });
    expect(d.suggestion).toBe("make it a rectangle: h[T]");
    expect(codes(src)).toEqual(["diamond-hub"]);
  });

  it("4 connections are fine; non-diamonds never fire", () => {
    expect(codes(star(4, "h{T}"))).toEqual([]);
    expect(codes(star(8))).toEqual([]);
  });

  it("AE-L2: the same node with 9 edges also gets busy-node", () => {
    const src = star(9, "h{T}");
    expect(codes(src).sort()).toEqual(["busy-node", "diamond-hub"]);
    expect(only(src, "busy-node").message).toBe("'h' has 9 edges; ports get closer than an arrowhead");
  });

  it("busy-node: threshold is > 8, a self-loop counts once", () => {
    expect(codes(star(8) + "h -> h\n")).toEqual(["busy-node"]);
    expect(codes(star(7) + "h -> h\n")).toEqual([]);
    expect(codes(star(9))).toEqual(["busy-node"]);
  });

  it("diamond suggestion keeps label lines and style and clears the lint", () => {
    const src = 'h{Is it\\nready?} :red,bold\n' + Array.from({ length: 5 }, (_, i) => `h -> l${i}[L${i}]`).join("\n") + "\n";
    const d = only(src, "diamond-hub");
    expect(d.suggestion).toBe("make it a rectangle: h[Is it\\nready?] :red,bold");
    const fixed = src.replace(/^h\{.*$/m, text(d, "make it a rectangle: "));
    expect(codes(fixed)).toEqual([]);
    const h = parsed(fixed).graph.nodes[0];
    expect(h).toMatchObject({ shape: "rect", label: "Is it\nready?", color: "red", flags: ["bold"] });
  });

  it("busy-node suggestion contains a group snippet that parses", () => {
    const src = star(9);
    const d = only(src, "busy-node");
    expect(d.suggestion).toBe(`split 'h' into two nodes or move its neighbours into a group: group g1 "Workers" { w1[...]; w2[...] }`);
    const snippet = text(d, "split 'h' into two nodes or move its neighbours into a group: ");
    expect(parsed(src + snippet + "\n").graph.groups.map((g) => g.id)).toEqual(["g1"]);
  });

  it("busy-node snippet picks free ids", () => {
    const src = star(9).replace("h[Hub]", "h[Hub]\ng1[G]\nw1[W]");
    expect(only(src, "busy-node").suggestion).toContain('group g2 "Workers" { w2[...]; w3[...] }');
  });
});

describe("dense-graph and many-nodes", () => {
  const dense = (nodes: number, edges: number): string => {
    const ids = Array.from({ length: nodes }, (_, i) => `n${i}`);
    const lines = ids.map((id) => `${id}[${id.toUpperCase()}]`);
    for (let i = 0; i < edges; i++) lines.push(`n${i % nodes} -> n${(i * 7 + 3 + Math.floor(i / nodes)) % nodes === i % nodes ? (i + 1) % nodes : (i * 7 + 3 + Math.floor(i / nodes)) % nodes} : e${i}`);
    return lines.join("\n") + "\n";
  };

  it("fires on > 2 x nodes with >= 6 nodes", () => {
    const d = only(dense(6, 13), "dense-graph");
    expect(d.message).toBe("13 edges on 6 nodes (2.2 per node); expect many crossings");
    expect(d.suggestion).toBe("drop secondary edges or split into two diagrams; keep edges <= 2 x nodes");
    expect(d.line).toBe(7);
  });

  it("does not fire at exactly 2 x nodes or under 6 nodes", () => {
    expect(codes(dense(6, 12))).not.toContain("dense-graph");
    expect(codes(dense(5, 20))).not.toContain("dense-graph");
  });

  it("many-nodes: 26..60 nodes, busyness wording", () => {
    const nodes = (n: number) => Array.from({ length: n }, (_, i) => `n${i}[N${i}]`).join("\n") + "\n";
    expect(codes(nodes(25))).toEqual([]);
    const d = only(nodes(31), "many-nodes");
    expect(d).toMatchObject({ line: 26, message: "diagram has 31 nodes; readability drops past 25 (crossings grow ~5x)" });
    expect(d.suggestion).toBe('group related nodes (group id "Title" { ... }) or split into two .exd files');
    expect(codes(nodes(60))).toEqual(["many-nodes"]);
  });

  it("too-many-nodes (> 60) stays stronger: many-nodes is suppressed", () => {
    const src = Array.from({ length: 61 }, (_, i) => `n${i}[N${i}]`).join("\n") + "\n";
    expect(codes(src)).toEqual(["too-many-nodes"]);
  });
});

describe("wordy-edge-label and long-label", () => {
  it("AE-L4: 5 words / 38 chars -> wordy only, break suggestion", () => {
    const src = "a[A]\nb[B]\na -> b : validate the payload against schema\n";
    const d = only(src, "wordy-edge-label");
    expect(d.message).toBe("label of edge a -> b has 5 words; keep edge labels to 3 words");
    expect(d.suggestion).toBe("break it: a -> b : validate the payload\\nagainst schema");
    expect(codes(src)).toEqual(["wordy-edge-label"]);
    const fixed = `a[A]\nb[B]\n${text(d, "break it: ")}\n`;
    expect(codes(fixed)).toEqual([]);
    expect(parsed(fixed).graph.edges[0]?.label).toBe("validate the payload\nagainst schema");
  });

  it("AE-L4: a 45-char label -> long-label only", () => {
    const src = `a[A]\nb[B]\na -> b : ${"x".repeat(45)}\n`;
    expect(codes(src)).toEqual(["long-label"]);
    const words = "a[A]\nb[B]\na -> b : one two three four five six seven eight nine ten eleven twelve\n";
    expect(codes(words)).toEqual(["long-label"]);
  });

  it("more than 6 words -> shorten to the first 3", () => {
    const src = "a[A]\nb[B]\na -> b : one two three four five six seven\n";
    const d = only(src, "wordy-edge-label");
    expect(d.suggestion).toBe("shorten it: a -> b : one two three");
    expect(codes(`a[A]\nb[B]\n${text(d, "shorten it: ")}\n`)).toEqual([]);
  });

  it("boundaries: 3 words and 30 chars are fine, 31 chars fires", () => {
    expect(codes("a[A]\nb[B]\na -> b : one two three\n")).toEqual([]);
    expect(codes(`a[A]\nb[B]\na -> b : ${"y".repeat(30)}\n`)).toEqual([]);
    const d = only(`a[A]\nb[B]\na -> b : ${"y".repeat(31)}\n`, "wordy-edge-label");
    expect(d.message).toBe("label of edge a -> b has a 31-char line; keep edge label lines under 30 chars");
    expect(d.suggestion).toBe(`shorten it: a -> b : ${"y".repeat(28)}`);
  });

  it("chars trigger with several words -> break between words; arrow kind is kept", () => {
    const d = only("a[A]\nb[B]\na --> b : alphabetical synchronization sequences\n", "wordy-edge-label");
    expect(d.suggestion).toBe("break it: a --> b : alphabetical\\nsynchronization sequences");
  });

  it("words are counted per line, so a broken label does not fire", () => {
    expect(codes("a[A]\nb[B]\na -> b : validate the payload\\nagainst schema\n")).toEqual([]);
  });

  it("node labels are never wordy (existing long-label behavior)", () => {
    expect(codes(`a[${"word ".repeat(10).trim()}]\nb[short\\nlabel]\n`)).toEqual(["long-label"]);
  });
});

describe("cross-group-edges", () => {
  /** Groups A (a1..a4) and B (b1..b4) joined by the first `cross` of 8 distinct a -> b edges, then `within` edges inside A. */
  const crossing = (cross: number, within = 0): string => {
    const links = ["a1 -> b1", "a2 -> b2", "a3 -> b3", "a4 -> b4", "a1 -> b2", "a2 -> b3", "a3 -> b4", "a4 -> b1"];
    const inside = ["a1 -> a2", "a2 -> a3", "a3 -> a4"];
    const members = (p: string) => [1, 2, 3, 4].map((i) => `  ${p}${i}[${p.toUpperCase()}${i}]`);
    const lines = ["group A {", ...members("a"), "}", "group B {", ...members("b"), "}", ...links.slice(0, cross), ...inside.slice(0, within)];
    return lines.join("\n") + "\n";
  };

  it("is silent at 6 cross-group edges", () => {
    expect(codes(crossing(6))).toEqual([]);
  });

  it("warns at 7 with the count, at the first edge past the limit", () => {
    const d = only(crossing(7), "cross-group-edges");
    expect(d.message).toBe("7 edges cross group boundaries; cross-group routes tangle past 6");
    expect(d.suggestion).toBe("move linked nodes into one group or split the diagram");
    expect(d.line).toBe(19); // 12 group lines + the 7th link
    expect(codes(crossing(8))).toEqual(["cross-group-edges"]);
    expect(only(crossing(8), "cross-group-edges").message).toContain("8 edges cross");
  });

  it("edges inside one group do not count; an ungrouped endpoint does", () => {
    expect(codes(crossing(6, 3))).toEqual([]);
    const loose = crossing(6) + "x[X] -> a1\n";
    expect(only(loose, "cross-group-edges").message).toContain("7 edges cross");
  });

  it("does not fire on a diagram without groups", () => {
    const flat = Array.from({ length: 8 }, (_, i) => `n${i} -> n${i + 1}`).join("\n") + "\n";
    expect(codes(flat)).not.toContain("cross-group-edges");
  });
});

describe("reciprocal-pair", () => {
  it("AE-L3: same label fires, different label does not", () => {
    const same = "a[A]\nb[B]\na -> b : ok\nb -> a : ok\n";
    const d = only(same, "reciprocal-pair");
    expect(d).toMatchObject({ line: 3, message: "'a -> b' and 'b -> a' carry the same label; two arrows where one two-headed arrow reads better" });
    expect(d.suggestion).toBe("a <-> b : ok");
    expect(codes("a[A]\nb[B]\na -> b : ok\nb -> a : fail\n")).toEqual([]);
  });

  it("both unlabeled fires with a bare <->; one labeled does not", () => {
    expect(only("a[A]\nb[B]\na -> b\nb -> a\n", "reciprocal-pair").suggestion).toBe("a <-> b");
    expect(codes("a[A]\nb[B]\na -> b : x\nb -> a\n")).toEqual([]);
  });

  it("<-> and -- edges are excluded; a third edge turns it into parallel-edges", () => {
    expect(codes("a[A]\nb[B]\na <-> b\nb -> a\n")).toEqual([]);
    expect(codes("a[A]\nb[B]\na -- b\nb -- a\n")).toEqual([]);
    expect(codes("a[A]\nb[B]\na -> b\nb -> a\na -> b\n")).toEqual(["parallel-edges"]);
  });

  it("one-direction duplicates are not reciprocal", () => {
    expect(codes("a[A]\nb[B]\na -> b\na -> b\n")).toEqual([]);
  });

  it("applying the suggestion parses and clears the lint", () => {
    const d = only("a[A]\nb[B]\na -> b : ok\nb -> a : ok\n", "reciprocal-pair");
    const fixed = `a[A]\nb[B]\n${d.suggestion}\n`;
    expect(codes(fixed)).toEqual([]);
    expect(parsed(fixed).graph.edges).toMatchObject([{ from: "a", to: "b", arrow: "both", label: "ok" }]);
  });
});

describe("check command", () => {
  const AE1 = "a[A]\nb[B]\na -> b : x\na -> b : y\na -> b : z\n";

  it("AE-L1 end to end: one warning row and the suggestion line", () => {
    const dir = tempDir();
    write(dir, "p.exd", AE1);
    const r = run(["check", "p.exd"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("check: ok, 0 errors, 1 warning in p.exd\n");
    expect(r.stdout).toMatch(/\n {2}3,\d+,parallel-edges,"?3 edges between 'a' and 'b'; parallel arrows crowd arrowheads and labels"?\n/);
    expect(r.stdout).toContain("\nsuggestion: merge them: a -> b : x\\ny\\nz\n");
    expect(r.stdout).toMatch(/\nhelp\[2\]:\n {2}diagram-axi check p\.exd --strict\n/);
  });

  it("existing fixtures keep their expectations (arch.exd: 0 warnings)", () => {
    const arch = run(["check", fixture("arch.exd")]);
    expect(arch.stdout).toMatch(/^check: ok, 0 errors, 0 warnings in /);
    const dir = tempDir();
    write(dir, "d.exd", "a[A]\na -> b\n");
    expect(run(["check", "d.exd"], { cwd: dir }).stdout).toContain("check: ok, 0 errors, 1 warning");
  });

  it("--strict exits 1 for the new lints", () => {
    const dir = tempDir();
    write(dir, "p.exd", AE1);
    write(dir, "d.exd", star(5, "h{T}"));
    write(dir, "n.exd", Array.from({ length: 26 }, (_, i) => `n${i}[N${i}]`).join("\n") + "\n");
    write(dir, "w.exd", "a[A]\nb[B]\na -> b : validate the payload against schema\n");
    for (const f of ["p.exd", "d.exd", "n.exd", "w.exd"]) {
      expect(run(["check", f], { cwd: dir }).status, f).toBe(0);
      const strict = run(["check", f, "--strict"], { cwd: dir });
      expect(strict.status, f).toBe(1);
      expect(strict.stdout).toContain("check: failed (--strict), 0 errors, 1 warning");
    }
  });

  it("reciprocal-pair is a warning but excluded from --strict", () => {
    const dir = tempDir();
    write(dir, "r.exd", "a[A]\nb[B]\na -> b : ok\nb -> a : ok\n");
    const plain = run(["check", "r.exd"], { cwd: dir });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain("check: ok, 0 errors, 1 warning in r.exd\n");
    expect(plain.stdout).toContain("reciprocal-pair");
    expect(plain.stdout).toContain("\nsuggestion: a <-> b : ok\n");
    const strict = run(["check", "r.exd", "--strict"], { cwd: dir });
    expect(strict.status).toBe(0);
    expect(strict.stdout).toContain("check: ok, 0 errors, 1 warning in r.exd\n");
    expect(strict.stderr).toBe("");
  });

  it("--strict still fails when a reciprocal-pair comes with a counted warning", () => {
    const dir = tempDir();
    write(dir, "m.exd", "a[A]\nb[B]\na -> b : ok\nb -> a : ok\na -> c\n");
    const strict = run(["check", "m.exd", "--strict"], { cwd: dir });
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("check: failed (--strict), 0 errors, 2 warnings");
  });

  it("help gets 'syntax tips' last only when more than one code fires", () => {
    const dir = tempDir();
    write(dir, "one.exd", AE1);
    expect(run(["check", "one.exd"], { cwd: dir }).stdout).not.toContain("syntax tips");
    write(dir, "two.exd", star(9, "h{T}"));
    const r = run(["check", "two.exd"], { cwd: dir });
    expect(r.stdout).toMatch(/warnings\[2\]/);
    expect(r.stdout.trimEnd().endsWith("diagram-axi syntax tips")).toBe(true);
    expect(r.stdout).toMatch(/\nhelp\[3\]:\n/);
  });

  it("TOON for a multi-edge file (crash-multi-edge.exd)", () => {
    const r = run(["check", fixture("crash-multi-edge.exd")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\nwarnings\[\d\]\{line,col,code,message\}:\n/);
    expect(r.stdout).toContain("parallel-edges");
  });
});

describe("corpus: every curated and fuzz case exits 0 without --strict", () => {
  const dirs = ["qa/corpus", "qa/fuzz-corpus"].map((d) => fileURLToPath(new URL(`./${d}/`, import.meta.url)));

  it("check exits 0, and the stress files named in the plan gain their warnings", () => {
    const seen = new Map<string, string[]>();
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".exd"))) {
        const r = run(["check", join(dir, f)]);
        expect(r.status, f).toBe(0);
        expect(r.stderr, f).toBe("");
        seen.set(f, codes(readFileSync(join(dir, f), "utf8")));
      }
    }
    expect(seen.get("edge-multi-edge-k4.exd")).toContain("parallel-edges");
    expect(seen.get("edge-triple-parallel.exd")).toContain("parallel-edges");
    expect(seen.get("edge-fan-out-14.exd")).toContain("busy-node");
    expect(seen.get("edge-60-nodes.exd")).toContain("many-nodes");
  }, 120_000);

  it("AE-L5: edge-multi-edge-k4 exits 0 with parallel-edges; --strict exits 1", () => {
    const f = fileURLToPath(new URL("./qa/corpus/edge-multi-edge-k4.exd", import.meta.url));
    expect(run(["check", f]).status).toBe(0);
    expect(run(["check", f, "--strict"]).status).toBe(1);
  });
});
