import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('where markup is allowed to become live', () => {
  const SRC = new URL('../src', import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
    );

  test('dangerouslySetInnerHTML appears in one file, and that file sanitises first', () => {
    const users = files(SRC).filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
    expect(users.map((f) => f.slice(SRC.length + 1))).toEqual(['viewers/Html.tsx']);
    expect(readFileSync(users[0]!, 'utf8')).toMatch(/sanitizeHtml\(/);
  });

  test('innerHTML is never assigned directly', () => {
    const users = files(SRC).filter((f) => /\.innerHTML\s*=/.test(readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
});
