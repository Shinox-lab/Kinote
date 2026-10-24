import { expect, test } from '@playwright/test';
import {
  addMember,
  createPageInSpace,
  openAs,
  runPageAction,
  seedWorld,
  textFile,
  typeAtEnd,
  uploadViaApi,
  waitForFileBadge,
} from './support.js';

test('the review queue on a phone opens its detail full-screen with a back control', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const editor = await addMember(request, world, 'Ed Editor', 'editor');
  const reviewer = await addMember(request, world, 'Rae Reviewer', 'reviewer');

  const edPage = await openAs(browser, world, editor);
  await createPageInSpace(edPage, world, 'Phone review');
  await typeAtEnd(edPage, 'A change to review on a phone.');
  await runPageAction(edPage, 'Submit for review');

  const page = await openAs(browser, world, reviewer);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${world.slug}/reviews`);

  const queue = page.getByRole('list', { name: 'Changes waiting for review' });
  await expect(queue).toBeVisible();
  await expect(page.getByRole('region', { name: 'Review detail' })).toHaveCount(0);
  await queue.getByRole('listitem').filter({ hasText: 'Phone review' }).getByRole('button').click();

  await expect(page).toHaveURL(/review=/);
  const detail = page.getByRole('region', { name: 'Review detail' });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Full document' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(queue).toHaveCount(0);

  await page.getByRole('button', { name: /Back to reviews/ }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${world.slug}/reviews$`));
  await expect(queue).toBeVisible();
  await expect(detail).toHaveCount(0);

  // Approving the only waiting item clears the review param and says what happened.
  await queue.getByRole('listitem').filter({ hasText: 'Phone review' }).getByRole('button').click();
  await page.getByRole('region', { name: 'Review detail' }).getByRole('button', { name: 'Approve' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${world.slug}/reviews$`));
  await expect(page.getByText('Nothing is waiting for your review.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Approved version 1 of Phone review.');
});

test('Settings on a phone: the tabs scroll and the space pane is a full-screen sheet', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${world.slug}/admin/spaces`);

  const tabs = page.getByRole('navigation', { name: 'Settings' });
  await expect(tabs.getByRole('link', { name: 'Sources' })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'New space' }).click();
  const close = page.getByRole('button', { name: 'Close' });
  await expect(close).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create a space' })).toBeVisible();
  await close.click();
  await expect(page.getByRole('heading', { name: 'Create a space' })).toHaveCount(0);
});

test('the file on a phone: Info opens the rail and Download is in the menu', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const id = await uploadViaApi(
    request,
    world,
    world.owner,
    textFile('Phone file.txt', 'text/plain', 'A phone file.')
  );
  await waitForFileBadge(request, world, world.owner, id, /^Indexed/);

  const page = await openAs(browser, world, world.owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${world.slug}/f/${id}`);

  await expect(page.getByRole('heading', { name: 'Phone file.txt', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Info' }).click();
  const sheet = page.getByRole('dialog', { name: 'File information' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('tab', { name: /^Versions/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await page.getByRole('button', { name: 'File actions' }).click();
  await expect(page.locator('#file-actions').getByRole('button', { name: 'Download' })).toBeVisible();
});

test('Home and Search on a phone: the stacked layout and the scope beneath the field', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${world.slug}`);

  await expect(page.getByRole('heading', { name: 'Welcome back, Olive' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload files' })).toBeVisible();
  await expect(page.getByLabel('Search pages and files')).toBeVisible();

  await page.getByLabel('Search pages and files').fill('leave');
  await page.getByLabel('Search pages and files').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=leave/);
  await expect(page.getByLabel('Scope')).toBeVisible();
});
