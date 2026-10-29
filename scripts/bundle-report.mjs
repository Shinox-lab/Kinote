// Sizes of the console's built chunks, and a check that the viewer libraries stay lazy.
//   pnpm web:build && pnpm bundle:report
// The entry chunk (what every page load downloads) must not contain a viewer library: those load only when a
// file is opened. Set BUNDLE_BASELINE_KB (the entry's raw size before a change) to also fail when the entry
// grew by more than BUNDLE_TOLERANCE_PERCENT (default 5).
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'dist');
const assets = path.join(dist, 'assets');

// A string that only that library's code contains.
const SIGNATURES = {
  'pdf.js': 'PDFWorker',
  mammoth: 'mammoth',
  '@extend-ai/react-xlsx': 'react-xlsx-viewer',
  marked: 'markedjs',
  dompurify: 'ALLOWED_URI_REGEXP',
  excalidraw: 'EXCALIDRAW_ASSET_PATH',
};

const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const entry = /<script[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
if (!entry) {
  console.error('No entry script in dist/index.html: build the console first (pnpm web:build).');
  process.exit(2);
}

// Decimal kilobytes, as Vite prints them.
const kb = (n) => `${(n / 1000).toFixed(2)} kB`;
const rows = readdirSync(assets)
  .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  .map((file) => {
    const bytes = readFileSync(path.join(assets, file));
    const text = bytes.toString('utf8');
    return {
      file,
      raw: bytes.length,
      gzip: gzipSync(bytes).length,
      libs: Object.entries(SIGNATURES).filter(([, sig]) => text.includes(sig)).map(([name]) => name),
    };
  })
  .sort((a, b) => b.raw - a.raw);

console.log('chunk'.padEnd(46), 'raw'.padStart(12), 'gzip'.padStart(12), ' contains');
for (const r of rows) {
  const mark = r.file === entry ? '  <- entry' : '';
  console.log(r.file.padEnd(46), kb(r.raw).padStart(12), kb(r.gzip).padStart(12), ' ', r.libs.join(', ') + mark);
}

let failed = false;
const main = rows.find((r) => r.file === entry);
if (main.libs.length > 0) {
  console.error(`\nFAIL: the entry chunk contains ${main.libs.join(', ')}. Viewer libraries must load on demand.`);
  failed = true;
}
const baseline = Number(process.env.BUNDLE_BASELINE_KB);
if (Number.isFinite(baseline) && baseline > 0) {
  const tolerance = Number(process.env.BUNDLE_TOLERANCE_PERCENT ?? 5);
  const change = ((main.raw / 1000 - baseline) / baseline) * 100;
  console.log(`\nentry vs baseline ${baseline} kB: ${change >= 0 ? '+' : ''}${change.toFixed(1)}% (limit ${tolerance}%)`);
  if (change > tolerance) {
    console.error('FAIL: the entry chunk grew past the limit.');
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
