import { expect } from '@playwright/test';
import { glide, typeHuman } from './lib/cursor';
import type { Clip } from './lib/types';

const NOTE =
  "Call with Harbor & Co today: launch moves from 14 Nov to 28 Nov, and Daniel Cho takes over from Ruth Alvarez as their main contact. Let's pause the checkout redesign until their new brand guide arrives.";
const BUSY = /Waiting to route|Routing…|Reading the file…/;
const ROUTING_TIMEOUT = 240_000;

/** The hero: a note typed once on Capture, routed by the real model into pages in two spaces. */
export default {
  name: 'capture',
  readme: true,
  layout: 'single',
  viewport: { width: 1280, height: 800 },
  async record({ demo, pages: [page], start, cut, hold }) {
    await page.goto(`/w/${demo.slug}`);
    const sidebar = page.getByRole('navigation', { name: 'Workspace' });
    await expect(sidebar.getByRole('link', { name: 'Capture' })).toBeVisible();
    await start();
    await hold(600);

    await glide(page, sidebar.getByRole('link', { name: 'Capture' }));
    const box = page.getByLabel('What do you want to file?');
    await expect(box).toBeVisible();
    await glide(page, box);
    await typeHuman(box, NOTE);
    await hold(400);
    const fileAs = page.getByLabel('File as');
    await glide(page, fileAs, { click: false });
    await fileAs.selectOption('updates');
    await hold(500);
    await glide(page, page.getByRole('button', { name: 'Send' }));

    const card = page.locator('article[aria-label^="Capture from"]').first();
    const status = card.locator('span').first();
    await cut(() => expect(status).not.toHaveText(BUSY, { timeout: ROUTING_TIMEOUT }));

    // The model may ask which page it means; answer with its first option.
    if ((await status.textContent())?.includes('Needs your answer')) {
      const option = card.getByRole('list', { name: 'Thread' }).getByRole('button').first();
      await glide(page, option);
      await cut(() => expect(status).not.toHaveText(/Needs your answer|Waiting to route|Routing…/, { timeout: ROUTING_TIMEOUT }));
    }

    const receipt = card.getByRole('region', { name: 'Receipt' });
    await expect(receipt).toBeVisible({ timeout: 30_000 });
    await receipt.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await hold(800);
    const harbor = receipt.getByRole('link', { name: 'Harbor & Co', exact: true }).first();
    await glide(page, harbor, { click: false });
    await hold(1800);
    await glide(page, harbor);
    await page.waitForLoadState('networkidle');
    await hold(3000);
  },
} satisfies Clip;
