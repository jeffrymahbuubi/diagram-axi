// Quality line tests (unit C): hints.ts maps checker findings to input-level fixes, shared.ts renders the
// `quality:` block, draw/inspect/check print it, --strict-quality turns HARD rows into exit 1.
// The layout is HARD-clean on the corpus, so HARD rows come from scenes that are broken on purpose.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/dsl/parser.js";
import { hasHard, qualityBlock } from "../src/commands/shared.js";
import { layout } from "../src/layout/dagre-layout.js";
import { qualityHints, type QualityRow } from "../src/quality/hints.js";
import { buildScene } from "../src/scene/build.js";
import { fixture, run, tempDir, write } from "./helpers/run.js";

type El = Record<string, any>;
const CORPUS = (name: string): string => fixture(`../qa/corpus/${name}`);

function scene(src: string, direction: "DOWN" | "RIGHT" = "DOWN") {
  const { graph, diagnostics } = parse(src);
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return { graph, scene: buildScene(graph, layout({ graph, direction })) };
}
const el = (s: { elements: unknown[] }, id: string): El => (s.elements as El[]).find((e) => e.id === id) as El;
const row = (rows: QualityRow[], code: string): QualityRow => {
  const hit = rows.find((r) => r.code === code);
  expect(hit, `row ${code} in ${rows.map((r) => r.code).join(",")}`).toBeDefined();
  return hit as QualityRow;
};
const fake = (code: string, severity: "hard" | "soft" = "hard"): QualityRow => ({ code, severity, detail: `${code} detail`, fix: `${code} fix` });

describe("qualityBlock", () => {
  it("prints `quality: ok` for no rows", () => {
    expect(qualityBlock([])).toBe("quality: ok");
  });

  it("prints a TOON table with code,detail,fix and quotes commas and quotes", () => {
    const rows = [{ ...fake("label-on-foreign-arrow"), detail: 'label "retry" crossed by edge-3', fix: "merge a -> b (4): a -> b : x\\ny, z" }];
    expect(qualityBlock(rows)).toBe(
      'quality[1]{code,detail,fix}:\n  label-on-foreign-arrow,"label ""retry"" crossed by edge-3","merge a -> b (4): a -> b : x\\ny, z"',
    );
  });

  it("caps at 8 rows and says how many there are", () => {
    const rows = Array.from({ length: 11 }, (_, i) => fake(`code-${i}`));
    const text = qualityBlock(rows);
    expect(text.split("\n")[0]).toBe("quality[8 of 11 total]{code,detail,fix}:");
    expect(text.split("\n")).toHaveLength(9);
  });

  it("hasHard is true only for HARD rows", () => {
    expect(hasHard([fake("aspect-ratio", "soft")])).toBe(false);
    expect(hasHard([fake("aspect-ratio", "soft"), fake("node-overlap")])).toBe(true);
    expect(hasHard([])).toBe(false);
  });
});

