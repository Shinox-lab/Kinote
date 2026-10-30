import { expect, type Page } from '@playwright/test';
import { glide, lineEnd, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

const status = (page: Page) => page.getByRole('status', { name: /^Page status:/ });

/** Jonah's change to a Clients page waits for approval; Mei approves it in Reviews; Jonah's page turns Indexed. */
export default {
  name: 'review',
  readme: true,
  layout: 'side-by-side',
  viewport: { width: 960, height: 800 },
  async record({ demo, pages: [jonah, mei], start, cut, hold }) {
    await jonah.goto(`/w/${demo.slug}/p/${demo.pages.lumen}`);
    await expect(jonah.getByRole('status', { name: 'Presence: connected' })).toBeVisible({ timeout: 30_000 });
    await mei.goto(`/w/${demo.slug}/reviews`);
    await expect(mei.getByRole('heading', { name: 'Reviews' }).first()).toBeVisible();
    await start();
    await hold(800);

    const last = jonah.locator('.bn-editor .bn-block-content').filter({ hasText: /\S/ }).last();
    await glide(jonah, last);
    await lineEnd(jonah);
    await jonah.keyboard.press('Enter');
    await typeHuman(jonah.locator('.bn-editor').first(), 'Sam asked for appointment reminders in Spanish as well.');
    await hold(500);

    await glide(jonah, jonah.getByRole('button', { name: 'Page status and actions' }));
    await glide(jonah, jonah.getByRole('dialog', { name: 'Page status and actions' }).getByRole('button', { name: 'Submit for review', exact: true }));
    await expect(status(jonah)).toHaveText(/awaiting approval/, { timeout: 30_000 });
    await jonah.keyboard.press('Escape');
    await hold(1500);

    // The queue polls; if the item hasn't arrived yet, the wait is cut.
    const item = mei.getByRole('main').getByText('Lumen Health', { exact: true }).first();
    await cut(async () => {
      for (let i = 0; i < 30 && !(await item.isVisible()); i++) await mei.waitForTimeout(1000);
      if (!(await item.isVisible())) await mei.reload();
      await expect(item).toBeVisible({ timeout: 30_000 });
    });
    await glide(mei, item);
    await glide(mei, mei.getByRole('group', { name: 'Review view' }).getByRole('button', { name: 'Changes only' }));
    await hold(1800);
    await glide(mei, mei.getByRole('button', { name: 'Approve', exact: true }));

    await cut(async () => {
      for (let i = 0; i < 60; i++) {
        if (/^Indexed/.test((await status(jonah).textContent()) ?? '')) return;
        await jonah.waitForTimeout(1000);
        if (i % 10 === 9) await jonah.reload();
      }
      await expect(status(jonah)).toHaveText(/^Indexed/, { timeout: 30_000 });
    });
    await hold(2000);
  },
} satisfies Clip;
