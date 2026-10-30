import type { Browser } from '@playwright/test';
import ExcelJS from 'exceljs';
import type { TestFile } from '../../../e2e/support';
import { brandGuide, budget } from './content';

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A real PDF (an HTML page printed by Chromium) and a real XLSX (exceljs), for the files clip. */
export async function makeDemoFiles(browser: Browser): Promise<TestFile[]> {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    body { font: 15px/1.6 Georgia, serif; color: #1f2a30; margin: 0; }
    .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 0 64px; background: #1f4e5f; color: #e8dcc4; }
    .cover h1 { font: 700 44px/1.1 Helvetica, Arial, sans-serif; margin: 0 0 12px; }
    section { padding: 48px 64px 0; }
    h2 { font: 700 22px Helvetica, Arial, sans-serif; color: #1f4e5f; }
    .swatches { display: flex; gap: 12px; } .swatches i { width: 72px; height: 48px; border-radius: 6px; }
  </style></head><body>
    <div class="cover"><h1>${escape(brandGuide.title)}</h1><p>Version 3 · November 2026</p></div>
    ${brandGuide.sections
      .map((s) => `<section><h2>${escape(s.heading)}</h2><p>${escape(s.body)}</p>${
        s.heading === 'Colours' ? '<div class="swatches"><i style="background:#1f4e5f"></i><i style="background:#e8dcc4"></i><i style="background:#e4664a"></i></div>' : ''
      }</section>`)
      .join('')}
  </body></html>`);
  const pdf = await page.pdf({ format: 'A4', printBackground: true });
  await page.close();

  const workbook = new ExcelJS.Workbook();
  for (const sheet of budget.sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 20));
  }
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

  return [
    { name: brandGuide.name, mimeType: 'application/pdf', buffer: pdf },
    { name: budget.name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx },
  ];
}
