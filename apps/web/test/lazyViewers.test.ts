import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// The viewers and their libraries (pdf.js, mammoth, a spreadsheet reader, marked, DOMPurify) are heavy:
// they load only when a file is opened. These checks keep a viewer from sliding into the main bundle.

const SRC = new URL('../src', import.meta.url).pathname;
const LIBRARIES = ['pdfjs-dist', 'mammoth', 'read-excel-file', 'marked', 'dompurify'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(?:ts|tsx)$/.test(e.name) ? [path] : [];
  });
}
const rel = (f: string) => f.slice(SRC.length + 1);
const read = (r: string) => readFileSync(join(SRC, r), 'utf8');

describe('lazy viewers', () => {
  test('a viewer library is named only under src/viewers', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (rel(file).startsWith('viewers/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const lib of LIBRARIES) {
        if (new RegExp(`from ['"]${lib}[/'"]|import\\(['"]${lib}[/'"]`).test(text)) offenders.push(`${rel(file)}: ${lib}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('FileViewer loads every viewer with lazy(), never with a static import', () => {
    const text = read('viewers/FileViewer.tsx');
    expect(text).not.toMatch(/^import .* from '\.\/\w+Viewer\.js'/m);
    expect((text.match(/lazy\(\(\) => import\(/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test('no screen imports a viewer except through FileViewer', () => {
    const offenders = sources(SRC)
      .map(rel)
      .filter((r) => !r.startsWith('viewers/'))
      .filter((r) => /from '[./]*(?:viewers\/)(?!FileViewer\.js)/.test(read(r)));
    expect(offenders).toEqual([]);
  });
});
