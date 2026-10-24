// make-fixtures - regenerates the SYNTHETIC per-engine review folders under test-fixtures/ (committed output).
// Usage: npm run fixtures:make     (needs `npm install`; uses sharp to rasterise tiny placeholder SVGs)
// Output, per engine e in excalidraw|d2|mermaid, shaped exactly like out/review-r5-<e>/ will be:
//   test-fixtures/review-r5-<e>/{all-verdicts.json,gallery-data.json,qa/*.png|svg,qa/report.json,fuzz/*.png|svg}
//   test-fixtures/fuzz-<e>-s3/report.json (+ s4 for excalidraw and d2; mermaid omits s4 on purpose so the
//   "missing fuzz report" warning path stays exercised)
// None of this is real QA data; the pictures say so. `npm run check:fixtures` reads these folders for any round
// whose real data folder does not exist yet.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { root } from './lib/config.mjs';

const OUT = path.join(root, 'test-fixtures');
const ENGINES = ['excalidraw', 'd2', 'mermaid'];
const COLORS = { excalidraw: '#e8e4ff', d2: '#dff3e4', mermaid: '#ffe9d6' };

// render: [name, dir, kind, rejected V-check or null, notes, hard checker codes]
const RENDERS = {
  excalidraw: [
    ['day-order-flow', 'DOWN', 'qa', null, 'no issues found', []],
    ['day-order-flow', 'RIGHT', 'qa', null, 'fixture: clean', []],
    ['edge-self-loop', 'DOWN', 'qa', 'V9', 'fixture: self-loop reads as a straight stub', ['self-loop-shape']],
    ['fuzz-label-clash', 'DOWN', 'qa', null, 'fixture: label clear of the arrow', []],
    ['dense-101', 'UP', 'fuzz', null, 'fixture: dense graph, readable', []],
    ['realistic-small-202', 'LEFT', 'fuzz', 'V7', 'fixture: arrow passes through a node', ['arrow-through-node']],
  ],
  d2: [
    ['day-order-flow', 'DOWN', 'qa', null, 'no issues found', []],
    ['day-order-flow', 'RIGHT', 'qa', 'V3', 'fixture: edge label sits on the neighbouring arrow', []],
    ['edge-self-loop', 'DOWN', 'qa', null, 'fixture: loop drawn', []],
    ['fuzz-label-clash', 'DOWN', 'qa', 'V4', 'fixture: two labels overlap', ['label-overlap']],
    ['dense-101', 'UP', 'fuzz', null, 'fixture: ok', []],
    ['realistic-small-202', 'LEFT', 'fuzz', null, 'fixture: ok', []],
  ],
  mermaid: [
    ['day-order-flow', 'DOWN', 'qa', null, 'no issues found', []],
    ['day-order-flow', 'RIGHT', 'qa', null, 'fixture: clean', []],
    ['edge-self-loop', 'DOWN', 'qa', 'V9', 'fixture: loop clipped by the node border', []],
    ['fuzz-label-clash', 'DOWN', 'qa', null, 'fixture: ok', []],
    ['dense-101', 'UP', 'fuzz', 'V1', 'fixture: arrow ends short of its node', ['arrow-detached']],
    ['realistic-small-202', 'LEFT', 'fuzz', null, 'fixture: ok', []],
  ],
};

// svg twin policy, so the optional-thumbnail path is covered both ways
const hasSvg = (engine, name, kind) =>
  engine === 'd2' || (engine === 'mermaid' && kind === 'qa') || (engine === 'excalidraw' && name.startsWith('day-'));

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 1)}\n`);
};

function svgFor(engine, name, dir, rejected) {
  const bg = COLORS[engine];
  const mark = rejected ? '#c0392b' : '#2e7d32';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
<rect width="480" height="300" fill="${bg}"/>
<rect x="40" y="60" width="120" height="50" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>
<rect x="320" y="60" width="120" height="50" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>
<rect x="180" y="190" width="120" height="50" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>
<path d="M160 85 H320 M100 110 L240 190 M380 110 L240 190" stroke="${mark}" stroke-width="3" fill="none"/>
<text x="240" y="30" font-size="18" font-family="sans-serif" text-anchor="middle" fill="#111">SYNTHETIC FIXTURE (${engine})</text>
<text x="240" y="280" font-size="14" font-family="sans-serif" text-anchor="middle" fill="#111">${name} ${dir}</text>
</svg>
`;
}

