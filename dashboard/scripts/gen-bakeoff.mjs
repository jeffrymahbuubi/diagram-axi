// gen-bakeoff - turns the three-engine bake-off review (kit.config.json `bakeoff`) into Starlight pages + JSON.
// Usage: node scripts/gen-bakeoff.mjs   (run by `npm run gen:pages` after gen-pages.mjs; all output is git-ignored)
//   src/generated/bakeoff/{scenarios,summary}.json
//   src/content/docs/bakeoff/{index,scenarios}.mdx
//   public/bakeoff/<engine>/<scenario id>.png
// Without a `bakeoff` block (or without its verdicts.json) the bake-off pages are simply not generated.
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter } from './lib/markdown.mjs';
import { root } from './lib/config.mjs';
import { ENGINES, loadBakeoffConfig, buildScenarios, computeSummary, readJson } from './lib/bakeoff.mjs';

const docsOut = path.join(root, 'src', 'content', 'docs', 'bakeoff');
const genOut = path.join(root, 'src', 'generated', 'bakeoff');
const pngOut = path.join(root, 'public', 'bakeoff');
for (const d of [docsOut, genOut, pngOut]) fs.rmSync(d, { recursive: true, force: true });

const cfg = loadBakeoffConfig();
if (!cfg) { console.log('gen-bakeoff: no `bakeoff` block in kit.config.json; skipped'); process.exit(0); }
if (!fs.existsSync(cfg.verdictsFile) || !fs.existsSync(cfg.manifestFile)) {
  console.warn(`gen-bakeoff: warning: ${cfg.verdictsFile} or ${cfg.manifestFile} not found; bake-off pages skipped (set bakeoff.root in kit.config.local.json)`);
  process.exit(0);
}

const verdicts = readJson(cfg.verdictsFile);
const manifest = readJson(cfg.manifestFile);
const scenarios = buildScenarios(verdicts, manifest);
const summary = computeSummary(verdicts, scenarios);

let pngs = 0;
for (const m of manifest) {
  for (const e of ENGINES) {
    const src = m[e.id];
    if (!src || !fs.existsSync(src)) { console.warn(`gen-bakeoff: warning: missing PNG ${src}`); continue; }
    const dest = path.join(pngOut, e.id, `${m.id}.png`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    pngs++;
  }
}

fs.mkdirSync(genOut, { recursive: true });
fs.writeFileSync(path.join(genOut, 'scenarios.json'), `${JSON.stringify(scenarios)}\n`);
fs.writeFileSync(path.join(genOut, 'summary.json'), `${JSON.stringify({ ...summary, label: cfg.label })}\n`);
fs.mkdirSync(docsOut, { recursive: true });

fs.writeFileSync(
  path.join(docsOut, 'index.mdx'),
  `${frontmatter({
    title: cfg.label,
    description: `Three-engine vision review of ${summary.scenarios} scenarios: acceptance per engine and set, failure classes and the best engine per diagram kind.`,
    sidebar: { label: 'Summary', order: 1 },
    tableOfContents: false,
    pagefind: false,
  })}\nimport BakeoffSummary from '@components/BakeoffSummary.astro';\n\n<BakeoffSummary />\n`,
);
fs.writeFileSync(
  path.join(docsOut, 'scenarios.mdx'),
  `${frontmatter({
    title: `${cfg.label}: scenarios`,
    description: `${summary.scenarios} scenarios rendered by Excalidraw, D2 and Mermaid side by side, with reviewer verdicts. Filter by set, kind and best engine.`,
    sidebar: { label: 'Scenarios', order: 2 },
    tableOfContents: false,
    pagefind: false,
  })}\nimport BakeoffGrid from '@components/BakeoffGrid.tsx';\nimport scenarios from '@generated/bakeoff/scenarios.json';\n\n<BakeoffGrid client:visible scenarios={scenarios} />\n`,
);
console.log(`gen-bakeoff: ${scenarios.length} scenarios, ${verdicts.length} verdict rows, ${pngs} PNGs -> public/bakeoff/`);
