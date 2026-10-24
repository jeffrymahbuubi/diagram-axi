// check-dashboard - data parity, image, link, page and source-hygiene checks for the QA dashboard.
// Usage: node scripts/check-dashboard.mjs   (run last by `npm run check`; needs gen:pages and astro build to have run)
// Exit: 0 clean, 1 errors, 2 usage/IO error.
//
// It re-reads the source JSON itself (not through the generator) and compares:
//   * every verdict row has a generated row, a PNG in public/review/ (and dist/review/ once built)
//   * per set and per V-check counts in src/generated/{stats,<round>/<set>}.json equal the source counts
//   * a page exists for every round x set, and its row JSON has the right length
//   * no broken <img>/<a> targets inside dist/ (when built); fuzz profile counts equal the fuzz reports
//   * engine rounds: stats carry the round's engine; every svg twin of a row exists in public/ and dist/
//   * a configured round with no data (or a missing fuzz report) is a warning, not an error; zero loadable rounds is an error
// Escape hatch for a single source line: append `lint-ok` in a comment on that line.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, root, posix } from './lib/config.mjs';
import { parseFrontmatter } from './lib/markdown.mjs';

const cfg = loadConfig();
const srcDir = path.join(root, 'src');
const docsDir = path.join(srcDir, 'content', 'docs');
const genDir = path.join(srcDir, 'generated');
const distDir = path.join(root, 'dist');
const rel = (p) => posix(path.relative(root, p));

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);

