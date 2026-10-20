import { expect, test } from '@playwright/test';
import {
  addMember,
  approveAll,
  fakePdf,
  openAs,
  searchPassages,
  seedWorld,
  treeLink,
  uploadPanel,
  uploadThroughMenu,
  uploadViaApi,
  waitForFileBadge,
} from './support.js';

const sidebar = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Sidebar' });

test('a file uploaded from the add menu is read, indexed and listed in the sidebar', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  await sidebar(page).getByRole('button', { name: 'Expand Docs' }).click();

  const file = fakePdf('Leave report.pdf', world.suffix, 'Employees get twenty days of leave.', 'Parental leave is sixteen weeks.');
  await uploadThroughMenu(page, 'Docs', [file]);

  const panel = uploadPanel(page);
  await expect(panel).toContainText('Leave report.pdf');
  await expect(panel).toContainText('Indexed · v1');
  const row = treeLink(page, 'Leave report.pdf');
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForURL(/\/f\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Leave report.pdf', level: 1 })).toBeVisible();
  await expect(page.getByRole('status', { name: 'File status: Indexed · v1' })).toBeVisible();
});

test('a replacement waits for review while the old version keeps answering search', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const reviewer = await addMember(request, world, 'Rita Reviewer', 'reviewer');
  const word = `zebra${world.suffix}`;
  const id = await uploadViaApi(request, world, world.owner, fakePdf('Policy.pdf', `${world.suffix}-1`, `The ${word} rule applies to all staff.`));

  const page = await openAs(browser, world, world.owner);
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('status', { name: 'File status: Not indexed (awaiting approval)' })).toBeVisible();
  // Nothing is searchable until it is approved.
  expect(await searchPassages(request, world, world.owner, word)).toEqual([]);

  await approveAll(request, world, reviewer);
  await expect.poll(() => searchPassages(request, world, world.owner, word)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('status', { name: 'File status: Indexed · v1' })).toBeVisible();

  // Replace: version 2 waits, version 1 still answers.
  const next = `giraffe${world.suffix}`;
  const replacement = fakePdf('Policy.pdf', `${world.suffix}-2`, `The ${next} rule replaces it.`);
  await page.getByLabel('Choose the replacement file').setInputFiles(replacement);
  await expect(page.getByRole('status', { name: 'File status: Indexed · v1, v2 awaiting approval' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Versions' }).getByRole('listitem')).toHaveCount(2);
  // Search always ranks something (it is hybrid), so look at what it returns rather than at whether it returns.
  const waiting = await searchPassages(request, world, world.owner, next);
  expect(waiting.length).toBeGreaterThan(0);
  expect(waiting.every((p) => p.startsWith('1: ') && p.includes(word))).toBe(true);

  await approveAll(request, world, reviewer);
  await expect
    .poll(async () => (await searchPassages(request, world, world.owner, next)).every((p) => p.startsWith('2: ') && p.includes(next)))
    .toBe(true);
  await page.reload();
  await expect(page.getByRole('status', { name: 'File status: Indexed · v2' })).toBeVisible();
});

test('a reviewer reads the text of a waiting file, approves it, and the chunk inspector shows how it was cut', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const reviewer = await addMember(request, world, 'Rita Reviewer', 'reviewer');
  const sentence = `Parental leave lasts sixteen weeks ${world.suffix}.`;
  const id = await uploadViaApi(
    request,
    world,
    world.owner,
    fakePdf('Handbook.pdf', world.suffix, 'Welcome to the company.', sentence)
  );
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');

  const page = await openAs(browser, world, reviewer);
  await page.goto(`/w/${world.slug}/reviews`);
  const item = page.getByRole('list', { name: 'Changes waiting for review' }).getByRole('listitem').filter({ hasText: 'Handbook.pdf' });
  await expect(item).toContainText('PDF ·');
  await expect(item.getByRole('button', { name: 'Show changes' })).toHaveCount(0);
  await item.getByRole('button', { name: 'Show text' }).click();
  await expect(item.getByText(sentence)).toBeVisible();
  await expect(item).toContainText('2 pages');
  await item.getByRole('button', { name: 'Approve' }).click();
  await expect(item).toHaveCount(0);

  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('status', { name: /File status: Indexed/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Show search chunks' }).click();
  const chunks = page.getByRole('list', { name: 'Chunks' });
  await expect(chunks).toContainText(sentence);
  await expect(chunks).toContainText('Page 2');
  await expect(page.getByText('Indexed · 2 pages', { exact: false })).toBeVisible();
});
