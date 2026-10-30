import { expect, type Page } from '@playwright/test';
import { glide, lineEnd, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

const connected = (page: Page) => expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible({ timeout: 30_000 });
const editor = (page: Page) => page.locator('.bn-editor').first();

/** Priya and Tomás on "Design review notes" at once: each sees the other's cursor and words arrive live. */
export default {
  name: 'co-edit',
  readme: true,
  layout: 'side-by-side',
  viewport: { width: 960, height: 800 },
  async record({ demo, pages: [priya, tomas], start, hold }) {
    const url = `/w/${demo.slug}/p/${demo.pages['design-review']}`;
    await Promise.all([priya.goto(url), tomas.goto(url)]);
    await Promise.all([connected(priya), connected(tomas)]);
    await start();
    await hold(1500);

    // Tomás starts a section at the end of the page.
    const tomasEnd = editor(tomas).locator('.bn-block-content').filter({ hasText: /\S/ }).last();
    await glide(tomas, tomasEnd);
    await lineEnd(tomas);
    await tomas.keyboard.press('Enter');
    await typeHuman(editor(tomas), '## Action items\n');

    // Priya adds today's notes under the intro while Tomás writes his list.
    const intro = editor(priya).locator('.bn-block-content').first();
    await glide(priya, intro);
    await lineEnd(priya);
    await priya.keyboard.press('Enter');
    await Promise.all([
      typeHuman(editor(priya), '## 30 October\nHarbor & Co checkout: the new payment step tested well with their team.\nLumen booking: older patients found the date picker easy to use.'),
      (async () => {
        await tomas.waitForTimeout(700);
        await typeHuman(editor(tomas), '- Send Harbor the checkout preview\nBook the Lumen date picker test\nShare the audit plan with Mei');
      })(),
    ]);
    await hold(3000);
  },
} satisfies Clip;
