import { expect, test } from '@playwright/test';
import {
  addMember,
  badgeOf,
  call,
  createPageInSpace,
  expectConnected,
  openAs,
  runPageAction,
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

test('the page icon: pick, show in the header and tree, keep on reload, clear', async ({ browser, request }) => {
  const page = await openAs(browser, world, ed);
  const pageId = await createPageInSpace(page, world, 'Launch notes');
  pagePath = new URL(page.url()).pathname;

  const workspace = page.getByRole('navigation', { name: 'Workspace' });
  const treeLink = workspace.getByRole('link', { name: 'Launch notes' });

  await expect(page.getByRole('heading', { level: 1, name: 'Launch notes' })).toBeVisible();
  await page.getByRole('button', { name: 'Change page icon' }).click();
  await page.getByRole('button', { name: 'Use 🚀' }).click();

  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveText('🚀');
  await expect(page.getByRole('button', { name: 'Change page icon' })).toBeFocused();
  await expect(treeLink).toContainText('🚀');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveText('🚀');
  await expect(treeLink).toContainText('🚀');

  // A failed save puts the old icon back in the header and the tree.
  await page.route('**/api/v1/pages/*', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) });
    } else {
      await route.continue();
    }
  });
  await page.getByRole('button', { name: 'Change page icon' }).click();
  await page.getByRole('button', { name: 'Use 🌱' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveText('🚀');
  await expect(treeLink).toContainText('🚀');
  await page.keyboard.press('Escape');
  await page.unroute('**/api/v1/pages/*');

  await page.getByRole('button', { name: 'Change page icon' }).click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('button', { name: 'Change page icon' })).not.toHaveText('🚀');
  await expect(page.getByRole('button', { name: 'Change page icon' })).toBeFocused();
  await expect(treeLink).not.toContainText('🚀');

  // An emoji the picker does not know is stored but renders as no icon.
  await call(request, `/pages/${pageId}`, {
    account: ed,
    tenantId: world.tenantId,
    method: 'PATCH',
    data: { icon: '🦄' },
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Change page icon' })).not.toHaveText('🦄');
  await expect(treeLink).not.toContainText('🦄');
  await call(request, `/pages/${pageId}`, {
    account: ed,
    tenantId: world.tenantId,
    method: 'PATCH',
    data: { icon: null },
  });
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

test('the writing surface: 660 wide, a 34px title, no sideways scroll at 1024', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  const longTitle = 'A long page title that must wrap inside the reading column without pushing the console sideways at any width';
  await createPageInSpace(page, world, longTitle);

  await page.setViewportSize({ width: 1440, height: 900 });
  const article = page.locator('article');
  await expect(page.getByRole('heading', { level: 1, name: longTitle })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('font-size', '34px');
  await expect(page.locator('.bn-editor')).toHaveCSS('font-size', '15.5px');
  expect((await article.boundingBox())?.width).toBeCloseTo(660, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => (await article.boundingBox())?.width ?? 0).toBeLessThanOrEqual(660);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the status chip, its actions and the page menu; no On this page panel', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  await createPageInSpace(page, world, 'Status notes');
  const chip = page.getByRole('button', { name: 'Page status and actions' });

  await typeAtEnd(page, 'Status notes content.');
  await expect(chip).toContainText('unindexed change');

  await chip.click();
  const changePopover = page.getByRole('dialog', { name: 'Page status and actions' });
  await changePopover.getByRole('button', { name: /^Changes/ }).click();
  const changeDrawer = page.getByRole('dialog', { name: 'Page history' });
  await expect(changeDrawer.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
  await expect(changeDrawer.getByRole('list', { name: 'Changed blocks' })).toContainText('Status notes content');
  const changesTab = changeDrawer.getByRole('tab', { name: 'Changes' });
  await changesTab.focus();
  await changesTab.press('ArrowRight');
  await expect(changeDrawer.getByRole('tab', { name: 'Versions' })).toHaveAttribute('aria-selected', 'true');
  await expect(changeDrawer.getByRole('tab', { name: 'Versions' })).toBeFocused();
  await expect(changeDrawer).toContainText('This page has no saved versions yet.');
  await page.keyboard.press('Escape');
  await expect(changeDrawer).toHaveCount(0);
  await expect(chip).toBeFocused();

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
  await popover.getByRole('button', { name: 'History' }).click();
  const historyDrawer = page.getByRole('dialog', { name: 'Page history' });
  await expect(historyDrawer.getByRole('tab', { name: 'Versions' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(historyDrawer).toHaveCount(0);
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

  // The top title renames in place too, not only the page menu and the sidebar.
  await page.getByRole('heading', { level: 1, name: 'Renamed notes' }).click();
  await page.getByLabel('New title').fill('Renamed from the title');
  await page.getByLabel('New title').press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Renamed from the title' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: /^Renamed from the title/ })
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

test('the page type scale: line-height, quiet headings, hairline tables and readable code', async ({ browser, request }) => {
  const created = await call<{ id: string }>(request, '/pages', {
    account: ed,
    tenantId: world.tenantId,
    method: 'POST',
    data: {
      space_id: world.spaceId,
      title: 'Typographic specimen',
      slug: 'typographic-specimen',
      markdown:
        '## A section\n\nBody text.\n\n> A quote.\n\n| Term | Meaning |\n| --- | --- |\n| Alpha | First |\n\n```ts\nconst answer = 42;\n```\n',
    },
  });
  const page = await openAs(browser, world, ed);
  await page.goto(`/w/${world.slug}/p/${created.id}`);
  await expectConnected(page);

  const heading = page.locator('.bn-block-content[data-content-type="heading"][data-level="2"]').first();
  await expect(heading).toHaveCSS('font-size', '19px');
  await expect(heading).toHaveCSS('font-weight', '600');

  const paragraph = page.locator('.bn-block-content[data-content-type="paragraph"]').first();
  await expect(paragraph).toHaveCSS('font-size', '15.5px');
  await expect(paragraph).toHaveCSS('line-height', /^26\./);

  const quote = page.locator('.bn-block-content[data-content-type="quote"] blockquote').first();
  await expect(quote).toHaveCSS('border-left-width', '2px');

  const cell = page.locator('.bn-block-content[data-content-type="table"] td').first();
  await expect(cell).toHaveCSS('border-top-width', '0px');
  await expect(cell).toHaveCSS('border-bottom-width', '1px');
  const headCell = page.locator('.bn-block-content[data-content-type="table"] th').first();
  await expect(headCell).toHaveCSS('text-transform', 'uppercase');

  // Index it first: the newly created blocks wear the changed-block wash until the snapshot is indexed.
  await runPageAction(page, 'Index now');
  await expect(async () => {
    await expect(badgeOf(page)).toHaveText('Indexed · v1', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  const code = page.locator('.bn-block-content[data-content-type="codeBlock"]').first();
  await expect(code).toHaveCSS('background-color', 'rgb(245, 242, 237)');
  await expect(code.locator('pre')).toHaveCSS('color', 'rgb(36, 33, 29)');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(code).toHaveCSS('background-color', 'rgb(20, 18, 16)');
  await expect(code.locator('pre')).toHaveCSS('color', 'rgb(236, 230, 221)');
});

test('the page on a phone: 26px title, 30px emoji, no visible index button, no editor gutter', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  await page.setViewportSize({ width: 390, height: 844 });
  await createPageInSpace(page, world, 'Phone notes');

  await expect(page.getByRole('heading', { level: 1, name: 'Phone notes' })).toHaveCSS('font-size', '26px');
  await expect(page.getByRole('button', { name: 'Change page icon' })).toHaveCSS('width', '30px');
  await expect(page.getByRole('banner')).toHaveCSS('height', '48px');
  await expect(page.locator('.bn-editor')).toHaveCSS('padding-left', '0px');
  await expect(page.getByRole('button', { name: 'Page actions' })).toBeVisible();

  const chip = page.getByRole('button', { name: 'Page status and actions' });
  await typeAtEnd(page, 'Phone content.');
  await expect(chip).toContainText('unindexed change');
  await expect(page.getByRole('button', { name: 'Index now' })).toHaveCount(0);
  await chip.click();
  await expect(
    page.getByRole('dialog', { name: 'Page status and actions' }).getByRole('button', { name: 'Index now' })
  ).toBeVisible();
});