describe("qualityHints", () => {
  it("is empty for a clean scene", () => {
    const s = scene(readFileSync(fixture("arch.exd"), "utf8"), "RIGHT");
    expect(qualityHints(s.scene, { graph: s.graph, direction: "RIGHT" })).toEqual([]);
  });

  it("parallel pair: merge fix names the pair, its count and the joined labels", () => {
    const s = scene(readFileSync(CORPUS("edge-multi-edge-k4.exd"), "utf8"));
    const [a0, a1] = [el(s.scene, "edge-0"), el(s.scene, "edge-1")];
    a1.x = a0.x + 3;
    a1.y = a0.y;
    a1.points = a0.points; // two arrows drawn 3 px apart
    const rows = qualityHints(s.scene, { graph: s.graph, direction: "DOWN" });
    // Two arrows drawn on top of each other also hide arrowheads: the round-5 soft row (3 or more hidden / crowded heads) comes with them.
    expect(rows.every((r) => r.severity === "hard" || r.code === "arrowhead-covered")).toBe(true);
    expect(row(rows, "arrowhead-covered")).toMatchObject({ severity: "soft" });
    const merge ="merge parallel edges a -> b (4) into one: a -> b : one\\ntwo\\nthree\\nfour";
    expect(row(rows, "parallel-edges-close").fix).toBe(merge);
    expect(row(rows, "arrowheads-crowded").fix).toBe(merge);
    expect(row(rows, "label-on-foreign-arrow").fix).toBe(merge);
    expect(row(rows, "parallel-edges-close").detail).toBe("edge a -> b and edge a -> b run 3 px apart over 84 px");
    // Without the graph (a foreign .excalidraw) the bindings give the same ids.
    expect(row(qualityHints(s.scene, {}), "parallel-edges-close").fix).toBe(merge);
  });

  it("folds findings with the same cause into one row", () => {
    const s = scene("a[A]\nb[B]\na -> b : one\na -> b : two\na -> b : three\na -> b : four\n");
    const [a0, a1, a2] = ["edge-0", "edge-1", "edge-2"].map((id) => el(s.scene, id));
    for (const a of [a1, a2]) Object.assign(a, { x: a0.x + 3, y: a0.y, points: a0.points });
    const rows = qualityHints(s.scene, { graph: s.graph });
    expect(rows.filter((r) => r.code === "parallel-edges-close")).toHaveLength(1);
    expect(row(rows, "parallel-edges-close").detail).toMatch(/\(\+\d+ more\)$/);
  });

  it("diamond with more than 4 edges: make it a rectangle (label kept)", () => {
    const s = scene("t{Order topic}\nt -> a[A]\nt -> b[B]\nt -> c[C]\nt -> d[D]\nt -> e[E]\n");
    const [t, a] = [el(s.scene, "node-t"), el(s.scene, "node-a")];
    a.x = t.x + 5;
    a.y = t.y + 5;
    const hit = row(qualityHints(s.scene, { graph: s.graph }), "node-overlap");
    expect(hit.fix).toBe("make 't' a rectangle: t[Order topic]");
    expect(hit.detail).toMatch(/^nodes a and t overlap by /);
  });

  it("busy node: split it or group its neighbours", () => {
    const leaves = Array.from({ length: 9 }, (_, i) => `h -> l${i}[L${i}]`).join("\n");
    const s = scene(`h[Hub]\n${leaves}\n`);
    const [h, l] = [el(s.scene, "node-h"), el(s.scene, "node-l0")];
    l.x = h.x + 5;
    l.y = h.y + 5;
    const rows = qualityHints(s.scene, { graph: s.graph });
    // node-overlap is not a degree code: it falls through to the default fix naming DSL ids
    expect(row(rows, "node-overlap").fix).toBe("layout defect; simplify the diagram near h, l0");
  });

  it("wordy label on a colliding edge: shorten it to 3 words", () => {
    const s = scene("a[A]\nb[B]\nc[C]\nd[D]\na -> b : validate the payload against schema\nc -> d : ok\n");
    const [a0, a1] = [el(s.scene, "edge-0"), el(s.scene, "edge-1")];
    Object.assign(a1, { x: a0.x + 3, y: a0.y, points: a0.points });
    const rows = qualityHints(s.scene, { graph: s.graph });
    expect(row(rows, "label-label-overlap").fix).toBe("shorten label of a -> b to 3 words: a -> b : validate the payload");
  });

  it("anything else: layout defect naming the DSL ids (prefixes stripped)", () => {
    const s = scene("a[A]\nb[B]\na -> b\n");
    el(s.scene, "node-b").x = el(s.scene, "node-a").x + 4;
    el(s.scene, "node-b").y = el(s.scene, "node-a").y + 4;
    const hit = row(qualityHints(s.scene, { graph: s.graph }), "node-overlap");
    expect(hit.fix).toBe("layout defect; simplify the diagram near a, b");
    expect(hit.detail).not.toMatch(/\bnode-/);
  });

  it("aspect ratio: suggests the other rank direction only when it measurably helps", () => {
    const s = scene(readFileSync(CORPUS("edge-fan-out-14.exd"), "utf8"));
    const probe = (ratios: Record<string, number>) => (dir: string) => ratios[dir];
    const helped = row(qualityHints(s.scene, { graph: s.graph, direction: "DOWN", probe: probe({ RIGHT: 2.6 }) }), "aspect-ratio");
    expect(helped).toMatchObject({ severity: "soft", fix: "try dir RIGHT (aspect 6.7:1 becomes 2.6:1)" });
    const same = row(qualityHints(s.scene, { graph: s.graph, direction: "DOWN", probe: probe({ RIGHT: 7 }) }), "aspect-ratio");
    expect(same.fix).toBe("group nodes or split the diagram so it grows in both directions");
    expect(row(qualityHints(s.scene, {}), "aspect-ratio").fix).toBe(same.fix);
  });

  it("arrow-crossings is reported only when high (> 20 or > 2 x edges)", () => {
    const calm = scene(readFileSync(fixture("crash-multi-edge.exd"), "utf8"));
    expect(qualityHints(calm.scene, { graph: calm.graph, direction: "DOWN" })).toEqual([]);
    const busy = scene(readFileSync(CORPUS("edge-60-nodes.exd"), "utf8"));
    const hit = row(qualityHints(busy.scene, { graph: busy.graph, direction: "DOWN" }), "arrow-crossings");
    expect(hit).toMatchObject({ severity: "soft", detail: "42 crossings on 70 edges" });
  });

  it("budget: edge-60-nodes quality takes under 150 ms", () => {
    const busy = scene(readFileSync(CORPUS("edge-60-nodes.exd"), "utf8"));
    qualityHints(busy.scene, { graph: busy.graph, direction: "DOWN" }); // warm up
    const t0 = performance.now();
    qualityHints(busy.scene, { graph: busy.graph, direction: "DOWN" });
    expect(performance.now() - t0).toBeLessThan(150);
  });
});