function fuzzReport(engine, seed) {
  const rows = RENDERS[engine].filter((r) => r[2] === 'fuzz');
  const cases = rows.map(([name, dir]) => {
    const m = /^(.*)-(\d+)$/.exec(name);
    return { case: `${m[1]}/${m[2]}`, dir, profile: m[1], seed: Number(m[2]) };
  });
  const findings = rows.flatMap(([name, dir, , , , codes]) => {
    const m = /^(.*)-(\d+)$/.exec(name);
    return codes.map((code) => ({ case: `${m[1]}/${m[2]}`, dir, code, severity: 'hard', elements: [], detail: 'synthetic fixture finding' }));
  });
  const profiles = [...new Set(cases.map((c) => c.profile))].map((profile) => {
    const mine = cases.filter((c) => c.profile === profile);
    const bad = findings.filter((f) => f.case.startsWith(`${profile}/`));
    const passed = mine.length - new Set(bad.map((f) => `${f.case}|${f.dir}`)).size;
    return { profile, renders: mine.length, passed, passRate: Math.round((passed / mine.length) * 1000) / 10, topCode: bad[0]?.code ?? '', gated: profile !== 'dense' };
  });
  const gated = profiles.filter((p) => p.gated);
  const gRenders = gated.reduce((a, p) => a + p.renders, 0);
  const gPassed = gated.reduce((a, p) => a + p.passed, 0);
  const codes = [...new Set(findings.map((f) => f.code))];
  return {
    summary: { engine, seed, renders: cases.length, hard: findings.length, gatedRenders: gRenders, gatedPassed: gPassed, gatedPassRate: gRenders ? Math.round((gPassed / gRenders) * 1000) / 10 : 0, reportOnly: ['dense'], synthetic: true },
    byCode: codes.map((code) => ({ code, severity: 'hard', count: findings.filter((f) => f.code === code).length, cases: 1 })),
    profiles, cases, findings,
  };
}

fs.rmSync(OUT, { recursive: true, force: true });
let pngs = 0;
let svgs = 0;
for (const engine of ENGINES) {
  const base = path.join(OUT, `review-r5-${engine}`);
  const verdicts = [];
  const gallery = [];
  const qaCases = [];
  const qaFindings = [];
  for (const [name, dir, kind, failV, notes, codes] of RENDERS[engine]) {
    const file = `${name}-${dir}`;
    const folder = path.join(base, kind);
    write(path.join(folder, `${file}.svg.tmp`), svgFor(engine, name, dir, Boolean(failV)));
    await sharp(path.join(folder, `${file}.svg.tmp`)).png().toFile(path.join(folder, `${file}.png`));
    pngs++;
    if (hasSvg(engine, name, kind)) { fs.renameSync(path.join(folder, `${file}.svg.tmp`), path.join(folder, `${file}.svg`)); svgs++; }
    else fs.rmSync(path.join(folder, `${file}.svg.tmp`));

    const v = {};
    for (let i = 1; i <= 9; i++) v[`V${i}`] = `V${i}` === failV ? 'fail' : [6, 9].includes(i) ? 'n/a' : 'pass';
    v.V10 = failV ? 'no' : 'yes';
    verdicts.push({ file: `out/review-r5-${engine}/${kind}/${file}.png`, ...v, notes });
    gallery.push({ src: `img/${kind}/${file}.png`, name, dir, cat: kind === 'fuzz' ? 'Held-out' : 'Realistic', ok: !failV, fails: failV ? [failV] : [], notes, checker: codes });
    if (kind === 'qa') {
      qaCases.push({ case: name, dir, exit: 0, hard: codes.length, soft: 0 });
      for (const code of codes) qaFindings.push({ case: name, dir, code, severity: 'hard', elements: [], detail: 'synthetic fixture finding' });
    }
  }
  write(path.join(base, 'all-verdicts.json'), verdicts);
  write(path.join(base, 'gallery-data.json'), gallery);
  write(path.join(base, 'qa', 'report.json'), { summary: { engine, synthetic: true }, rules: [], byCode: [], suites: [], cases: qaCases, findings: qaFindings });
  write(path.join(OUT, `fuzz-${engine}-s3`, 'report.json'), fuzzReport(engine, 3));
  if (engine !== 'mermaid') write(path.join(OUT, `fuzz-${engine}-s4`, 'report.json'), fuzzReport(engine, 4));
}
console.log(`make-fixtures: ${pngs} PNGs, ${svgs} SVGs under ${path.relative(root, OUT)}`);
