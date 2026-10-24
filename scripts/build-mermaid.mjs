// Bundles mermaid (pinned, see package.json) and its ELK layout loader into one browser IIFE,
// dist/render/mermaid-elk.iife.js, loaded by src/engines/mermaid/page.ts into its own browser page
// (KTD3). The bundle is a build artefact (dist/ is git-ignored). `window.mermaid` is the only global.
// ELK (elkjs, EPL-2.0) is bundled inside it: see NOTICE.
//
// The file is written to a pid-suffixed temp name and renamed, so parallel builds (two test files that
// each build a missing bundle) never leave a half-written bundle behind.
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outfile = fileURLToPath(new URL("../dist/render/mermaid-elk.iife.js", import.meta.url));

const ENTRY = `
import mermaid from "mermaid";
import elk from "@mermaid-js/layout-elk";
import ELK from "elkjs/lib/elk.bundled.js";
// Mermaid builds the ELK graph itself and exposes only a few options. window.__axiElk (set per render by
// src/engines/mermaid/inpage.ts) adds ELK layoutOptions: root to the root graph, group to every subgraph and node
// to every plain node. ELK reads some options (spacing.nodeSelfLoop) from the parent of the nodes concerned and
// others (ports) from the node itself, so each level has to be able to carry them.
const layout = ELK.prototype.layout;
const decorate = (parent, extra) => {
  for (const c of parent.children ?? []) {
    const group = c.children?.length || c.isGroup;
    c.layoutOptions = { ...c.layoutOptions, ...(group ? extra.group : extra.node) };
    if (group) decorate(c, extra);
  }
};
ELK.prototype.layout = function (graph, ...rest) {
  const extra = window.__axiElk;
  if (extra) {
    graph.layoutOptions = { ...graph.layoutOptions, ...extra.root };
    decorate(graph, extra);
  }
  return layout.call(this, graph, ...rest);
};
mermaid.registerLayoutLoaders(elk);
window.mermaid = mermaid;
`;

// Exact-text patches of the pinned mermaid (it ships its rendering code twice: in mermaid and in layout-elk, which
// renders the ELK diagrams). The build fails when one no longer applies. Each is a no-op until the page sets its global.
//  - window.__axiNodeMin[id] = {w, h} (set per render by inpage.ts) is a minimum label box: labelHelper reports at
//    least that size, so the shape grows around its still-centred label and ELK lays out the larger node (more room
//    along a side for the ends of many edges).
//  - the title of a subgraph sits 4 px lower (its label box starts up to 1.2 px above the frame otherwise).
//  - window.__axiTitleAt[subgraphId] = [x, y] moves the title of that subgraph (the translate of its label) from the middle of
//    its frame to where titles.ts says; the frame and the layout do not change.
const PATCHES = [
  {
    from: `labelEl.insert("rect", ":first-child");
  return { shapeSvg, bbox, halfPadding, label: labelEl };`,
    to: `labelEl.insert("rect", ":first-child");
  const min = globalThis.__axiNodeMin?.[node.id];
  if (min) bbox = { x: bbox.x, y: bbox.y, width: Math.max(bbox.width, min.w ?? 0), height: Math.max(bbox.height, min.h ?? 0) };
  return { shapeSvg, bbox, halfPadding, label: labelEl };`,
    times: 2,
  },
  {
    from: "translate(${node.x - bbox.width / 2}, ${node.y - node.height / 2 + subGraphTitleTopMargin})",
    to: "translate(${globalThis.__axiTitleAt?.[node.id]?.[0] ?? node.x - bbox.width / 2}, ${globalThis.__axiTitleAt?.[node.id]?.[1] ?? node.y - node.height / 2 + subGraphTitleTopMargin + 4})",
    times: 6,
  },
  {
    // window.__axiLabelAt[edgeId] = [x, y] is the translate an edge label is drawn at instead of where ELK put it (labels.ts)
    from: 'el.attr("transform", `translate(${x2}, ${y3 + subGraphTitleTotalMargin / 2})`);',
    to: 'const at = globalThis.__axiLabelAt?.[edge.id];\n    el.attr("transform", at ? `translate(${at[0]}, ${at[1]})` : `translate(${x2}, ${y3 + subGraphTitleTotalMargin / 2})`);',
    times: 1, // only layout-elk has this function
  },
  {
    // a frame as wide as its title was 2-10 px narrower than the title's drawn box
    from: "const width = node.width <= bbox.width + node.padding ? bbox.width + node.padding : node.width;",
    to: "const width = node.width <= bbox.width + node.padding + 14 ? bbox.width + node.padding + 14 : node.width;",
    times: 6,
  },
];
const applied = new Map(PATCHES.map((p) => [p, 0]));
const patchMermaid = {
  name: "axi-patch-mermaid",
  setup(b) {
    b.onLoad({ filter: /(mermaid[\\/]dist[\\/]chunks[\\/]mermaid\.core[\\/]chunk-|layout-elk[\\/]dist[\\/]chunks[\\/]mermaid-layout-elk\.core[\\/]elk-)[^\\/]+\.mjs$/ }, async ({ path }) => {
      let text = await readFile(path, "utf8");
      let changed = false;
      for (const p of PATCHES) {
        const parts = text.split(p.from);
        if (parts.length === 1) continue;
        applied.set(p, applied.get(p) + parts.length - 1);
        text = parts.join(p.to);
        changed = true;
      }
      return changed ? { contents: text, loader: "js" } : undefined;
    });
  },
};

await mkdir(new URL("../dist/render/", import.meta.url), { recursive: true });
const { outputFiles } = await build({
  stdin: { contents: ENTRY, resolveDir: root, sourcefile: "mermaid-entry.js", loader: "js" },
  outfile,
  write: false,
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [patchMermaid],
});
for (const [p, n] of applied) if (n !== p.times) throw new Error(`mermaid patch applied ${n} times (expected ${p.times}): the pinned mermaid changed`);
const temp = `${outfile}.${process.pid}.tmp`;
try {
  await writeFile(temp, outputFiles[0].contents);
  await rename(temp, outfile);
} finally {
  await rm(temp, { force: true });
}
const { size } = await stat(outfile);
console.log(`wrote dist/render/mermaid-elk.iife.js (${(size / 1048576).toFixed(1)} MB)`);
