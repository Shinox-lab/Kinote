import { expect, test } from '@playwright/test';
import { addMember, openAs, seedWorld } from './support.js';

test("Groups: see who is in a group, add someone who isn't, and remove someone from the list", async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const mei = await addMember(request, world, 'Mei Lin', 'editor');
  const jonah = await addMember(request, world, 'Jonah Okafor', 'editor');
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/admin/groups`);

  await page.getByLabel('New group name').fill('Design');
  await page.getByRole('button', { name: 'Create group' }).click();
  const row = page.getByRole('list', { name: 'Groups' }).getByRole('listitem').filter({ hasText: 'Design' });
  await row.getByRole('button', { name: 'Manage members' }).click();

  const members = row.getByRole('list', { name: 'Members of Design' });
  await expect(row.getByText('No one in this group yet.')).toBeVisible();

  for (const person of [mei, jonah]) {
    await row.getByRole('combobox', { name: 'Person' }).fill(person.user.email);
    await row.getByRole('option', { name: new RegExp(`^${person.user.name}`) }).click();
    await row.getByRole('button', { name: 'Add to group' }).click();
    await expect(members.getByText(person.user.name)).toBeVisible();
  }
  await expect(row).toContainText('2 members');
  // Someone already in the group isn't offered again.
  await row.getByRole('combobox', { name: 'Person' }).fill('Mei');
  await expect(row.getByRole('option', { name: /^Mei Lin/ })).toHaveCount(0);

  await members.getByRole('button', { name: 'Remove Mei Lin from Design' }).click();
  await expect(members.getByText('Mei Lin')).toHaveCount(0);
  await expect(members.getByText('Jonah Okafor')).toBeVisible();
  await expect(row).toContainText('1 member');
});
