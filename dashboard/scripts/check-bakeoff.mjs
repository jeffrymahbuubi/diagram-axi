// check-bakeoff - parity and image checks for the three-engine bake-off pages (run last by `npm run check`).
// Re-reads verdicts.json / manifest.json itself and compares them with src/generated/bakeoff/*, public/bakeoff/*, dist/.
// Exit: 0 clean (or bake-off not configured), 1 errors.
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lib/config.mjs';
import { ENGINES, loadBakeoffConfig, readJson } from './lib/bakeoff.mjs';

const cfg = loadBakeoffConfig();
if (!cfg) { console.log('check-bakeoff: no bakeoff block in kit.config.json; skipped'); process.exit(0); }
if (!fs.existsSync(cfg.verdictsFile)) { console.log(`check-bakeoff: ${cfg.verdictsFile} not found; skipped`); process.exit(0); }

const errors = [];
const err = (msg) => errors.push(msg);
const verdicts = readJson(cfg.verdictsFile);
const manifest = readJson(cfg.manifestFile);
const gen = path.join(root, 'src', 'generated', 'bakeoff');
const dist = path.join(root, 'dist');

if (!fs.existsSync(path.join(gen, 'scenarios.json'))) { console.error('check-bakeoff: run `npm run gen:pages` first'); process.exit(1); }
const scenarios = readJson(path.join(gen, 'scenarios.json'));
const summary = readJson(path.join(gen, 'summary.json'));

if (verdicts.length !== manifest.length * ENGINES.length) err(`${verdicts.length} verdict rows != ${manifest.length} scenarios x ${ENGINES.length} engines`);
if (scenarios.length !== manifest.length) err(`${scenarios.length} generated scenarios != ${manifest.length} in the manifest`);

let pngs = 0;
for (const s of scenarios) {
  for (const e of ENGINES) {
    const v = s.engines[e.id];
    if (!v) { err(`${s.id}: no ${e.id} verdict`); continue; }
    const src = verdicts.find((r) => r.id === s.id && r.engine === e.id);
    if (!src) { err(`${s.id}|${e.id}: not in verdicts.json`); continue; }
    if (v.accepted !== (src.V10 === 'yes')) err(`${s.id}|${e.id}: accepted flag disagrees with V10`);
    const wantFails = Array.from({ length: 9 }, (_, i) => `V${i + 1}`).filter((k) => src[k] === 'fail');
    if (wantFails.join() !== v.fails.join()) err(`${s.id}|${e.id}: fails ${v.fails} != source ${wantFails}`);
    const pub = path.join(root, 'public', v.png);
    if (!fs.existsSync(pub) || fs.statSync(pub).size === 0) err(`${s.id}|${e.id}: PNG missing or empty at ${v.png}`);
    else pngs++;
    if (fs.existsSync(dist) && !fs.existsSync(path.join(dist, v.png))) err(`${s.id}|${e.id}: PNG not in dist/ (${v.png})`);
  }
  if (!s.best) err(`${s.id}: no best-engine verdict`);
}

// summary parity, recomputed from the source rows
for (const e of ENGINES) {
  const rows = verdicts.filter((r) => r.engine === e.id);
  const acc = rows.filter((r) => r.V10 === 'yes').length;
  const got = summary.engines[e.id];
  if (!got || got.n !== rows.length || got.accepted !== acc) err(`summary ${e.id}: ${got?.accepted}/${got?.n} != ${acc}/${rows.length} in the source`);
}
const bestCount = scenarios.filter((s) => s.best === 'tie').length;
if (summary.wins.tie !== bestCount) err(`summary ties ${summary.wins.tie} != ${bestCount}`);
const winSum = Object.values(summary.wins).reduce((a, b) => a + b, 0);
if (winSum !== scenarios.length) err(`best-engine counts sum to ${winSum}, not ${scenarios.length}`);
if (fs.existsSync(cfg.summaryFile)) {
  const src = readJson(cfg.summaryFile);
  for (const e of ENGINES) if (src.engines?.[e.id]?.accepted !== summary.engines[e.id].accepted) err(`summary.json (source) disagrees with the dashboard for ${e.id}`);
}

for (const page of ['index', 'scenarios']) {
  if (!fs.existsSync(path.join(root, 'src', 'content', 'docs', 'bakeoff', `${page}.mdx`))) err(`page bakeoff/${page}.mdx not generated`);
  if (fs.existsSync(dist) && !fs.existsSync(path.join(dist, 'bakeoff', page === 'index' ? '' : page, 'index.html'))) err(`page bakeoff/${page} not built`);
}
if (fs.existsSync(dist)) {
  const html = fs.readFileSync(path.join(dist, 'bakeoff', 'scenarios', 'index.html'), 'utf8');
  for (const m of html.matchAll(/bakeoff\/(?:excalidraw|d2|mermaid)\/[\w.-]+\.png/g)) {
    if (!fs.existsSync(path.join(dist, m[0]))) err(`scenarios page references missing image ${m[0]}`);
  }
}

for (const e of errors) console.error(`ERROR ${e}`);
console.log(`check-bakeoff: ${errors.length ? 'FAIL' : 'OK'} - ${scenarios.length} scenarios, ${verdicts.length} verdict rows, ${pngs} PNGs, ${errors.length} errors`);
process.exitCode = errors.length ? 1 : 0;
