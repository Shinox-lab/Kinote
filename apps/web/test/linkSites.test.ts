import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// A file id sent to the page route (or a page id to the file route) opens "not
// found". Every link that can point at either kind goes through DocumentLink; only
// the files below can only mean a page, and so may name the page route.

const SRC = new URL('../src', import.meta.url).pathname;
const PAGE_ONLY = [
  'routes/page.tsx',
  'components/sidebar/NewPageRow.tsx',
  'routes/space.tsx',
  'components/DocumentLink.tsx',
  'router.tsx',
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.tsx$/.test(e.name) ? [path] : [];
  });
}

describe('links by document kind', () => {
  test('the page route is named only where a page is the only possible target', () => {
    const offenders = sources(SRC)
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !PAGE_ONLY.includes(rel))
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('/w/$tenantSlug/p/$pageId'));
    expect(offenders).toEqual([]);
  });
});
