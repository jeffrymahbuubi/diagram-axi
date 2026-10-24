#!/usr/bin/env node
// d2 arrow-through-node sweep (extract hardening F7a). Renders every .exd of a folder through the d2 engine with several
// edge orders, runs the checker on the neutral geometry, and reports each `arrow-through-node` with its case, order, edge
// and box, plus where the intrusion comes from: ELK's raw routes (straight out of compile()) or the adapter's later passes
// (spreadLanes / placeLabels / detour). Needs `npm run build` (reads dist/). No browser: compile + SVG are WASM only.
//
//   node scripts/qa/d2-sweep.mjs [--dir <folder of .exd>] [--shuffles N] [--orders as-is,by-from,by-to,reversed]
//                                [--only <substr>] [--json <file>]
//
// Exit 1 when any arrow-through-node survives in the final (adapter) geometry; raw ELK hits are reported, not failing.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DIR = join(ROOT, "out", "qa-extract-r3", "exd");
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);

function parseArgs(argv) {
  const o = { dir: DEFAULT_DIR, shuffles: 0, orders: ["as-is", "by-from", "by-to", "reversed"], only: undefined, json: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = argv[++i];
    else if (a === "--shuffles") o.shuffles = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--orders") o.orders = String(argv[++i]).split(",");
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--json") o.json = argv[++i];
    else {
      process.stdout.write(`error: unknown flag ${a}\nsuggestion: --dir <folder> --shuffles N --orders as-is,by-from,by-to,reversed --only <substr> --json <file>\n`);
      process.exit(2);
    }
  }
  return o;
}

/** Small seeded PRNG (mulberry32). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ORDERS = {
  "as-is": (e) => e,
  "by-from": (e) => [...e].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
  "by-to": (e) => [...e].sort((a, b) => cmp(a.to, b.to) || cmp(a.from, b.from)),
  reversed: (e) => [...e].reverse(),
};
function shuffled(edges, seed) {
  const r = rng(seed);
  const out = [...edges];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { parse } = await dist("dsl/parser.js");
  const { translateGraph } = await dist("engines/d2/translate.js");
  const { renderD2 } = await dist("engines/d2/render.js");
  const { diagramKind, diagramToNeutral } = await dist("engines/d2/geometry.js");
  const { d2Compile, D2_PAD, disposeD2 } = await dist("engines/d2/wasm.js");
  const { toScene } = await dist("engines/neutral.js");
  const { analyzeScene } = await dist("quality/analyze.js");

  /** arrow-through-node findings of a neutral scene as {edge, box, inside}. */
  const hitsOf = (neutral) => {
    const els = toScene(neutral);
    const a = analyzeScene({ elements: els });
    return a.findings
      .filter((f) => f.code === "arrow-through-node")
      .map((f) => {
        const idx = Number(/^edge-(\d+)$/.exec(f.elements[0])?.[1]);
        const e = neutral.edges[idx];
        const box = f.elements[1].replace(/^(?:node|zone)-/, "");
        const inside = /runs ([\d.]+) px/.exec(f.detail)?.[1];
        // which segment of the route is the offender: orientation, and whether it crosses the whole node ("through") or only enters it
        const nb = neutral.nodes.find((n) => n.id === box)?.box;
        let seg = "?";
        if (e && nb) {
          for (let i = 1; i < e.poly.length; i++) {
            const [a, b] = [e.poly[i - 1], e.poly[i]];
            const v = Math.abs(a[0] - b[0]) < 0.6;
            const h = Math.abs(a[1] - b[1]) < 0.6;
            const hitV = v && a[0] > nb.x && a[0] < nb.x + nb.w && Math.min(a[1], b[1]) < nb.y + nb.h && Math.max(a[1], b[1]) > nb.y;
            const hitH = h && a[1] > nb.y && a[1] < nb.y + nb.h && Math.min(a[0], b[0]) < nb.x + nb.w && Math.max(a[0], b[0]) > nb.x;
            if (hitV || hitH) {
              const full = hitV ? Math.min(a[1], b[1]) <= nb.y && Math.max(a[1], b[1]) >= nb.y + nb.h : Math.min(a[0], b[0]) <= nb.x && Math.max(a[0], b[0]) >= nb.x + nb.w;
              seg = `${hitV ? "v" : "h"}${full ? "-through" : "-enter"}${e.text ? "+label" : ""}`;
              break;
            }
          }
        }
        return { edge: e ? `${e.src} -> ${e.dst}` : f.elements[0], box, inside: Number(inside), seg };
      });
  };

  const files = readdirSync(o.dir).filter((f) => f.endsWith(".exd") && (!o.only || f.includes(o.only))).sort();
  const rows = [];
  let renders = 0;
  for (const file of files) {
    const text = readFileSync(join(o.dir, file), "utf8");
    const { graph, diagnostics } = parse(text);
    if (diagnostics.some((d) => d.severity === "error")) {
      process.stdout.write(`skip ${file}: parse errors\n`);
      continue;
    }
    const orders = o.orders.map((n) => [n, ORDERS[n]]);
    for (let s = 1; s <= o.shuffles; s++) orders.push([`shuffle-${s}`, (e) => shuffled(e, s * 7919 + file.length)]);
    for (const [name, fn] of orders) {
      if (!fn) throw new Error(`unknown order ${name}`);
      const g = { ...graph, edges: fn(graph.edges) };
      const source = translateGraph(g).source;
      const raw = await d2Compile(source, { layout: "elk", pad: D2_PAD });
      const rawHits = diagramKind(raw.diagram) === "graph" ? hitsOf(diagramToNeutral(raw.diagram).neutral) : [];
      const fin = await renderD2(source, {});
      renders++;
      const finHits = hitsOf(fin.neutral);
      const key = (h) => `${h.edge}|${h.box}`;
      const rawKeys = new Set(rawHits.map(key));
      const finKeys = new Set(finHits.map(key));
      for (const h of rawHits) rows.push({ case: file.replace(/\.exd$/, ""), order: name, ...h, where: finKeys.has(key(h)) ? "raw-elk (kept)" : "raw-elk (repaired by adapter)" });
      for (const h of finHits) if (!rawKeys.has(key(h))) rows.push({ case: file.replace(/\.exd$/, ""), order: name, ...h, where: "after-adapter (new)" });
    }
  }
  await disposeD2();

  const final = rows.filter((r) => r.where !== "raw-elk (repaired by adapter)");
  const rawN = rows.filter((r) => r.where.startsWith("raw-elk")).length;
  const lines = [
    `d2-sweep: ${final.length === 0 ? "pass" : "fail"}`,
    `cases: ${files.length}`,
    `renders: ${renders}`,
    `through-node-sweep: ${final.length}/${renders}`,
    `raw_elk_hits: ${rawN}`,
    `repaired_by_adapter: ${rows.filter((r) => r.where === "raw-elk (repaired by adapter)").length}`,
    `new_after_adapter: ${rows.filter((r) => r.where === "after-adapter (new)").length}`,
    `hits[${rows.length}]{case,order,edge,box,inside_px,seg,where}:`,
    ...rows.map((r) => `  ${r.case},${r.order},${r.edge},${r.box},${r.inside},${r.seg},${r.where}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
  if (o.json) writeFileSync(o.json, JSON.stringify({ renders, final: final.length, rows }, null, 2) + "\n");
  process.exit(final.length ? 1 : 0);
}

main().catch((err) => {
  process.stdout.write(`error: d2 sweep crashed: ${err.stack ?? err}\n`);
  process.exit(2);
});
