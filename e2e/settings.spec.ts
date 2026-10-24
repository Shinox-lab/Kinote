import { expect, test } from '@playwright/test';
import { openAs, seedWorld } from './support.js';

test('Settings: the tabs, members, a space pane and sources', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/admin/members`);

  await expect(page.getByRole('banner')).toContainText('Settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Settings' });
  await expect(tabs.getByRole('link')).toHaveText(['Members', 'Groups', 'Spaces', 'Sources']);

  await expect(page.getByText('1 person in this workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite someone' })).toBeVisible();
  const members = page.getByRole('list', { name: /^Members of / });
  await expect(members).toContainText('Olive Owner');
  await expect(members.getByText('🔒 Owner')).toBeVisible();

  await tabs.getByRole('link', { name: 'Groups' }).click();
  await expect(page.getByLabel('New group name')).toBeVisible();

  await tabs.getByRole('link', { name: 'Spaces' }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'New space' })).toBeVisible();
  await page.getByRole('list', { name: 'Spaces' }).getByRole('button', { name: /^Docs/ }).click();
  const pane = page.getByRole('region', { name: 'Settings for Docs' });
  await expect(pane).toContainText('URL slug /docs');
  await expect(pane.getByLabel('Name')).toHaveValue('Docs');
  await expect(pane.getByRole('button', { name: 'Manage access' })).toBeVisible();

  await tabs.getByRole('link', { name: 'Sources' }).click();
  await expect(page.getByRole('button', { name: 'Add source' })).toBeVisible();
  await expect(page.getByText('No sources yet.')).toBeVisible();

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Members' })).toBeVisible();
});
