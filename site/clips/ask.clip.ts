import { expect } from '@playwright/test';
import { glide, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

/** A question in plain words, answered by the real model from the Handbook, with its source one click away. */
export default {
  name: 'ask',
  readme: false,
  layout: 'single',
  viewport: { width: 1280, height: 800 },
  async record({ demo, pages: [page], start, cut, hold }) {
    await page.goto(`/w/${demo.slug}/search`);
    const box = page.getByLabel('Search pages and files');
    await expect(box).toBeVisible();
    await start();
    await hold(600);

    await glide(page, box);
    await typeHuman(box, 'How many vacation days do new hires get?');
    await box.press('Enter');
    const ask = page.getByRole('button', { name: 'Get an answer' });
    await cut(() => expect(ask).toBeEnabled({ timeout: 60_000 }));
    await hold(600);
    await glide(page, ask);

    const answer = page.getByRole('region', { name: 'Answer' });
    await cut(() => expect(answer.getByRole('list', { name: 'Sources' })).toBeVisible({ timeout: 120_000 }));
    await hold(4000);

    const source = answer.getByRole('list', { name: 'Sources' }).getByRole('link').first();
    await glide(page, source, { click: false });
    await hold(600);
    await glide(page, source);
    await page.waitForLoadState('networkidle');
    await hold(3000);
  },
} satisfies Clip;
