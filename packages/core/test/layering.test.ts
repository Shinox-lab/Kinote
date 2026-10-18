import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const FORBIDDEN = /\.\.\/\.\.\/(api|worker|collab|web)\//;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('apps do not import each other across app boundaries', () => {
  const appsDir = join(repoRoot, 'apps');
  const offenders: string[] = [];
  for (const app of readdirSync(appsDir)) {
    const src = join(appsDir, app, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of tsFiles(src)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\b(from|import)\b/.test(line) && FORBIDDEN.test(line)) {
          offenders.push(`${file.slice(repoRoot.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `cross-app imports found:\n${offenders.join('\n')}`);
});
