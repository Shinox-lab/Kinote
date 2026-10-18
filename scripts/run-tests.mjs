import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const buildRes = spawnSync('node', [path.join(ROOT, 'scripts/build.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (buildRes.status !== 0) {
  process.exit(buildRes.status ?? 1);
}

const testRes = spawnSync(
  'node',
  ['--test', path.join(ROOT, 'dist/apps/api/test/slice-0-1.test.js')],
  {
    cwd: ROOT,
    stdio: 'inherit',
  }
);
process.exit(testRes.status ?? 0);
