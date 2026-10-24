import { expect, test } from '@playwright/test';
import { addMember, createPageInSpace, openAs, seedWorld, type Account, type World } from './support.js';

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
});
