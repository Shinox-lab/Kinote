import { expect } from '@playwright/test';
import { glide, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';
import { makeDemoFiles } from './seed/files';

const INDEXED = 120_000;

/** A PDF and a spreadsheet uploaded into Engineering, previewed, and the PDF's text found by search. */
export default {
  name: 'files',
  readme: false,
  layout: 'single',
  viewport: { width: 1280, height: 800 },
  async record({ demo, pages: [page], start, cut, hold }) {
    const files = await makeDemoFiles(page.context().browser()!);
    await page.goto(`/w/${demo.slug}/s/engineering`);
    const side = page.getByRole('complementary', { name: 'Sidebar' });
    const spaceRow = side.getByRole('button', { name: /^(Expand|Collapse) Engineering$/ });
    await expect(spaceRow).toBeVisible();
    await start();
    await hold(600);

    await glide(page, spaceRow, { click: false });
    await glide(page, side.getByRole('button', { name: 'Add to Engineering' }));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), glide(page, side.getByRole('menuitem', { name: 'Upload file' }))]);
    await chooser.setFiles(files);

    const pdfLink = side.getByRole('link', { name: /^Harbor & Co brand guide/ }).first();
    const xlsxLink = side.getByRole('link', { name: /^Q4 budget/ }).first();
    await cut(async () => {
      await expect(pdfLink).toBeVisible({ timeout: INDEXED });
      await expect(xlsxLink).toBeVisible({ timeout: INDEXED });
    });
    await hold(800);

    const fileStatus = page.getByRole('status', { name: /^File status:/ });
    await glide(page, pdfLink);
    await cut(() => expect(fileStatus).toHaveText(/^Indexed/, { timeout: INDEXED }));
    await hold(2500);

    await glide(page, xlsxLink);
    await cut(() => expect(fileStatus).toHaveText(/^Indexed/, { timeout: INDEXED }));
    await hold(2500);

    await glide(page, page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Search' }));
    const box = page.getByLabel('Search pages and files');
    await glide(page, box);
    await typeHuman(box, 'Tidewater Blue');
    await box.press('Enter');
    const results = page.getByRole('list', { name: 'Search results' });
    await cut(() => expect(results.getByText(/Tidewater Blue/).first()).toBeVisible({ timeout: 60_000 }));
    await hold(3000);
  },
} satisfies Clip;
