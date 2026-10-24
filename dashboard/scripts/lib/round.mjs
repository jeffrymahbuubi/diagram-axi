// Turns one round's QA artefacts into row objects (one per rendered PNG) plus lookup data.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const V_CHECKS = [
  { id: 'V1', short: 'Arrow ends', meaning: 'Arrow starts/ends on its nodes' },
  { id: 'V2', short: 'Arrowhead', meaning: 'Arrowhead visible' },
  { id: 'V3', short: 'Edge label', meaning: 'Edge label readable and on its own arrow' },
  { id: 'V4', short: 'Text overlap', meaning: 'No text over text' },
  { id: 'V5', short: 'Label fit', meaning: 'Node label fits its shape' },
  { id: 'V6', short: 'Zones', meaning: 'Zones enclose members and titles are readable' },
  { id: 'V7', short: 'Through node', meaning: 'No arrow passes through a node' },
  { id: 'V8', short: 'Parallel edges', meaning: 'Parallel and reciprocal edges are distinguishable' },
  { id: 'V9', short: 'Self-loops', meaning: 'Self-loops look like loops' },
  { id: 'V10', short: 'Accept', meaning: 'A human would accept the render as-is' },
];
export const DIRS = ['DOWN', 'UP', 'LEFT', 'RIGHT'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// NATIVE: an engine's own diagram type (d2/mermaid class, erd, sequence) drawn without a layout direction
const FILE_RE = /^(.*)-(DOWN|UP|LEFT|RIGHT|NATIVE)\.png$/;
const norm = (v) => (v === 'n/a' ? 'n-a' : v);

/** Index a fuzz or QA report: findings by `case|dir`, case rows by `case|dir`. */
function indexReport(file) {
  if (!file || !fs.existsSync(file)) return null;
  const rep = readJson(file);
  const cases = new Map();
  for (const c of rep.cases ?? []) cases.set(`${c.case}|${c.dir}`, c);
  const findings = new Map();
  for (const f of rep.findings ?? []) {
    const k = `${f.case}|${f.dir}`;
    if (!findings.has(k)) findings.set(k, []);
    findings.get(k).push(f);
  }
  return { rep, cases, findings, dir: path.dirname(file) };
}

export async function loadAnalyzer(analyzerFile, warn) {
  if (!analyzerFile || !fs.existsSync(analyzerFile)) {
    warn(`analyzer ${analyzerFile ?? '(none)'} not found; new SOFT visual-rule codes are skipped`);
    return null;
  }
  try {
    const mod = await import(pathToFileURL(analyzerFile).href);
    return typeof mod.analyzeScene === 'function' ? mod.analyzeScene : null;
  } catch (e) {
    warn(`analyzer failed to load (${e.message}); new SOFT visual-rule codes are skipped`);
    return null;
  }
}

/**
 * Set of a render: first config set whose dir matches, whose prefix the case name starts with and, when the set
 * names a direction (e.g. "NATIVE"), whose layout direction is that one.
 */
function classify(sets, srcDir, name, dir) {
  return sets.find((s) => s.dir === srcDir && name.startsWith(s.prefix ?? '') && (s.direction == null || s.direction === dir))?.id ?? null;
}

/**
 * Build every row of a round. Returns { rows, notes } where notes are generator warnings.
 * Row: { id, round, engine, set, name, dir, png, svg, v, fails, accepted, notes, checker, visual, softLegacy }
 *  - engine: the round's engine (excalidraw|d2|mermaid) or null for rounds without an `engine` field
 *  - svg: path of a vector twin next to the PNG (same name, .svg) used for thumbnails, or null
 *  - checker: HARD codes from the matching report, or null when no report covers this render
 *  - visual: [{code, detail}] new SOFT visual-rule findings, or null when the scene was not analysed
 *  - softLegacy: other soft codes the original report recorded (aspect-ratio, arrow-crossings, ...)
 */
export async function buildRows(round, cfg, analyze, warn) {
  const verdicts = readJson(round.verdictsFile);
  const gallery = round.galleryFile && fs.existsSync(round.galleryFile) ? readJson(round.galleryFile) : [];
  const galleryBy = new Map(gallery.map((g) => [path.basename(g.src), g]));
  const qa = indexReport(round.qaReportFile);
  const fuzz = round.fuzzReports.map((f) => ({ ...f, idx: indexReport(f.file) })).filter((f) => f.idx);
  for (const f of round.fuzzReports) if (!fs.existsSync(f.file)) warn(`${round.id}: fuzz report ${f.file} not found`);
  const visualSet = new Set(cfg.kit.visualRules ?? []);
  const rows = [];

  for (const r of verdicts) {
    const base = path.basename(r.file.replace(/\\/g, '/'));
    const m = FILE_RE.exec(base);
    if (!m) { warn(`${round.id}: cannot parse render name ${base}`); continue; }
    const name = m[1];
    const dir = m[2];
    const parent = path.basename(path.dirname(r.file.replace(/\\/g, '/')));
    const srcDir = parent === path.basename(round.fuzzPath) ? 'fuzz' : 'qa';
    const set = classify(cfg.kit.sets, srcDir, name, dir);
    if (!set) { warn(`${round.id}: ${base} matches no set in kit.config.json`); continue; }
    const absPng = path.join(srcDir === 'fuzz' ? round.fuzzPath : round.qaPath, base);
    const absSvg = absPng.replace(/\.png$/, '.svg');
    const hasSvg = fs.existsSync(absSvg);

    const v = {};
    for (let i = 1; i <= 10; i++) v[`V${i}`] = norm(r[`V${i}`] ?? 'n-a');
    const fails = V_CHECKS.slice(0, 9).filter((c) => v[c.id] === 'fail').map((c) => c.id);

    // which report covers this render, and which scene file belongs to it
    let findings = null;
    let scenePath = null;
    if (srcDir === 'qa') {
      scenePath = path.join(round.qaPath, `${name}-${dir}.excalidraw`);
      if (qa?.cases.has(`${name}|${dir}`)) findings = qa.findings.get(`${name}|${dir}`) ?? [];
    } else {
      const mm = /^(.*)-(\d+)$/.exec(name);
      if (mm) {
        const key = `${mm[1]}/${mm[2]}|${dir}`;
        for (const f of fuzz) {
          if (f.idx.cases.has(key)) {
            findings = f.idx.findings.get(key) ?? [];
            scenePath = path.join(f.idx.dir, mm[1], `${mm[2]}-${dir}.excalidraw`);
            break;
          }
        }
      }
    }
    const galleryRow = galleryBy.get(base);
    const hard = new Set([...(galleryRow?.checker ?? []), ...(findings ?? []).filter((f) => f.severity === 'hard').map((f) => f.code)]);
    const checker = findings || galleryRow ? [...hard].sort() : null;
    const softLegacy = [...new Set((findings ?? []).filter((f) => f.severity === 'soft' && !visualSet.has(f.code)).map((f) => f.code))].sort();

    let visual = null;
    if (analyze && scenePath && fs.existsSync(scenePath)) {
      try {
        const res = analyze(readJson(scenePath));
        visual = res.findings.filter((f) => visualSet.has(f.code)).map((f) => ({ code: f.code, detail: f.detail }));
      } catch (e) {
        warn(`${round.id}: analyzer failed on ${path.basename(scenePath)} (${e.message})`);
      }
    }

    rows.push({
      id: `${name}-${dir}`,
      round: round.id,
      engine: round.engine,
      set,
      name,
      dir,
      png: `review/${round.id}/${srcDir}/${base}`,
      absPng,
      absSvg: hasSvg ? absSvg : null,
      svg: hasSvg ? `review/${round.id}/${srcDir}/${path.basename(absSvg)}` : null,
      v,
      fails,
      accepted: v.V10 === 'yes',
      notes: String(r.notes ?? '').trim(),
      checker,
      visual,
      softLegacy,
    });
  }
  rows.sort((a, b) => (a.name === b.name ? DIRS.indexOf(a.dir) - DIRS.indexOf(b.dir) : a.name < b.name ? -1 : 1));
  return rows;
}
