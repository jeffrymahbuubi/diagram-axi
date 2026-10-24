// Shared helpers for the three-engine bake-off review (gen-bakeoff, check-bakeoff, bakeoff-aggregate).
// Source data: <bakeoff.root>/verdicts.json (one row per scenario x engine) and <bakeoff.root>/manifest.json
// (one entry per scenario: id, case, set, dir, kind, image paths).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveFromRoot } from './config.mjs';

export const ENGINES = [
  { id: 'excalidraw', label: 'Excalidraw (ours)' },
  { id: 'd2', label: 'D2 elk' },
  { id: 'mermaid', label: 'Mermaid' },
];
export const SETS = [
  { id: 'realistic', label: 'Realistic' },
  { id: 'edge', label: 'Edge' },
  { id: 'fuzz', label: 'Fuzz' },
];
export const CLASSES = [
  'arrow-through-node', 'arrow-detached', 'hidden-arrowhead', 'label-misplaced', 'label-overlap', 'text-overflow-node',
  'zone-wrong', 'parallel-indistinct', 'self-loop-bad', 'illegible-small', 'spaghetti', 'missing-content', 'wasted-space',
  'direction-ignored', 'other',
];
export const V_IDS = Array.from({ length: 9 }, (_, i) => `V${i + 1}`);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Resolved bake-off config, or null when kit.config(.local).json has no `bakeoff` block. */
export function loadBakeoffConfig() {
  const { kit } = loadConfig();
  const b = kit.bakeoff;
  if (!b) return null;
  const rootDir = resolveFromRoot(b.root);
  return {
    label: b.label ?? 'Engine bake-off',
    rootDir,
    verdictsFile: path.resolve(rootDir, b.verdicts ?? 'verdicts.json'),
    manifestFile: path.resolve(rootDir, b.manifest ?? 'manifest.json'),
    summaryFile: path.resolve(rootDir, b.summary ?? 'summary.json'),
  };
}

/** Group verdict rows into one scenario object per id (engines keyed by engine id), preserving manifest order. */
export function buildScenarios(verdicts, manifest) {
  const byId = new Map();
  for (const m of manifest) byId.set(m.id, { id: m.id, name: m.case, set: m.set, dir: m.dir, kind: m.kind, best: null, why: '', engines: {} });
  for (const v of verdicts) {
    const s = byId.get(v.id);
    if (!s) continue;
    const fails = V_IDS.filter((k) => v[k] === 'fail');
    s.engines[v.engine] = {
      png: `bakeoff/${v.engine}/${v.id}.png`,
      v: Object.fromEntries([...V_IDS, 'V10'].map((k) => [k, v[k]])),
      fails,
      accepted: v.V10 === 'yes',
      classes: v.classes ?? [],
      notes: v.notes ?? '',
    };
    if (v.best) { s.best = v.best; s.why = v.bestWhy ?? ''; }
  }
  return [...byId.values()];
}

const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

/** All aggregates the dashboard and summary.json show, computed from verdict rows + scenarios. */
export function computeSummary(verdicts, scenarios) {
  const engines = {};
  for (const e of ENGINES) {
    const rows = verdicts.filter((v) => v.engine === e.id);
    const sets = {};
    for (const s of SETS) {
      const sr = rows.filter((v) => v.set === s.id);
      const acc = sr.filter((v) => v.V10 === 'yes').length;
      sets[s.id] = { n: sr.length, accepted: acc, pct: pct(acc, sr.length) };
    }
    const acc = rows.filter((v) => v.V10 === 'yes').length;
    const fails = {};
    for (const k of V_IDS) fails[k] = rows.filter((v) => v[k] === 'fail').length;
    const classes = {};
    for (const v of rows) for (const c of new Set(v.classes ?? [])) bump(classes, c);
    const rejectedClasses = {};
    for (const v of rows.filter((x) => x.V10 === 'no')) for (const c of new Set(v.classes ?? [])) bump(rejectedClasses, c);
    engines[e.id] = { label: e.label, n: rows.length, accepted: acc, pct: pct(acc, rows.length), sets, fails, classes, rejectedClasses };
  }
  const kinds = {};
  for (const s of scenarios) {
    const k = (kinds[s.kind] ??= { scenarios: 0, wins: { excalidraw: 0, d2: 0, mermaid: 0 }, tie: 0, none: 0, accepted: { excalidraw: 0, d2: 0, mermaid: 0 } });
    k.scenarios++;
    if (s.best === 'tie') k.tie++;
    else if (s.best === 'none') k.none++;
    else if (s.best && k.wins[s.best] !== undefined) k.wins[s.best]++;
    for (const e of ENGINES) if (s.engines[e.id]?.accepted) k.accepted[e.id]++;
  }
  for (const k of Object.values(kinds)) {
    const top = Math.max(...Object.values(k.wins));
    const leaders = Object.entries(k.wins).filter(([, n]) => n === top).map(([id]) => id);
    k.winner = top === 0 ? (k.tie >= k.none ? 'tie' : 'none') : leaders.length === 1 ? leaders[0] : leaders.join('+');
  }
  const wins = { excalidraw: 0, d2: 0, mermaid: 0, tie: 0, none: 0 };
  for (const s of scenarios) if (s.best) bump(wins, s.best);
  const allAccepted = scenarios.filter((s) => ENGINES.every((e) => s.engines[e.id]?.accepted)).length;
  const noneAccepted = scenarios.filter((s) => ENGINES.every((e) => s.engines[e.id] && !s.engines[e.id].accepted)).length;
  return { scenarios: scenarios.length, renders: verdicts.length, engines, kinds, wins, allAccepted, noneAccepted };
}

/** Markdown summary used by bakeoff-aggregate. */
export function summaryMarkdown(sum) {
  const E = ENGINES;
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const out = ['# Three-engine bake-off review', '', `${sum.scenarios} scenarios x 3 engines = ${sum.renders} renders reviewed against V1-V10.`, ''];
  out.push('## Acceptance (V10 = yes)', '', row(['Set', ...E.map((e) => e.label)]), row(['---', ...E.map(() => '---:')]));
  for (const s of [...SETS, { id: 'all', label: 'All' }]) {
    out.push(row([s.label, ...E.map((e) => {
      const x = s.id === 'all' ? sum.engines[e.id] : sum.engines[e.id].sets[s.id];
      return `${x.accepted}/${x.n} (${x.pct}%)`;
    })]));
  }
  out.push('', `Accepted by all three: ${sum.allAccepted}; rejected by all three: ${sum.noneAccepted}.`, '', '## Top failure classes (renders affected)', '');
  for (const e of E) {
    const top = Object.entries(sum.engines[e.id].classes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} ${n}`).join(', ');
    out.push(`- ${e.label}: ${top || 'none'}`);
  }
  out.push('', '## Best engine per scenario', '', `Excalidraw ${sum.wins.excalidraw}, D2 ${sum.wins.d2}, Mermaid ${sum.wins.mermaid}, tie ${sum.wins.tie}, none ${sum.wins.none}.`, '');
  out.push(row(['Kind', 'Scenarios', 'Excalidraw wins', 'D2 wins', 'Mermaid wins', 'Tie', 'None', 'Winner']), row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---']));
  for (const [k, v] of Object.entries(sum.kinds).sort()) out.push(row([k, v.scenarios, v.wins.excalidraw, v.wins.d2, v.wins.mermaid, v.tie, v.none, v.winner]));
  return `${out.join('\n')}\n`;
}

export { readJson };