const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
function walk(dir, filter = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

if (!fs.existsSync(path.join(genDir, 'stats.json'))) { console.error('check-dashboard: run `npm run gen:pages` first'); process.exit(2); }
const stats = readJson(path.join(genDir, 'stats.json'));
const meta = readJson(path.join(genDir, 'meta.json'));
const statsBy = new Map(stats.map((s) => [s.id, s]));
const FILE_RE = /^(.*)-(DOWN|UP|LEFT|RIGHT|NATIVE)\.png$/;
const setRowTotals = new Map();
const V_IDS = Array.from({ length: 9 }, (_, i) => `V${i + 1}`);
let rowsChecked = 0;
let pngsChecked = 0;
let svgsChecked = 0;

// ---- per round: source parity ----------------------------------------------
for (const sk of cfg.skipped) warn(sk.id, `no data at ${sk.file}; round skipped`);
if (!cfg.rounds.length) err('kit.config.json', 'no round has data (see README: kit.config.local.json or check:fixtures)');
for (const round of cfg.rounds) {
  const tag = round.id;
  if (!fs.existsSync(round.verdictsFile)) { err(tag, `source ${round.verdictsFile} not found`); continue; }
  const source = readJson(round.verdictsFile);
  const st = statsBy.get(round.id);
  if (!st) { err(tag, 'no entry in src/generated/stats.json'); continue; }

  if ((st.engine ?? null) !== (round.engine ?? null)) err(tag, `stats.engine ${st.engine} != configured engine ${round.engine}`);
  if (Boolean(st.fixture) !== Boolean(round.fixture)) err(tag, 'stats.fixture differs from the config');
  if (round.fixture) warn(tag, 'SYNTHETIC fixture data, not a real QA round');
  if (st.total !== source.length) err(tag, `stats.total ${st.total} != ${source.length} source rows`);
  const srcAccepted = source.filter((r) => r.V10 === 'yes').length;
  if (st.accepted !== srcAccepted) err(tag, `stats.accepted ${st.accepted} != ${srcAccepted} V10=yes rows in the source`);
  for (const id of V_IDS) {
    const n = source.filter((r) => r[id] === 'fail').length;
    if ((st.fails[id] ?? 0) !== n) err(tag, `${id} fail count ${st.fails[id]} != ${n} in the source`);
  }
  if (round.galleryFile && fs.existsSync(round.galleryFile)) {
    const g = readJson(round.galleryFile);
    if (g.length !== source.length) err(tag, `gallery-data.json has ${g.length} rows, all-verdicts.json ${source.length}`);
  }

  // generated rows
  const rows = [];
  let setSum = 0;
  for (const set of cfg.kit.sets) {
    const rowsFile = path.join(genDir, round.id, `${set.id}.json`);
    const page = path.join(docsDir, 'review', round.id, `${set.id}.mdx`);
    if (!fs.existsSync(rowsFile)) { err(rel(rowsFile), 'rows JSON not generated'); continue; }
    if (!fs.existsSync(page)) err(rel(page), 'page not generated');
    const setRows = readJson(rowsFile);
    rows.push(...setRows);
    setSum += setRows.length;
    const ss = st.sets.find((s) => s.id === set.id);
    if (!ss || ss.n !== setRows.length) err(rel(rowsFile), `${setRows.length} rows but stats say ${ss?.n}`);
    // a set may be empty in a round (native renders exist only for d2/mermaid); it must have rows in some round
    setRowTotals.set(set.id, (setRowTotals.get(set.id) ?? 0) + setRows.length);
    if (ss && ss.accepted !== setRows.filter((r) => r.accepted).length) err(rel(rowsFile), 'accepted count differs from stats');
  }
  if (setSum !== source.length) err(tag, `sets hold ${setSum} rows, source has ${source.length} (unclassified rows?)`);

  // every source row has a generated row, with a PNG that exists
  const byFile = new Map(rows.map((r) => [path.basename(r.png), r]));
  const ids = new Set();
  for (const s of source) {
    const base = path.basename(String(s.file).replace(/\\/g, '/'));
    const row = byFile.get(base);
    if (!row) { err(tag, `source render ${base} has no generated row`); continue; }
    if (!FILE_RE.test(base)) err(tag, `unexpected render name ${base}`);
    if (row.accepted !== (s.V10 === 'yes')) err(tag, `${base}: accepted flag disagrees with V10`);
    const wantFails = V_IDS.filter((id) => s[id] === 'fail');
    if (wantFails.join() !== row.fails.join()) err(tag, `${base}: fails ${row.fails} != source ${wantFails}`);
  }
  for (const r of rows) {
    rowsChecked++;
    if (ids.has(r.id)) err(tag, `duplicate row id ${r.id}`);
    ids.add(r.id);
    const pub = path.join(root, 'public', r.png);
    if (!fs.existsSync(pub) || fs.statSync(pub).size === 0) err(tag, `${r.id}: PNG missing or empty at ${r.png}`);
    else pngsChecked++;
    if (fs.existsSync(distDir) && !fs.existsSync(path.join(distDir, r.png))) err(tag, `${r.id}: PNG not in dist/ (${r.png})`);
    if (r.engine !== round.engine) err(tag, `${r.id}: row engine ${r.engine} != round engine ${round.engine}`);
    if (r.svg) {
      const svgPub = path.join(root, 'public', r.svg);
      if (!fs.existsSync(svgPub) || fs.statSync(svgPub).size === 0) err(tag, `${r.id}: SVG missing or empty at ${r.svg}`);
      else svgsChecked++;
      if (fs.existsSync(distDir) && !fs.existsSync(path.join(distDir, r.svg))) err(tag, `${r.id}: SVG not in dist/ (${r.svg})`);
    }
    if (r.checker !== null && !Array.isArray(r.checker)) err(tag, `${r.id}: checker must be an array or null`);
  }
  const unanalysed = rows.filter((r) => r.visual === null).length;
  if (unanalysed) warn(tag, `${unanalysed} of ${rows.length} renders have no visual-rule analysis (no .excalidraw or analyzer)`);
  const noChecker = rows.filter((r) => r.checker === null).length;
  if (noChecker) warn(tag, `${noChecker} renders are covered by no checker report`);

  // fuzz report parity
  for (const f of round.fuzzReports) {
    if (!fs.existsSync(f.file)) { warn(tag, `fuzz report ${f.file} not found; skipped`); continue; }
    const rep = readJson(f.file);
    const got = st.fuzz.find((x) => x.id === f.id);
    if (!got) { err(tag, `fuzz report ${f.id} missing from stats`); continue; }
    if (got.profiles.length !== (rep.profiles ?? []).length) err(tag, `fuzz ${f.id}: ${got.profiles.length} profiles != ${(rep.profiles ?? []).length}`);
    for (const p of rep.profiles ?? []) {
      const q = got.profiles.find((x) => x.profile === p.profile);
      if (!q || q.passed !== p.passed || q.renders !== p.renders) err(tag, `fuzz ${f.id}/${p.profile}: counts differ from the report`);
    }
  }
}
for (const s of stats) if (!cfg.rounds.some((r) => r.id === s.id)) err('stats.json', `round ${s.id} is not in kit.config.json`);
for (const [id, n] of setRowTotals) if (n === 0) err('kit.config.json', `set ${id} has no rows in any round`);

// ---- overview page exists ---------------------------------------------------
if (!fs.existsSync(path.join(docsDir, 'index.mdx'))) err('src/content/docs/index.mdx', 'overview page missing');
if (fs.existsSync(distDir)) {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) err('dist', 'no index.html (overview) in the build');
  for (const round of cfg.rounds) {
    for (const set of cfg.kit.sets) {
      if (!fs.existsSync(path.join(distDir, 'review', round.id, set.id, 'index.html'))) err('dist', `page review/${round.id}/${set.id}/ not built`);
    }
  }
} else warn('dist', 'not built; run `npm run build` (npm run check does) to check pages and links');

