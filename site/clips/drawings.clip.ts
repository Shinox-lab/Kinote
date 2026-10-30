import { expect, type Locator, type Page } from '@playwright/test';
import { glide, lineEnd, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

/** Drags from one point of the canvas to another with the current tool, slowly enough to watch. */
/** Points are fractions of the canvas, so the sketch fits whatever width the page gives it. */
async function drag(page: Page, canvas: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height, { steps: 12 });
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 20 });
  await page.mouse.up();
}

/** A drawing added to "Office layout": two rooms, an arrow and a label, sketched in the page. */
export default {
  name: 'drawings',
  readme: false,
  layout: 'single',
  viewport: { width: 1280, height: 800 },
  async record({ demo, pages: [page], start, cut, hold }) {
    await page.goto(`/w/${demo.slug}/p/${demo.pages.office}`);
    await expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible({ timeout: 30_000 });
    await start();
    await hold(800);

    const editor = page.locator('.bn-editor').first();
    await glide(page, editor.locator('.bn-block-content').filter({ hasText: /\S/ }).last());
    await lineEnd(page);
    await page.keyboard.press('Enter');
    await typeHuman(editor, '/drawing');
    await glide(page, page.getByRole('option', { name: /^Drawing/ }));

    const block = page.locator('[data-drawing-id]').last();
    const canvas = block.locator('canvas.interactive');
    await cut(() => expect(canvas).toBeVisible({ timeout: 30_000 }));
    await block.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await hold(1000);

    const box = (await canvas.boundingBox())!;
    await glide(page, canvas, { click: false });
    await page.mouse.click(box.x + 8, box.y + box.height - 8);
    await page.keyboard.press('r');
    await drag(page, canvas, [0.08, 0.28], [0.4, 0.72]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('r');
    await drag(page, canvas, [0.6, 0.28], [0.9, 0.72]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('a');
    await drag(page, canvas, [0.42, 0.5], [0.58, 0.5]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('t');
    await page.mouse.click(box.x + 0.75 * box.width, box.y + 0.82 * box.height);
    await page.keyboard.type('Quiet room', { delay: 40 });
    await page.keyboard.press('Escape');
    await hold(800);

    // Back in the page, the drawing stays where it was put.
    await glide(page, page.getByRole('heading', { name: 'Office layout' }).first());
    await hold(3000);
  },
} satisfies Clip;
