// Layering of the drawn DAG (W = widest layer, L = layers) and what it decides: the width line of denseReason (excalidraw -> d2)
// and `dir RIGHT` on d2. Also the DSL edge order and the two-line hub label that go with the routing/emit round.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate } from "../src/extract/aggregate.js";
import { EXTRACT_MAX_WIDTH, denseReason } from "../src/extract/density.js";
import { layeringOf } from "../src/extract/layering.js";
import { AUTO_DIR_RIGHT, preferredDir, toExd } from "../src/extract/to-exd.js";
import { run, tempDir, write } from "./helpers/run.js";
import { hubApp, raw, smallApp, type EdgeSpec } from "./fixtures/extract/synthetic/graphs.js";

const edges = (...pairs: Array<[string, string]>) => ({ edges: pairs.map(([from, to]) => ({ from, to, stub: false })) });

describe("layeringOf", () => {
  it("is empty without drawn edges; stub lines and self edges do not count", () => {
    expect(layeringOf({ edges: [] })).toEqual({ width: 0, layers: 0 });
    expect(layeringOf({ edges: [{ from: "a", to: "b", stub: true }, { from: "c", to: "c", stub: false }] })).toEqual({ width: 0, layers: 0 });
  });

  it("a chain is one box wide and as deep as it is long", () => {
    expect(layeringOf(edges(["a", "b"], ["b", "c"], ["c", "d"]))).toEqual({ width: 1, layers: 4 });
  });

  it("a fan is as wide as it has targets", () => {
    expect(layeringOf(edges(["r", "a"], ["r", "b"], ["r", "c"], ["r", "d"]))).toEqual({ width: 4, layers: 2 });
  });

  it("longest path: a box sits below its lowest importer, not its first", () => {
    // r -> a -> b -> t and r -> t: t is on layer 3, not 1
    const l = layeringOf(edges(["r", "a"], ["a", "b"], ["b", "t"], ["r", "t"], ["r", "x"]));
    expect(l).toEqual({ width: 2, layers: 4 }); // layer 1 holds a and x
  });

  it("a cycle collapses to one box", () => {
    expect(layeringOf(edges(["a", "b"], ["b", "c"], ["c", "b"], ["c", "d"]))).toEqual({ width: 1, layers: 3 });
    expect(layeringOf(edges(["a", "b"], ["b", "a"]))).toEqual({ width: 1, layers: 1 });
  });

  it("is independent of edge order", () => {
    const e: Array<[string, string]> = [["r", "a"], ["a", "b"], ["r", "b"], ["r", "c"], ["c", "d"], ["d", "c"]];
    expect(layeringOf(edges(...e))).toEqual(layeringOf(edges(...[...e].reverse())));
  });
});

describe("denseReason: the width line", () => {
  // `fan(k)` + a chain of m boxes: 12+ boxes, few edges per box, k boxes side by side
  const wide = (k: number) => edges(...Array.from({ length: k }, (_, i): [string, string] => ["root", `leaf${i}`]), ["leaf0", "m1"], ["m1", "m2"], ["m2", "m3"], ["m3", "m4"], ["m4", "m5"]);

  it("a layer wider than EXTRACT_MAX_WIDTH is wide for excalidraw; EXTRACT_MAX_WIDTH itself is not", () => {
    expect(EXTRACT_MAX_WIDTH).toBe(7);
    expect(denseReason(wide(7))).toBeUndefined();
    expect(denseReason(wide(8))).toBe("wide: 8 boxes side by side");
  });

  it("needs EXTRACT_DENSE_MIN_NODES boxes, like the other lines", () => {
    expect(denseReason(edges(...Array.from({ length: 9 }, (_, i): [string, string] => ["root", `leaf${i}`])))).toBeUndefined();
  });

  it("the density lines win over the width line (the reason names the first that fires)", () => {
    const e = wide(8);
    const more = Array.from({ length: 20 }, (_, i): [string, string] => [`leaf${i % 8}`, `m${1 + (i % 5)}`]);
    expect(denseReason({ edges: [...e.edges, ...more.map(([from, to]) => ({ from, to, stub: false }))] })).toMatch(/^dense: /);
  });
});

