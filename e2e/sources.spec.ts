import { expect, test } from '@playwright/test';
import {
  addMember,
  approveAll,
  deleteAsSource,
  expandSpace,
  fakePdf,
  makeSource,
  openAs,
  putAsSource,
  seedWorld,
  treeLink,
  waitForFileBadge,
} from './support.js';

const sidebar = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('an admin adds a source and a token, sees the token once, and a script can use it', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/admin/sources`);
  await expect(page.getByRole('link', { name: 'Sources' })).toBeVisible();

  await page.getByLabel('Source name').fill('Reports bot');
  await page.getByRole('button', { name: 'Add source' }).click();
  const panel = page.getByRole('region', { name: 'Source Reports bot' });
  await expect(panel).toContainText('Delivers to Docs');
  await expect(panel).toContainText('Not trusted');

  await panel.getByLabel('Token name').fill('nightly export');
  await panel.getByRole('button', { name: 'New token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Token for Reports bot' });
  await expect(dialog).toContainText('This token is shown once. It cannot be shown again.');
  const token = await dialog.getByLabel('The new token').inputValue();
  expect(token).toMatch(/^lwsrc_[0-9a-f]{32}\./);
  await expect(dialog).toContainText(`Authorization: Bearer ${token}`);
  await expect(dialog).toContainText('/api/v1/source/files/reports/2026-q3');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  // Gone from the page, from a reload, and the list only knows its first characters.
  expect(await page.content()).not.toContain(token);
  await page.reload();
  expect(await page.content()).not.toContain(token);
  const row = page.getByRole('list', { name: 'Tokens of Reports bot' }).getByRole('listitem');
  await expect(row).toContainText('nightly export');
  await expect(row).toContainText(`${token.split('.')[1]!.slice(0, 8)}…`);
  await expect(row).toContainText('Never used');

  // The script sends a file; it lands in the space as a file row, waiting for review (an untrusted source).
  const sent = await putAsSource(request, token, 'reports/q3', fakePdf('Q3.pdf', world.suffix, `Quarter three revenue ${world.suffix}.`));
  expect(sent.status).toBe(201);
  expect(sent.body.created).toBe(true);
  await waitForFileBadge(request, world, world.owner, sent.body.document!.id, 'Not indexed (awaiting approval)');
  await page.goto(`/w/${world.slug}`);
  await expandSpace(page, 'Docs');
  await expect(treeLink(page, 'Q3.pdf')).toBeVisible();
  await expect(sidebar(page)).toContainText('System · Reports bot');
  // And the token has been used.
  await page.goto(`/w/${world.slug}/admin/sources`);
  await expect(page.getByRole('list', { name: 'Tokens of Reports bot' })).toContainText('Used');
});

test('a synced file: new versions, removal at the source, dismissing it, and a revoked token', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const { token } = await makeSource(request, world, { name: 'Wiki sync' });
  const first = await putAsSource(request, token, 'handbook', fakePdf('Handbook.pdf', `${world.suffix}-1`, 'Version one text.'));
  const id = first.body.document!.id;
  // An untrusted source waits for review; the owner approves it.
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');
  await approveAll(request, world, world.owner);
  await waitForFileBadge(request, world, world.owner, id, 'Indexed · v1');

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByText('Kept in sync by a source: replace it there.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replace file' })).toHaveCount(0);

  // The same bytes change nothing; different bytes are version 2.
  expect((await putAsSource(request, token, 'handbook', fakePdf('Handbook.pdf', `${world.suffix}-1`, 'Version one text.'))).body.unchanged).toBe(true);
  const second = await putAsSource(request, token, 'handbook', fakePdf('Handbook.pdf', `${world.suffix}-2`, 'Version two text.'));
  expect(second.status).toBe(201);
  await approveAll(request, world, world.owner).catch(() => 0);
  await page.reload();
  await page.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByRole('list', { name: 'Versions' }).getByRole('listitem')).toHaveCount(2);

  // The script removes it: the file says so, and an editor can dismiss it.
  expect(await deleteAsSource(request, token, 'handbook')).toBe(200);
  await page.reload();
  await expect(page.getByRole('status', { name: 'File status: Removed at source' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText('This file was removed at its source.');
  await page.getByRole('button', { name: 'File actions' }).click();
  await page.getByRole('button', { name: /^Dismiss/ }).click();
  await page.goto(`/w/${world.slug}`);
  await expandSpace(page, 'Docs');
  await expect(treeLink(page, 'Handbook.pdf')).toHaveCount(0);

  // Revoking the token in the console stops the script at once.
  await page.goto(`/w/${world.slug}/admin/sources`);
  const tokens = page.getByRole('list', { name: 'Tokens of Wiki sync' });
  await tokens.getByRole('button', { name: 'Revoke e2e' }).click();
  await tokens.getByRole('button', { name: 'Confirm revoking e2e' }).click();
  await expect(tokens).toContainText('Revoked');
  const refused = await putAsSource(request, token, 'again', fakePdf('Again.pdf', world.suffix, 'x'));
  expect(refused.status).toBe(401);
});

test('a member does not see Sources, and its address says so', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const member = await addMember(request, world, 'Edith Editor', 'editor');
  const page = await openAs(browser, world, member);
  await page.goto(`/w/${world.slug}/admin/sources`);
  await expect(page.getByText("You don't have access")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sources' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add source' })).toHaveCount(0);
});
