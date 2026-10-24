import { expect, test } from '@playwright/test';
import { addMember, createPageInSpace, editorOf, expectConnected, openAs, seedWorld, typeAtEnd } from './support.js';

test('a viewer sees the page read-only, without Submit', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const viewer = await addMember(request, world, 'Vera Viewer', 'viewer');

  // The owner writes the page so there is something to read.
  const owner = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(owner, world, 'Leave policy');
  await typeAtEnd(owner, 'Employees get twenty days of leave.');
  await expect(editorOf(owner)).toContainText('twenty days of leave');
  await owner.getByRole('button', { name: 'Page status and actions' }).click();
  await expect(
    owner
      .getByRole('dialog', { name: 'Page status and actions' })
      .getByRole('button', { name: 'Submit for review' })
  ).toBeVisible();

  const page = await openAs(browser, world, viewer);
  await page.goto(`/w/${world.slug}/p/${pageId}`);
  await expectConnected(page);
  await expect(page.getByRole('heading', { name: 'Leave policy' })).toBeVisible();
  // The content reaches the viewer, who cannot change it.
  await expect(editorOf(page)).toContainText('twenty days of leave');
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByText('Read only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit for review' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Index now' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Page actions' })).toHaveCount(0);

  // Typing into it changes nothing, here or for the owner.
  await editorOf(page).click();
  await page.keyboard.type('VIEWER-TEXT');
  await expect(editorOf(page)).not.toContainText('VIEWER-TEXT');
  // An edit by the owner reaches the viewer, so the sync works in both directions and nothing of the viewer's came with it.
  await typeAtEnd(owner, ' Sentinel.');
  await expect(editorOf(page)).toContainText('Sentinel.');
  await expect(editorOf(page)).not.toContainText('VIEWER-TEXT');
  await expect(editorOf(owner)).not.toContainText('VIEWER-TEXT');
});
