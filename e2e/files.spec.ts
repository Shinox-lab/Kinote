import { expect, test } from '@playwright/test';
import {
  addMember,
  approveAll,
  fakePdf,
  fakePng,
  openAs,
  searchPassages,
  seedWorld,
  textFile,
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

test('text and image files open in place', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const text = await uploadViaApi(request, world, world.owner, textFile('Notes.txt', 'text/plain', `First line ${world.suffix}\nSecond line <b>not bold</b>`));
  const image = await uploadViaApi(request, world, world.owner, fakePng('Diagram.png', world.suffix, 'A diagram of the process.'));
  await waitForFileBadge(request, world, world.owner, text, /^Indexed/);
  await waitForFileBadge(request, world, world.owner, image, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/f/${text}`);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview).toContainText(`First line ${world.suffix}`);
  // Markup in a text file is shown as text, never rendered.
  await expect(preview).toContainText('<b>not bold</b>');
  await expect(preview.locator('b')).toHaveCount(0);

  await page.goto(`/w/${world.slug}/f/${image}`);
  const img = page.getByRole('img', { name: 'Diagram.png' });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // Download goes through the session, not a link with a token in it.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('Diagram.png');
});

test('a viewer sees only what is published: nothing while the file waits for review, then the file', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const reviewer = await addMember(request, world, 'Rita Reviewer', 'reviewer');
  const viewer = await addMember(request, world, 'Vera Viewer', 'viewer');
  const sentence = `Held back until approved ${world.suffix}.`;
  const id = await uploadViaApi(request, world, world.owner, fakePdf('Draft.pdf', world.suffix, sentence));
  await waitForFileBadge(request, world, world.owner, id, 'Not indexed (awaiting approval)');

  const page = await openAs(browser, world, viewer);
  const bytesRequests: string[] = [];
  page.on('request', (r) => {
    if (/\/versions\/[^/]+\/(file|text|chunks)/.test(r.url())) bytesRequests.push(r.url());
  });
  await page.goto(`/w/${world.slug}/f/${id}`);
  await expect(page.getByRole('heading', { name: 'Draft.pdf', level: 1 })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText('Nothing has been published yet.');
  await expect(page.getByRole('region', { name: 'Preview' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Search chunks' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'File actions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replace file' })).toHaveCount(0);
  expect(bytesRequests).toEqual([]);

  await approveAll(request, world, reviewer);
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Search chunks' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});
