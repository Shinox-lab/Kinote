import { expect, test } from '@playwright/test';
import {
  addMember,
  badgeOf,
  createPageInSpace,
  openAs,
  seedWorld,
  typeAtEnd,
  type Account,
  type World,
} from './support.js';

test.describe.configure({ mode: 'serial' });

let world: World;
let ed: Account;
let viewer: Account;
let pagePath: string;

test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  world = await seedWorld(request, { reviewRequired: false });
  ed = await addMember(request, world, 'Ed Editor', 'editor');
  viewer = await addMember(request, world, 'Val Viewer', 'viewer');
  await request.dispose();
});

test('the page icon: pick, show in the header and tree, keep on reload, clear', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  await createPageInSpace(page, world, 'Launch notes');
  pagePath = new URL(page.url()).pathname;

  const workspace = page.getByRole('navigation', { name: 'Workspace' });
  const treeLink = workspace.getByRole('link', { name: 'Launch notes' });

  await expect(page.getByRole('heading', { level: 1, name: 'Launch notes' })).toBeVisible();
  await page.getByRole('button', { name: 'Change page icon' }).click();
  await page.getByRole('button', { name: 'Use 🚀' }).click();

  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveText('🚀');
  await expect(treeLink).toContainText('🚀');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveText('🚀');
  await expect(treeLink).toContainText('🚀');

  await page.getByRole('button', { name: 'Change page icon' }).click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('button', { name: 'Change page icon' })).not.toHaveText('🚀');
  await expect(treeLink).not.toContainText('🚀');
});

test('a viewer sees the page icon but cannot change it', async ({ browser }) => {
  const page = await openAs(browser, world, viewer);
  await page.goto(pagePath);

  await expect(page.getByRole('heading', { level: 1, name: 'Launch notes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveCount(0);

  const chip = page.getByRole('button', { name: 'Page status and actions' });
  await expect(chip).toBeVisible();
  await chip.click();
  const popover = page.getByRole('dialog', { name: 'Page status and actions' });
  await expect(popover.getByRole('button', { name: 'History' })).toBeVisible();
  await expect(popover.getByRole('button', { name: /Index now|Submit for review/ })).toHaveCount(0);
});

test('the status chip, its actions and the page menu; no On this page panel', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  await createPageInSpace(page, world, 'Status notes');
  const chip = page.getByRole('button', { name: 'Page status and actions' });

  await typeAtEnd(page, 'Status notes content.');
  await expect(chip).toContainText('unindexed change');
  await page.getByRole('button', { name: 'Index now' }).click();
  await expect(async () => {
    await expect(badgeOf(page)).toHaveText('Indexed · v1', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Index now' })).toHaveCount(0);

  await chip.click();
  const popover = page.getByRole('dialog', { name: 'Page status and actions' });
  await expect(popover.getByRole('button', { name: 'Index now' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'History' })).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Changes (0)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(page.getByText('On this page')).toHaveCount(0);

  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('button', { name: 'Rename…' }).click();
  await page.getByLabel('New title').fill('Renamed notes');
  await page.getByLabel('New title').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Renamed notes' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: /^Renamed notes/ })
  ).toBeVisible();

  const ownerPage = await openAs(browser, world, world.owner);
  await ownerPage.goto(new URL(page.url()).pathname);
  await ownerPage.getByRole('button', { name: 'Page actions' }).click();
  await ownerPage.getByRole('button', { name: 'Archive…' }).click();
  await ownerPage.getByRole('button', { name: 'Archive page' }).click();
  await expect(ownerPage.getByRole('button', { name: 'Restore page' })).toBeVisible();
  await expect(ownerPage.getByText('Archived', { exact: true })).toBeVisible();

  await ownerPage.getByRole('button', { name: 'Restore page' }).click();
  await expect(ownerPage.getByRole('button', { name: 'Restore page' })).toHaveCount(0);
});
