// The console on a real stack: real files go in through the UI, Docling reads them, the viewers open them.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { xlsx } from '../../e2e/fixtures.js';
import { expandSpace, openAs, seedWorld, treeLink, uploadPanel, uploadThroughMenu, type TestFile } from '../../e2e/support.js';

async function chromePdf(page: Page, ...pages: string[]): Promise<Buffer> {
  const html = pages.map((t, i) => `<section style="page-break-after:${i === pages.length - 1 ? 'auto' : 'always'}"><h1>Section ${i + 1}</h1><p style="font-size:18px">${t}</p></section>`).join('');
  await page.setContent(`<html><body style="font-family:Helvetica,Arial,sans-serif">${html}</body></html>`);
  return Buffer.from(await page.pdf({ format: 'A4' }));
}

test('real files through the console: upload, read by Docling, preview, chunks, sources', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);

  const scratch = await browser.newPage();
  const pdf: TestFile = {
    name: 'Handbook.pdf',
    mimeType: 'application/pdf',
    buffer: await chromePdf(scratch, `Welcome to the handbook ${world.suffix}.`, `Parental leave is sixteen weeks ${world.suffix}.`),
  };
  await scratch.close();
  const book = xlsx('Budget.xlsx', world.suffix, [
    { name: 'Income', rows: [['Item', 'Amount'], ['Sales', 1200]] },
    { name: 'Costs', rows: [['Item', 'Amount'], ['Rent', 800]] },
  ]);
  const png: TestFile = { name: 'Checklist.png', mimeType: 'image/png', buffer: readFileSync(process.env.LIVE_PNG!) };

  await page.goto(`/w/${world.slug}`);
  await expandSpace(page, 'Docs');
  await uploadThroughMenu(page, 'Docs', [pdf, book, png]);
  const panel = uploadPanel(page);
  for (const name of ['Handbook.pdf', 'Budget.xlsx', 'Checklist.png']) {
    await expect(panel.getByRole('listitem').filter({ hasText: name })).toContainText('Indexed · v1', { timeout: 180_000 });
  }

  // The PDF opens on its second page and really draws.
  await treeLink(page, 'Handbook.pdf').click();
  await page.goto(page.url() + '?page=2');
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  const canvas = preview.getByRole('img', { name: /^Page 2 of 2$/ });
  await expect
    .poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 0 && v < 100)))
    .toBe(true);
  await page.getByRole('button', { name: 'Show search chunks' }).click();
  await expect(page.getByRole('list', { name: 'Chunks' })).toContainText(`sixteen weeks ${world.suffix}`);

  // The workbook.
  await treeLink(page, 'Budget.xlsx').click();
  await expect(page.getByRole('region', { name: 'Preview' }).getByRole('tab', { name: 'Costs' })).toBeVisible();

  // The picture, read with OCR.
  await treeLink(page, 'Checklist.png').click();
  await expect(page.getByRole('img', { name: 'Checklist.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Show search chunks' }).click();
  await expect(page.getByText('Text read with OCR')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Chunks' })).toContainText(/fire extinguisher/i);

  // Search from the console finds the PDF text and opens it on the right page.
  await page.goto(`/w/${world.slug}/search`);
  await page.getByLabel('Search or ask a question').fill(`sixteen weeks ${world.suffix}`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const link = page.getByRole('main').getByRole('link', { name: 'Handbook.pdf' }).first();
  await expect(link).toHaveAttribute('href', /\?page=2$/);

  // The Sources page, once.
  await page.goto(`/w/${world.slug}/admin/sources`);
  await page.getByLabel('Source name').fill('Live bot');
  await page.getByRole('button', { name: 'Add source' }).click();
  const source = page.getByRole('region', { name: 'Source Live bot' });
  await source.getByLabel('Token name').fill('live');
  await source.getByRole('button', { name: 'New token' }).click();
  await expect(page.getByRole('dialog', { name: 'Token for Live bot' })).toContainText('shown once');
});
