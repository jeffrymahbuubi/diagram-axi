// bakeoff-aggregate - merges the reviewer packets (verdicts-0N.json) into verdicts.json, summary.json and summary.md.
// Usage: node scripts/bakeoff-aggregate.mjs [<bakeoff root dir>]   (default: bakeoff.root from kit.config(.local).json)
// Packet shape: { packet, rows: [{id, engine, V1..V10, classes[], notes}], best: [{id, best, why}] }.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINES, CLASSES, V_IDS, loadBakeoffConfig, buildScenarios, computeSummary, summaryMarkdown, readJson } from './lib/bakeoff.mjs';
import { resolveFromRoot } from './lib/config.mjs';

const cfg = loadBakeoffConfig();
const dir = process.argv[2] ? resolveFromRoot(process.argv[2]) : cfg?.rootDir;
if (!dir) { console.error('bakeoff-aggregate: no root dir (pass one or configure bakeoff in kit.config.json)'); process.exit(2); }

const manifest = readJson(path.join(dir, 'manifest.json'));
const mById = new Map(manifest.map((m) => [m.id, m]));
const packets = fs.readdirSync(dir).filter((f) => /^verdicts-\d+\.json$/.test(f)).sort().map((f) => readJson(path.join(dir, f)));
const best = new Map(packets.flatMap((p) => p.best ?? []).map((b) => [b.id, b]));

const problems = [];
const norm = (v) => (v === 'n/a' ? 'n-a' : v);
const rows = [];
const seen = new Set();
for (const p of packets) {
  for (const r of p.rows ?? []) {
    const m = mById.get(r.id);
    if (!m) { problems.push(`unknown scenario ${r.id}`); continue; }
    if (!ENGINES.some((e) => e.id === r.engine)) { problems.push(`${r.id}: bad engine ${r.engine}`); continue; }
    const key = `${r.id}|${r.engine}`;
    if (seen.has(key)) { problems.push(`duplicate ${key}`); continue; }
    seen.add(key);
    const row = { id: r.id, case: m.case, set: m.set, dir: m.dir, kind: m.kind, engine: r.engine };
    for (const k of V_IDS) row[k] = norm(r[k]);
    row.V10 = r.V10 === 'yes' ? 'yes' : 'no';
    row.classes = (r.classes ?? []).map((c) => (CLASSES.includes(c) ? c : (problems.push(`${key}: class ${c} -> other`), 'other')));
    if (row.V10 === 'no' && row.classes.length === 0) problems.push(`${key}: V10 no without a class`);
    row.notes = String(r.notes ?? '');
    const b = best.get(r.id);
    row.best = b?.best ?? null;
    row.bestWhy = b?.why ?? '';
    rows.push(row);
  }
}
for (const m of manifest) for (const e of ENGINES) if (!seen.has(`${m.id}|${e.id}`)) problems.push(`missing ${m.id}|${e.id}`);
for (const m of manifest) if (!best.has(m.id)) problems.push(`missing best for ${m.id}`);

const order = new Map(manifest.map((m, i) => [m.id, i]));
rows.sort((a, b) => order.get(a.id) - order.get(b.id) || ENGINES.findIndex((e) => e.id === a.engine) - ENGINES.findIndex((e) => e.id === b.engine));
const scenarios = buildScenarios(rows, manifest);
const summary = computeSummary(rows, scenarios);

fs.writeFileSync(path.join(dir, 'verdicts.json'), `${JSON.stringify(rows, null, 1)}\n`);
fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
fs.writeFileSync(path.join(dir, 'summary.md'), summaryMarkdown(summary));
for (const p of problems) console.warn(`bakeoff-aggregate: ${p}`);
console.log(`bakeoff-aggregate: ${rows.length} rows, ${scenarios.length} scenarios, ${problems.length} problems -> ${dir}`);
process.exitCode = problems.length ? 1 : 0;