describe("dir RIGHT", () => {
  const view = (n: number, chain: number) =>
    aggregate(
      raw(
        ["root.ts", ...Array.from({ length: n }, (_, i) => `leaf${i}.ts`), ...Array.from({ length: chain }, (_, i) => `c${i}.ts`)],
        [
          ...Array.from({ length: n }, (_, i): EdgeSpec => ["root.ts", `leaf${i}.ts`]),
          ["leaf0.ts", "c0.ts"],
          ...Array.from({ length: chain - 1 }, (_, i): EdgeSpec => [`c${i}.ts`, `c${i + 1}.ts`]),
        ],
      ),
      { level: "file", group: "none" },
    );

  it("a deep, narrow view (L > 1.5 W) goes left to right on d2 only", () => {
    expect(AUTO_DIR_RIGHT).toBe(true);
    const v = view(2, 6); // W 2, L 8
    expect(layeringOf(v)).toEqual({ width: 2, layers: 8 });
    expect(preferredDir(v, "d2")).toBe("RIGHT");
    expect(toExd(v, { engine: "d2" }).text).toContain("\ndir RIGHT\n");
    expect(preferredDir(v, "excalidraw")).toBe("DOWN");
    expect(preferredDir(v, undefined)).toBe("DOWN");
    expect(toExd(v).text).toContain("\ndir DOWN\n");
  });

  it("L = 1.5 W is still DOWN; a wide view stays DOWN", () => {
    const v = view(4, 4); // W 4, L 6 = 1.5 W
    expect(layeringOf(v)).toEqual({ width: 4, layers: 6 });
    expect(preferredDir(v, "d2")).toBe("DOWN");
    expect(preferredDir(view(6, 1), "d2")).toBe("DOWN");
  });
});

describe("DSL reading order", () => {
  it("edges are listed by source, then target (stub lines last), not grouped by target", () => {
    const text = toExd(aggregate(smallApp(), { level: "file" })).text;
    const lines = text.split("\n").filter((l) => / (->|-->|<->|-\.->|--) /.test(l));
    const keys = lines.map((l) => /^(\S+) \S+ (\S+)/.exec(l) as RegExpExecArray).map((m) => `${m[1]}\0${m[2]}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("hub labels: two lines", () => {
  it("`used by N, K uses hidden` on one note line", () => {
    const v = aggregate(hubApp(), { isolated: "show" });
    for (const n of v.nodes.filter((x) => x.hub)) expect(n.notes.length).toBeLessThanOrEqual(1);
    const text = toExd(v).text;
    expect(text).not.toMatch(/uses \d+ \(\d+ shown\)/);
  });

  it("a capped hub names how many uses are hidden, singular and plural", () => {
    const targets = Array.from({ length: 9 }, (_, i) => `t${i}.ts`);
    const users = Array.from({ length: 10 }, (_, i) => `u${i}.ts`);
    const g = raw(["hub.ts", ...targets, ...users], [...targets.map((t): EdgeSpec => ["hub.ts", t]), ...users.map((u): EdgeSpec => [u, "hub.ts"])]);
    const hub = aggregate(g, { level: "file" }).nodes.find((x) => x.path === "hub.ts");
    expect(hub?.notes).toEqual(["used by 10, 1 use hidden"]);
  });
});

describe("extract CLI: the direction follows the engine the file is drawn with", () => {
  /** n files in a chain, each importing the next one (and, with `skip`, the one after it too). */
  function chain(n: number, skip: boolean): string {
    const dir = tempDir();
    for (let i = 0; i < n; i++) {
      const to = [i + 1, ...(skip ? [i + 2] : [])].filter((j) => j < n).map((j) => `import "./f${j}.js";\n`);
      write(dir, `src/f${i}.ts`, `${to.join("")}export const v${i} = ${i};\n`);
    }
    return join(dir, "src");
  }
  const exdOf = (src: string): { stdout: string; text: string } => {
    const out = join(tempDir(), "imports");
    const r = run(["extract", src, "--group", "none", "--out", out]);
    expect(r.status).toBe(0);
    return { stdout: r.stdout, text: readFileSync(`${out}.exd`, "utf8") };
  };

  it("a deep, dense chain is suggested to d2 and written `dir RIGHT`", () => {
    const { stdout, text } = exdOf(chain(14, true));
    expect(stdout).toMatch(/^engine: suggest d2 \(dense: /m);
    expect(text).toMatch(/^dir RIGHT$/m);
  });

  it("the same depth on a view that stays on excalidraw keeps `dir DOWN`", () => {
    const { stdout, text } = exdOf(chain(8, false));
    expect(stdout).not.toMatch(/^engine: suggest/m);
    expect(text).toMatch(/^dir DOWN$/m);
  });
});
