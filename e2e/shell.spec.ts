import { expect, test, type Locator, type Page } from '@playwright/test';
import { addMember, call, openAs, seedWorld, uploadViaApi } from './support.js';

const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Sidebar' });

test('the sidebar leads with Home, then Search, Reviews and Settings', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);

  const main = sidebar(page).getByRole('list', { name: 'Main' });
  await expect(main.getByRole('link')).toHaveText(['Home', 'Search', 'Reviews', 'Settings & members']);
  await expect(main.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  await main.getByRole('link', { name: 'Search' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${world.slug}/search$`));
  await expect(main.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
});

test('a member sees the tree but no Settings link', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const member = await addMember(request, world, 'Vera Viewer', 'viewer');
  const page = await openAs(browser, world, member);
  await page.goto(`/w/${world.slug}`);

  await expect(sidebar(page).getByRole('list', { name: 'Main' }).getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: 'Settings & members' })).toHaveCount(0);
});

test('the sidebar is a column on a desktop and a slide-over below 1024', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(`/w/${world.slug}`);
  await expect(sidebar(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open sidebar' })).toHaveCount(0);

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(sidebar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible();
});

test('the page breadcrumb and menu live in the top bar', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const { id: pageId } = await call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: world.spaceId, title: 'Notes', slug: `notes-${world.suffix}`, parent_id: null, markdown: 'Notes text.' },
  });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${pageId}`);

  const banner = page.getByRole('banner');
  await expect(banner.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  await expect(banner.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Notes');
  await expect(banner.getByRole('button', { name: 'Page actions' })).toBeVisible();
  // No second breadcrumb in the document column.
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(1);

  // The file's breadcrumb and menu use the same bar.
  const fileId = await uploadViaApi(request, world, world.owner, {
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Notes'),
  });
  await page.goto(`/w/${world.slug}/f/${fileId}`);
  await expect(page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: 'File actions' })).toBeVisible();
});

test('a long title keeps the page menu in reach', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const title = 'A very long page title that keeps going and going until the sidebar and the top bar have to truncate it';
  const { id: pageId } = await call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: world.spaceId, title, slug: `long-${world.suffix}`, parent_id: null, markdown: 'Long title.' },
  });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${pageId}`);

  await expect(page.getByRole('banner').getByRole('button', { name: 'Page actions' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
