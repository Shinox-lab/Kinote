// Renders docs/sales/kinote-demo-walkthrough.md to a PDF beside it: tsx site/scripts/sales-pdf.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(root, 'docs', 'sales', 'kinote-demo-walkthrough.md');
const body = await marked.parse(readFileSync(source, 'utf8').replace(/^# .*\n/, ''), { gfm: true });
const logo = `data:image/svg+xml;base64,${readFileSync(join(root, 'site', 'public', 'logo-light.svg')).toString('base64')}`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 16mm 18mm; }
  body { font: 10.5pt/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: #24211d; margin: 0; }
  header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #6550c9; padding-bottom: 10px; margin-bottom: 14px; }
  header img { height: 26px; }
  header span { font-size: 15pt; font-weight: 700; }
  h2 { font-size: 13pt; color: #5b43c7; margin: 18px 0 6px; break-after: avoid; }
  h3 { font-size: 11pt; margin: 14px 0 4px; break-after: avoid; }
  h3 + p, h3 + ol, h3 + ul { margin-top: 2px; }
  p, ul, ol { margin: 4px 0; }
  li { margin: 2px 0; }
  strong { font-weight: 650; }
  em { color: #3d3832; }
  hr { border: 0; border-top: 1px solid #e8e2d9; margin: 14px 0; }
  code { font: 9.5pt ui-monospace, SFMono-Regular, Menlo, monospace; background: #f5f2ed; padding: 1px 4px; border-radius: 4px; }
  blockquote { margin: 10px 0; padding: 8px 12px; background: #ece6fa; border-left: 3px solid #6550c9; border-radius: 4px; }
  blockquote p { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 9.5pt; break-inside: avoid; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e8e2d9; vertical-align: top; }
  th { background: #f5f2ed; font-weight: 650; }
  h3, h3 + p, h3 + ol { break-inside: avoid; }
  p:has(+ ul), p:has(+ ol) { break-after: avoid; }
</style></head><body>
  <header><span>Kinote demo walkthrough</span><img src="${logo}" alt="Kinote"></header>
  ${body}
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({
  path: source.replace(/\.md$/, '.pdf'),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="font-size:8px;color:#8d857b;width:100%;text-align:center">Kinote · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
});
await browser.close();
