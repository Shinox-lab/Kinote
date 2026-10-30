import { expect } from '@playwright/test';
import { glide, lineEnd, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

/** The Roadmap as a table, a board (one card dragged to Blocked), a calendar and a timeline. */
export default {
  name: 'collections',
  readme: true,
  layout: 'single',
  viewport: { width: 1280, height: 800 },
  async record({ demo, pages: [page], start, cut, hold }) {
    await page.goto(`/w/${demo.slug}/p/${demo.pages.roadmap}`);
    await expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible({ timeout: 30_000 });
    await start();
    await hold(800);

    const editor = page.locator('.bn-editor').first();
    await glide(page, editor.locator('.bn-block-content').filter({ hasText: /\S/ }).last());
    await lineEnd(page);
    await page.keyboard.press('Enter');
    await typeHuman(editor, '/collection view');
    await glide(page, page.getByRole('option', { name: /Collection view/ }));

    const view = page.locator('[data-collection-view]').first();
    const table = view.getByRole('table');
    await cut(() => expect(table.getByRole('button', { name: 'Checkout redesign' })).toBeVisible({ timeout: 30_000 }));
    await view.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await hold(2500);

    const addView = view.getByLabel('Add a view');
    await glide(page, addView, { click: false });
    await addView.selectOption('board');
    const card = view.getByRole('region', { name: 'In progress' }).getByRole('article', { name: 'Checkout redesign' });
    await expect(card).toBeVisible();
    await hold(1500);

    // Drag the card with the mouse, so the cursor carries it across.
    const blocked = view.getByRole('region', { name: 'Blocked' });
    await glide(page, card, { click: false });
    await page.mouse.down();
    const to = (await blocked.boundingBox())!;
    await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 30 });
    await page.mouse.up();
    await expect(blocked.getByRole('article', { name: 'Checkout redesign' })).toBeVisible({ timeout: 10_000 });
    await hold(1800);

    await glide(page, addView, { click: false });
    await addView.selectOption('calendar');
    await hold(2500);
    await glide(page, addView, { click: false });
    await addView.selectOption('timeline');
    await hold(3000);
  },
} satisfies Clip;
