// run-with-fixtures - runs an npm script with DASHBOARD_FIXTURES=1 (portable replacement for `VAR=1 npm run ...`).
// Usage: node scripts/run-with-fixtures.mjs [npm-script]   (default: check)
// In fixture mode a round whose data folder does not exist yet falls back to test-fixtures/<folder name>
// (see scripts/lib/config.mjs); real data always wins when present.
import { spawnSync } from 'node:child_process';

const script = process.argv[2] ?? 'check';
if (!/^[\w:.-]+$/.test(script)) {
  console.error(`run-with-fixtures: bad script name ${script}`);
  process.exit(2);
}
const res = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true, env: { ...process.env, DASHBOARD_FIXTURES: '1' } });
process.exit(res.status ?? 1);
