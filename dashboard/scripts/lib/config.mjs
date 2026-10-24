// Shared config loader for gen-pages, check-dashboard and astro.config.mjs.
// kit.config.json (committed) <- kit.config.local.json (ignored, shallow merge) <- env overrides.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const posix = (p) => p.split(path.sep).join('/');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Absolute path from a config value: absolute stays, relative resolves against dashboard/. */
export const resolveFromRoot = (p) => path.resolve(root, p);

export function loadConfig() {
  const kit = readJson(path.join(root, 'kit.config.json'));
  const localFile = path.join(root, 'kit.config.local.json');
  if (fs.existsSync(localFile)) Object.assign(kit, readJson(localFile));
  if (process.env.QA_REVIEW_ROOT) kit.reviewRoot = process.env.QA_REVIEW_ROOT;
  if (process.env.QA_ANALYZER_PATH) kit.analyzerPath = process.env.QA_ANALYZER_PATH;

  const defaultRoot = resolveFromRoot(kit.reviewRoot);
  // Fixture mode (DASHBOARD_FIXTURES=1 or `npm run check:fixtures`): a round whose data folder does not exist falls
  // back to the synthetic folder test-fixtures/<basename of its reviewRoot>. Real data always wins when present.
  const fixtures = process.env.DASHBOARD_FIXTURES === '1';
  const fixtureBase = resolveFromRoot(kit.fixtureRoot ?? 'test-fixtures');
  const rounds = [];
  const skipped = [];
  for (const r of kit.rounds ?? []) {
    let reviewRoot = r.reviewRoot ? resolveFromRoot(r.reviewRoot) : defaultRoot;
    let fixture = false;
    const hasData = (dir) => fs.existsSync(path.resolve(dir, r.verdicts ?? 'all-verdicts.json'));
    if (!hasData(reviewRoot) && fixtures && r.reviewRoot) {
      const alt = path.join(fixtureBase, path.basename(reviewRoot));
      if (hasData(alt)) { reviewRoot = alt; fixture = true; }
    }
    const round = {
      ...r,
      engine: r.engine ?? null,
      fixture,
      reviewRoot,
      verdictsFile: path.resolve(reviewRoot, r.verdicts ?? 'all-verdicts.json'),
      galleryFile: r.gallery ? path.resolve(reviewRoot, r.gallery) : null,
      qaPath: path.resolve(reviewRoot, r.qaDir ?? 'qa'),
      fuzzPath: path.resolve(reviewRoot, r.fuzzDir ?? 'fuzz'),
      qaReportFile: r.qaReport ? path.resolve(reviewRoot, r.qaReport) : null,
      fuzzReports: (r.fuzzReports ?? []).map((f) => ({ ...f, file: path.resolve(reviewRoot, f.path) })),
    };
    // a round whose data does not exist (yet) is skipped with a warning, never a crash
    if (!fs.existsSync(round.verdictsFile)) skipped.push({ id: r.id, label: r.label, file: round.verdictsFile });
    else rounds.push(round);
  }
  return { kit, rounds, skipped, fixtures, analyzerFile: kit.analyzerPath ? resolveFromRoot(kit.analyzerPath) : null };
}

/** Slug used for page URLs and sidebar order. */
export const setSlug = (set) => set.id;
