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

  test('the PDF library is a version with the script-injection fix, has no eval path, and the viewer never loads scripting', () => {
    const root = new URL('../../../node_modules/pdfjs-dist', import.meta.url).pathname;
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
    // CVE-2024-4367 (arbitrary JavaScript through a crafted font) is fixed from 4.2.67.
    expect(major > 4 || (major === 4 && (minor > 2 || (minor === 2 && patch >= 67)))).toBe(true);
    for (const file of ['build/pdf.mjs', 'build/pdf.worker.mjs']) {
      const code = readFileSync(join(root, file), 'utf8');
      expect(code, file).not.toMatch(/isEvalSupported/);
      expect(code, file).not.toMatch(/\bnew Function\(|[^.\w]eval\(/);
    }
    const viewer = read('viewers/PdfViewer.tsx');
    expect(viewer).not.toMatch(/scripting|PDFScriptingManager|enableScripting/i);
    expect(viewer).not.toMatch(/AnnotationLayer|TextLayer/);
  });
});