describe("draw / inspect / check output", () => {
  it("draw prints `quality: ok` on arch.exd, after the scene line and before help", () => {
    const dir = tempDir();
    const r = run(["draw", fixture("arch.exd"), "--out", "arch"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\nscene: [^\n]+\nquality: ok\nhelp\[3\]:\n/);
    expect(r.stdout).toContain("syntax style");
    expect(r.stderr).toBe("");
  });

  it("draw: crash-multi-edge and edge-multi-edge-k4 are layout-clean (`quality: ok`)", () => {
    const dir = tempDir();
    for (const file of [fixture("crash-multi-edge.exd"), CORPUS("edge-multi-edge-k4.exd")]) {
      const r = run(["draw", file, "--out", "x", "--force"], { cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("\nquality: ok\n");
    }
  });

  it("draw: quality rows come as a TOON table and `syntax tips` replaces `syntax style`", () => {
    const dir = tempDir();
    const r = run(["draw", CORPUS("edge-fan-out-14.exd"), "--out", "fan"], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /\nquality\[1\]\{code,detail,fix\}:\n {2}aspect-ratio,diagram is \d+x\d+ px \(6\.7:1\),try dir RIGHT \(aspect 6\.7:1 becomes [\d.]+:1\)\n/,
    );
    expect(r.stdout).toContain("diagram-axi syntax tips");
    expect(r.stdout).not.toContain("syntax style");
    const busy = run(["draw", CORPUS("edge-60-nodes.exd"), "--out", "big"], { cwd: dir });
    expect(busy.status).toBe(0);
    expect(busy.stdout).toMatch(/\nquality\[1\]\{code,detail,fix\}:\n {2}arrow-crossings,42 crossings on 70 edges,/);
  });

  it("inspect prints the quality line for .exd and for a foreign .excalidraw", () => {
    const dir = tempDir();
    const dsl = run(["inspect", fixture("arch.exd")], { cwd: dir });
    expect(dsl.stdout).toMatch(/\nsize: [^\n]+\nquality: ok\nhelp/);
    const only = run(["inspect", CORPUS("edge-fan-out-14.exd"), "--fields", "quality"], { cwd: dir });
    expect(only.stdout).toMatch(/^scene: [^\n]+\nquality\[1\]\{code,detail,fix\}:\n {2}aspect-ratio,/);
    run(["draw", CORPUS("edge-fan-out-14.exd"), "--out", "fan"], { cwd: dir });
    const scene = run(["inspect", join(dir, "fan.excalidraw"), "--fields", "quality"], { cwd: dir });
    expect(scene.status).toBe(0);
    expect(scene.stdout).toMatch(/\nquality\[1\]\{code,detail,fix\}:\n {2}aspect-ratio,[^\n]+,group nodes or split the diagram/);
    expect(scene.stderr).toBe("");
  });

  it("check: quality line after the verdict, before the warnings", () => {
    const r = run(["check", fixture("arch.exd")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^check: ok, 0 errors, 0 warnings in [^\n]+\nquality: ok\nhelp/);
  });

  it("check: no quality line (and no layout) when the parse fails", () => {
    const dir = tempDir();
    write(dir, "bad.exd", "a[A]\nb[B]\na -> b\napi[API -> db\n");
    const r = run(["check", "bad.exd"], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("quality");
  });
});

describe("check suggestion ranking", () => {
  it("prints the parallel-edges fix, not the first warning's (implicit-node) fix", () => {
    const r = run(["check", fixture("crash-multi-edge.exd")]);
    expect(r.status).toBe(0);
    // The table stays in position order: the first row is the implicit-node on line 1.
    expect(r.stdout).toMatch(/warnings\[6\]\{line,col,code,message\}:\n {2}1,1,implicit-node,/);
    expect(r.stdout).toContain("\nsuggestion: merge them: stage --> mq : every 5s\\ncommit\n");
  });

  it("ranks by impact: parallel-edges beats busy-node beats long-label beats implicit-node", () => {
    const dir = tempDir();
    const leaves = Array.from({ length: 9 }, (_, i) => `h -> l${i}[L${i}]`).join("\n");
    write(dir, "busy.exd", `${leaves}\nh[Hub]\n`);
    expect(run(["check", "busy.exd"], { cwd: dir }).stdout).toContain("suggestion: split 'h'");
    write(dir, "both.exd", `${leaves}\nh[Hub]\nx[X]\ny[Y]\nx -> y : a\nx -> y : b\nx -> y : c\n`);
    expect(run(["check", "both.exd"], { cwd: dir }).stdout).toContain("suggestion: merge them: x -> y : a\\nb\\nc\n");
    write(dir, "long.exd", `a[${"w".repeat(45)}]\nb[B]\na -> b\nc -> b\n`);
    const long = run(["check", "long.exd"], { cwd: dir }).stdout;
    expect(long).toContain("suggestion: break the label with");
  });

  it("an error suggestion still wins over every warning", () => {
    const dir = tempDir();
    write(dir, "bad.exd", "a[A]\nb[B]\na -> b\napi[API -> db\n");
    expect(run(["check", "bad.exd"], { cwd: dir }).stdout).toContain("suggestion: close the label: api[API] -> db\n");
  });
});

describe("--strict-quality", () => {
  it("is a documented flag on draw and check", () => {
    for (const cmd of ["draw", "check"]) {
      const r = run([cmd, "--help"]);
      expect(r.stdout).toContain("--strict-quality");
      expect(r.stdout).toContain("treat HARD layout findings as errors (exit 1); files are still written");
    }
  });

  it("exits 0 on a clean diagram and on SOFT rows only", () => {
    const dir = tempDir();
    expect(run(["draw", fixture("arch.exd"), "--out", "a", "--strict-quality"], { cwd: dir }).status).toBe(0);
    const soft = run(["draw", CORPUS("edge-fan-out-14.exd"), "--out", "f", "--strict-quality"], { cwd: dir });
    expect(soft.status).toBe(0);
    expect(soft.stdout).toContain("aspect-ratio");
    expect(run(["check", fixture("arch.exd"), "--strict-quality"]).status).toBe(0);
  });

  it("writes the files and exits 1 when a HARD row exists (integration)", () => {
    const dir = tempDir();
    write(dir, "hard.exd", HARD_TEXT);
    const loose = run(["draw", "hard.exd"], { cwd: dir });
    expect(loose.status).toBe(0);
    expect(loose.stdout).toMatch(/\nquality\[\d+/);
    const strict = run(["draw", "hard.exd", "--force", "--strict-quality"], { cwd: dir });
    expect(strict.status).toBe(1);
    expect(strict.stdout.startsWith("draw: failed (--strict-quality), files written\n")).toBe(true);
    expect(strict.stdout).toMatch(/\nquality\[\d+\]\{code,detail,fix\}:\n(?: {2}[^\n]*\n)*? {2}arrow-through-node,[^\n]*node n2[^\n]*,'n1' has 16 edges and every arrowhead needs a 28 px slot[^\n]*\n/);
    expect(existsSync(join(dir, "hard.excalidraw"))).toBe(true);
    const check = run(["check", "hard.exd", "--strict-quality"], { cwd: dir });
    expect(check.status).toBe(1);
    expect(check.stdout.startsWith("check: failed (--strict-quality), 0 errors,")).toBe(true);
    expect(run(["check", "hard.exd"], { cwd: dir }).status).toBe(0);
  }, 120_000);
});

/** fuzz profile multi-edge, seed 1942791417 (scripts/qa/gen.mjs): sixteen arrows meet on `n1`; the layout (round 5: the hub grows wide enough for every arrowhead) still leaves one arrow through `n2` (HARD arrow-through-node) and a label on a foreign arrow, even after the legacy retry. */
const HARD_TEXT = `dir DOWN
n0[Metrics Session Client]
n1{Report Notifier}
n2[(Storage)]
n3{Search}
n4[Validator] :pink
n5[Inventory Client\\nLoader] :dashed
n0 -> n1 : trigger
n0 <-> n1 : yes emit emit
n1 -> n0 : ok stream
n1 <-> n2 : subscribe commit subscribe
n1 <-> n2 : fail emit
n2 -> n1 : validate stream response
n1 -> n2 : timeout validate deploy
n1 -> n3
n1 <-> n3 : approve emit yes
n1 <-> n4 : validate
n1 <-> n4 : batch trigger ok
n1 <-> n5 : cache hit route
n1 --> n5 : trigger trigger store
n5 -> n1 : ack notify every 5s
n1 --> n5 : deploy response
n5 -> n1 : stream read response
n2 -> n5 : ack
n2 -> n5 : notify deploy yes
n0 <-> n4 : rollback
n4 <-> n0
n0 -> n4 : timeout batch validate
`;
