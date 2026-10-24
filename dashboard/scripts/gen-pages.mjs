// gen:pages - turns the QA review artefacts named in kit.config.json into Starlight pages + JSON.
// Usage: node scripts/gen-pages.mjs   (run by predev / prebuild / check; all output is ignored by version control)
//   per round and set -> src/content/docs/review/<round>/<set>.mdx   (island page; rows imported from JSON)
//   src/generated/<round>/<set>.json   rows of the grid island
//   src/generated/{meta,stats}.json    V-check meanings, sets, rounds, aggregates for the overview
//   public/review/<round>/{qa,fuzz}/*.png   copies of the rendered PNGs (served as /review/...), plus *.svg twins when present
// A round whose data folder is missing is skipped with a warning (fixture mode: see README); only zero loadable rounds is fatal.
// Pages are generated, never edited by hand. The new SOFT visual-rule codes come from the main repo's built
// analyzer (kit.config.json analyzerPath); when it is missing they are skipped with a warning.
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter } from './lib/markdown.mjs';
import { loadConfig, root, posix } from './lib/config.mjs';
import { buildRows, loadAnalyzer, V_CHECKS } from './lib/round.mjs';
import { roundStats } from './lib/stats.mjs';

const cfg = loadConfig();
const docsOut = path.join(root, 'src', 'content', 'docs', 'review');
const genDir = path.join(root, 'src', 'generated');
const pngOut = path.join(root, 'public', 'review');
const warn = (msg) => console.warn(`gen-pages: warning: ${msg}`);

for (const sk of cfg.skipped) warn(`${sk.id}: ${sk.file} not found; round skipped (produce the round's data, or run \`npm run check:fixtures\` for synthetic fixtures)`);
if (cfg.fixtures) for (const r of cfg.rounds) if (r.fixture) warn(`${r.id}: using SYNTHETIC fixture data from ${posix(path.relative(root, r.reviewRoot))}`);
if (!cfg.rounds.length) {
  console.error(
    'gen-pages: no round has data. Set reviewRoot in kit.config.local.json (or QA_REVIEW_ROOT) to the folder holding the QA artefacts, e.g. the main checkout out/review, or use DASHBOARD_FIXTURES=1.',
  );
  process.exit(2);
}
for (const d of [docsOut, genDir, pngOut]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(genDir, { recursive: true });

const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
};

const analyze = await loadAnalyzer(cfg.analyzerFile, warn);
const allStats = [];
let pages = 0;
let pngs = 0;
let svgs = 0;

for (const [roundIdx, round] of cfg.rounds.entries()) {
  const rows = await buildRows(round, cfg, analyze, warn);
  // copy PNGs (a missing source is left for the checker to report)
  for (const r of rows) {
    if (!fs.existsSync(r.absPng)) { warn(`${round.id}: missing PNG ${r.absPng}`); continue; }
    const dest = path.join(root, 'public', r.png);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(r.absPng, dest);
    pngs++;
    if (r.absSvg) { fs.copyFileSync(r.absSvg, path.join(root, 'public', r.svg)); svgs++; }
  }
  const stats = roundStats(round, rows, cfg);
  allStats.push(stats);

  for (const [setIdx, set] of cfg.kit.sets.entries()) {
    const setRows = rows.filter((r) => r.set === set.id).map(({ absPng, absSvg, ...rest }) => rest);
    writeJson(path.join(genDir, round.id, `${set.id}.json`), setRows);
    const accepted = setRows.filter((r) => r.accepted).length;
    const head = frontmatter({
      title: `${set.title} (${round.label})`,
      description: `${setRows.length} renders in ${round.label}${round.engine ? ` (${round.engine} engine)` : ''}, ${setRows.length - accepted} rejected by the reviewer. Filter by status, direction and failed V-check.`,
      sidebar: { label: set.label, order: setIdx + 1 },
      tableOfContents: false,
      pagefind: false,
    });
    const body = [
      "import ReviewGrid from '@components/ReviewGrid.tsx';",
      `import rows from '@generated/${round.id}/${set.id}.json';`,
      "import meta from '@generated/meta.json';",
      '',
      `<ReviewGrid client:visible rows={rows} vchecks={meta.vchecks} visualRules={meta.visualRules} setLabel=${JSON.stringify(set.label)} roundId=${JSON.stringify(round.id)} engine=${JSON.stringify(round.engine ?? '')} fixture={${round.fixture}} />`,
      '',
    ].join('\n');
    const file = path.join(docsOut, round.id, `${set.id}.mdx`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${head}\n${body}`);
    pages++;
  }
  console.log(
    `gen-pages: ${round.id}${round.engine ? ` [${round.engine}]` : ''}: ${rows.length} renders (${stats.accepted} accepted, ${stats.rejected} rejected); ` +
      `visual rules ${stats.visual.analysed ? `analysed on ${stats.visual.analysed}` : 'not analysed'}`,
  );
}

writeJson(path.join(genDir, 'meta.json'), {
  siteTitle: cfg.kit.siteTitle,
  vchecks: V_CHECKS,
  visualRules: cfg.kit.visualRules ?? [],
  sets: cfg.kit.sets,
  rounds: cfg.rounds.map((r) => ({ id: r.id, label: r.label, engine: r.engine ?? null, fixture: r.fixture })),
  skippedRounds: cfg.skipped.map((r) => ({ id: r.id, label: r.label })),
  analyzerLoaded: Boolean(analyze),
});
writeJson(path.join(genDir, 'stats.json'), allStats);
console.log(`gen-pages: ${pages} set pages, ${pngs} PNGs + ${svgs} SVGs -> public/review/ (${posix(path.relative(root, docsOut))})`);