// ---- broken links and images in the build ----------------------------------
let linksChecked = 0;
if (fs.existsSync(distDir)) {
  const exists = (urlPath) => {
    const p = path.join(distDir, decodeURIComponent(urlPath));
    return fs.existsSync(p) && (fs.statSync(p).isFile() || fs.existsSync(path.join(p, 'index.html')));
  };
  const ATTR_RE = /\b(?:href|src)="([^"]+)"/g;
  for (const file of walk(distDir, (p) => p.endsWith('.html'))) {
    const html = read(file);
    for (const m of html.matchAll(ATTR_RE)) {
      const url = m[1].replace(/&amp;/g, '&');
      if (!url.startsWith('/') || url.startsWith('//')) continue;
      const clean = url.split('#')[0].split('?')[0];
      if (!clean || clean.startsWith('/pagefind/')) continue;
      linksChecked++;
      if (!exists(clean)) err(rel(file), `broken link or image ${url}`);
    }
    // island props carry the rows as escaped JSON; every png path in them must exist
    for (const m of html.matchAll(/review\/[\w.-]+\/(?:qa|fuzz)\/[\w.-]+\.(?:png|svg)/g)) {
      linksChecked++;
      if (!fs.existsSync(path.join(distDir, m[0]))) err(rel(file), `island references missing image ${m[0]}`);
    }
  }
}

// ---- pages ------------------------------------------------------------------
for (const page of walk(docsDir, (p) => /\.mdx?$/.test(p))) {
  const f = rel(page);
  const text = read(page);
  const { data } = parseFrontmatter(text);
  if (!text.startsWith('---')) err(f, 'missing frontmatter');
  if (!data.title) err(f, 'frontmatter needs a title');
  const rawDesc = /^description:\s*(.*)$/m.exec(text)?.[1] ?? '';
  if (rawDesc && !/^["']/.test(rawDesc) && rawDesc.includes(': ')) err(f, 'description contains ": " (breaks the YAML scalar); rephrase or quote the whole string');
}

// ---- source hygiene ---------------------------------------------------------
const MOTION_USE = /\b(?:transition|animation)\s*:|\banimate\(|requestAnimationFrame/;
const MOTION_GATE = /prefers-reduced-motion|motionOK\(|useReducedMotion/;
const ownFiles = walk(srcDir, (p) => /\.(astro|tsx?|css)$/.test(p) && !posix(p).includes('/generated/'));
for (const file of walk(path.join(root, 'scripts'), (p) => /\.mjs$/.test(p))) {
  const n = read(file).split(/\r?\n/).length;
  if (n > 500) err(rel(file), `${n} lines (limit 500)`);
}
for (const file of ownFiles) {
  const f = rel(file);
  const text = read(file);
  const lines = text.split(/\r?\n/);
  if (lines.length > 500) err(f, `${lines.length} lines (limit 500)`);
  if (MOTION_USE.test(text) && !MOTION_GATE.test(text)) err(f, 'uses transition/animation/rAF but never mentions prefers-reduced-motion, motionOK( or useReducedMotion');
  lines.forEach((line, i) => {
    if (/lint-ok/.test(line)) return;
    if (/transition\s*:\s*all\b/.test(line)) err(`${f}:${i + 1}`, '`transition: all`; name the properties');
    if (/0\.01ms/.test(line)) err(`${f}:${i + 1}`, '`0.01ms` reduced-motion reset; use a 0ms teleport or no animation');
  });
}

// ---- report -----------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
const pages = walk(docsDir, (p) => /\.mdx?$/.test(p)).length;
console.log(
  `check-dashboard: ${errors.length ? 'FAIL' : 'OK'} - ${cfg.rounds.length} round(s), ${rowsChecked} rows, ${pngsChecked} PNGs, ${svgsChecked} SVGs, ${pages} pages, ` +
    `${linksChecked} links/images in dist, ${errors.length} errors, ${warnings.length} warnings`,
);
process.exitCode = errors.length ? 1 : 0;
