import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Every colour in the console comes from a design token (bg-page, text-muted,
// border-line, ...), so light and dark both work. A hard-coded palette class
// (bg-slate-50, text-indigo-700, bg-white, ...) is a colour that ignores the theme.

const SRC = new URL('../src', import.meta.url).pathname;
/** Files that may keep a hard-coded colour, and why. Empty on purpose. */
const ALLOWED: string[] = [];

const PALETTE =
  /\b(?:bg|text|border|ring|divide|outline|fill|stroke|from|to|via|placeholder|accent|shadow|decoration|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const PLAIN = /\b(?:bg|text|border|ring|divide|outline)-(?:white|black)\b(?!\/)/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(?:ts|tsx)$/.test(e.name) ? [path] : [];
  });
}

describe('design tokens', () => {
  test('no source file hard-codes a palette colour', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const hits = [...(text.match(PALETTE) ?? []), ...(text.match(PLAIN) ?? [])];
      if (hits.length > 0) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
