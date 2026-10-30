import { expect } from '@playwright/test';
import { glide, lineEnd, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

/** A [[ link from "Weekly notes" to Harbor & Co, the backlink on Harbor & Co, and a comment there. */
export default {
  name: 'links',
  readme: false,
  layout: 'single',
  viewport: { width: 1280, height: 800 },
  async record({ demo, pages: [page], start, cut, hold }) {
    const harborId = demo.pages.harbor;
    await page.goto(`/w/${demo.slug}/p/${demo.pages.weekly}`);
    await expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible({ timeout: 30_000 });
    await start();
    await hold(800);

    const editor = page.locator('.bn-editor').first();
    await glide(page, editor.locator('.bn-block-content').filter({ hasText: /\S/ }).last());
    await lineEnd(page);
    await page.keyboard.press('Enter');
    await typeHuman(editor, 'Follow up with [[Harb');
    await glide(page, page.getByRole('listbox').getByRole('option', { name: /Harbor & Co/ }).first());
    await hold(800);

    const link = editor.locator(`[data-page-link="${harborId}"]`);
    await glide(page, link);
    const peek = page.getByRole('complementary', { name: 'Page preview' });
    await expect(peek.getByRole('heading', { level: 1, name: 'Harbor & Co' })).toBeVisible({ timeout: 15_000 });
    await hold(2200);
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);

    // Index the page so Harbor & Co lists it as linked from here.
    await glide(page, page.getByRole('button', { name: 'Page status and actions' }));
    await glide(page, page.getByRole('dialog', { name: 'Page status and actions' }).getByRole('button', { name: 'Index now', exact: true }));
    await page.keyboard.press('Escape');
    await cut(() => expect(page.getByRole('status', { name: /^Page status: Indexed/ })).toBeVisible({ timeout: 60_000 }));
    await hold(600);

    await cut(async () => {
      await page.goto(`/w/${demo.slug}/p/${harborId}`);
      await expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible({ timeout: 30_000 });
    });
    const connections = page.getByRole('region', { name: 'Connections' });
    await connections.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await glide(page, connections.getByRole('link', { name: /Weekly notes/ }), { click: false });
    await hold(2500);

    // Comment on the launch date.
    const launch = page.locator('.bn-editor .bn-block-content').filter({ hasText: 'The new shop launches on' }).first();
    await launch.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await hold(500);
    await glide(page, launch);
    await lineEnd(page);
    await page.keyboard.down('Shift');
    for (let i = 0; i < '14 November.'.length; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await hold(400);
    await glide(page, page.getByRole('button', { name: 'Add comment' }));
    await page.keyboard.type('Confirm the new date with Daniel', { delay: 28 });
    await glide(page, page.getByRole('button', { name: 'Save' }));
    await hold(2500);
  },
} satisfies Clip;
