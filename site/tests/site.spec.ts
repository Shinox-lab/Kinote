import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const hosted = JSON.parse(readFileSync(join(siteDir, 'hosted.json'), 'utf8')) as { url: string };
const clipsDir = join(siteDir, 'public', 'clips');
const recorded = new Set(existsSync(clipsDir) ? readdirSync(clipsDir) : []);
const IN_DEVELOPMENT = ['WhatsApp', 'Google Drive', 'MCP', 'Self-maintaining wiki', 'Space export'];

test('phone width has no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['./', 'guide/']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth, path).toBeLessThanOrEqual(innerWidth);
  }
});

test('Try Kinote goes to the hosted setting', async ({ page }) => {
  // The hosted URL is the live site's #hosted section; send it to this build instead.
  await page.route(`${new URL(hosted.url).origin}/**`, (route) =>
    route.fulfill({ status: 302, headers: { location: `http://localhost:4173${new URL(hosted.url).pathname}#hosted` } }),
  );
  await page.goto('./');
  const buttons = page.getByTestId('try-kinote');
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const href of await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href).toBe(hosted.url);
  }
  await buttons.first().click();
  await expect(page.locator('#hosted')).toBeInViewport();
});

test('in-development items are labelled', async ({ page }) => {
  await page.goto('./');
  for (const name of IN_DEVELOPMENT) {
    const item = page.locator('#features article').filter({ hasText: name });
    await expect(item, name).toHaveCount(1);
    await expect(item, name).toContainText('(In development)');
  }
});

test('every media URL resolves under the base path', async ({ page, request }) => {
  await page.goto('./');
  expect(await page.locator('video').count()).toBeGreaterThanOrEqual(8);
  const urls = await page.evaluate(() => [
    ...[...document.querySelectorAll('video')].flatMap((v) => [v.getAttribute('src'), v.getAttribute('poster')]),
    ...[...document.querySelectorAll('source, img')].map((e) => e.getAttribute('src')),
  ]);
  const media = urls.filter((u): u is string => !!u);
  expect(media.length).toBeGreaterThan(0);
  for (const url of media) {
    expect(url, url).toMatch(/^\/Kinote\//);
    const file = url.match(/^\/Kinote\/clips\/(.+)$/)?.[1];
    if (file && !recorded.has(file)) continue;
    const res = await request.get(new URL(url, 'http://localhost:4173').toString());
    expect(res.status(), url).toBe(200);
  }
});

test('reduced motion does not autoplay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./');
  const hero = page.getByTestId('hero-clip').locator('video');
  await expect(hero).toHaveAttribute('controls', /.*/);
  await page.waitForTimeout(500);
  expect(await hero.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});
