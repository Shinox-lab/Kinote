import { expect, test } from '@playwright/test';
import {
  badgeOf,
  createPageInSpace,
  openAs,
  runPageAction,
  seedWorld,
  textFile,
  typeAtEnd,
  uploadViaApi,
} from './support.js';

const sidebar = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('Home: greeting, Continue, grouped Updates and the search field; the sidebar has no feed', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const owner = await openAs(browser, world, world.owner);

  await createPageInSpace(owner, world, 'Home notes');
  await typeAtEnd(owner, 'Home notes content.');
  await expect(owner.getByRole('textbox').first()).toContainText('Home notes content');
  await runPageAction(owner, 'Index now');
  await expect(async () => {
    await expect(badgeOf(owner)).toHaveText('Indexed · v1', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  const file = await uploadViaApi(request, world, world.owner, textFile('Home file.txt', 'text/plain', 'A recent file.'));
  await owner.goto(`/w/${world.slug}`);

  await expect(owner.getByRole('heading', { name: 'Welcome back, Olive' })).toBeVisible();
  const recent = owner.getByRole('region', { name: 'Continue' });
  await expect(recent).toContainText('Home notes');
  await expect(recent).toContainText('Home file.txt');
  await expect(recent.getByRole('link')).toHaveCount(2);

  const updates = owner.getByRole('region', { name: 'Updates' });
  await expect(updates).toContainText('published v1 of Home notes');
  await expect(updates.getByRole('region', { name: 'Today' })).toBeVisible();
  await expect(sidebar(owner).getByRole('region', { name: 'Updates' })).toHaveCount(0);

  await owner.getByLabel('Search pages and files').fill('Home notes');
  await owner.getByLabel('Search pages and files').press('Enter');
  await expect(owner).toHaveURL(/\/search\?q=Home/);
  await expect(owner.getByLabel('Scope')).toHaveValue('');
  const results = owner.getByRole('region', { name: 'Search results' });
  await expect(results).toContainText('Home notes');
  await expect(results).toContainText('Docs');

  await owner.getByLabel('Scope').selectOption(world.spaceId);
  await expect(owner).toHaveURL(new RegExp(`space=${world.spaceId}`));
  await expect(owner.getByLabel('Scope')).toHaveValue(world.spaceId);
  await expect(owner.getByRole('region', { name: 'Search results' })).toContainText('Home notes');

  await owner.getByRole('button', { name: 'Get an answer' }).click();
  const answer = owner.getByRole('region', { name: 'Answer' });
  await expect(answer).toContainText('Answer · from');
  await expect(answer.getByRole('list', { name: 'Sources' })).toContainText('Home notes');

  // A new scope clears the answer and runs the new search.
  await owner.getByLabel('Scope').selectOption('');
  await expect(answer).toHaveCount(0);
  await expect(owner.getByLabel('Scope')).toHaveValue('');

  await owner.getByRole('link', { name: 'Home', exact: true }).click();
  await owner.getByRole('region', { name: 'Continue' }).getByRole('link', { name: /Home file\.txt/ }).click();
  await expect(owner.getByRole('heading', { name: 'Home file.txt', level: 1 })).toBeVisible();
  expect(file).toBeTruthy();
});

test('Home: Needs attention lists pages with unindexed changes, and drops them once indexed', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const owner = await openAs(browser, world, world.owner);
  await createPageInSpace(owner, world, 'Draft plan');
  await typeAtEnd(owner, 'Not indexed yet.');
  await expect(owner.getByRole('textbox').first()).toContainText('Not indexed yet');

  await owner.goto(`/w/${world.slug}`);
  const attention = owner.getByRole('region', { name: 'Needs attention' });
  const row = attention.getByRole('link', { name: /Draft plan/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Docs');
  await expect(row).toContainText(/Saved · indexing soon|unindexed/i);

  await row.click();
  await runPageAction(owner, 'Index now');
  await expect(async () => {
    await expect(badgeOf(owner)).toHaveText('Indexed · v1', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await owner.goto(`/w/${world.slug}`);
  await expect(owner.getByRole('region', { name: 'Needs attention' })).toHaveCount(0);
});
