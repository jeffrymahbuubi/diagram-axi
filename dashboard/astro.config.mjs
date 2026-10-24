// @ts-check
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import { loadConfig } from './scripts/lib/config.mjs';

// Starlight bundles MDX, Expressive Code and Pagefind; do not add them separately.
// `npm run gen:pages` (predev/prebuild) fills src/content/docs/review/** from the artefacts named in kit.config.json.
const { kit, rounds } = loadConfig();

/** One sidebar group per round, omitted when the generator produced nothing for it. */
const roundGroups = rounds
  .filter((r) => fs.existsSync(new URL(`./src/content/docs/review/${r.id}`, import.meta.url)))
  .map((r) => ({ label: `${r.label} renders`, collapsed: false, items: [{ autogenerate: { directory: `review/${r.id}` } }] }));

/** Three-engine bake-off group, present only when gen-bakeoff produced pages. */
const bakeoffGroup = fs.existsSync(new URL('./src/content/docs/bakeoff', import.meta.url))
  ? [{ label: 'Engine bake-off', collapsed: false, items: [{ autogenerate: { directory: 'bakeoff' } }] }]
  : [];

export default defineConfig({
  integrations: [
    starlight({
      title: kit.siteTitle,
      description: 'Local QA review dashboard for diagram-axi: reviewer verdicts, checker results and visual-rule codes per render.',
      customCss: ['./src/styles/tokens.css', './src/styles/dashboard.css', './src/styles/review.css', './src/styles/bakeoff.css'],
      sidebar: [{ label: 'Overview', slug: 'index' }, ...bakeoffGroup, ...roundGroups],
    }),
    react(),
  ],
});
