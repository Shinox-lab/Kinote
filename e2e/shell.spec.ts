import { expect, test, type Locator, type Page } from '@playwright/test';
import { addMember, openAs, seedWorld } from './support.js';

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
