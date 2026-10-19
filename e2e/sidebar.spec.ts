import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  addMember,
  call,
  editorOf,
  expectConnected,
  openAs,
  seedWorld,
  typeAtEnd,
  type Account,
  type World,
} from './support.js';

/** The sidebar region of a page. */
const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Sidebar' });

/** A page through the api (fast); the specs assert what the sidebar then shows. */
async function makePage(
  request: Parameters<typeof call>[0],
  world: World,
  account: Account,
  title: string,
  slug: string,
  opts: { parentId?: string | null; spaceId?: string } = {}
): Promise<string> {
  const page = await call<{ id: string }>(request, '/pages', {
    account,
    tenantId: world.tenantId,
    method: 'POST',
    data: {
      space_id: opts.spaceId ?? world.spaceId,
      title,
      slug,
      parent_id: opts.parentId ?? null,
      markdown: `${title} text.`,
    },
  });
  return page.id;
}

const snapshot = (request: Parameters<typeof call>[0], world: World, account: Account, pageId: string) =>
  call(request, `/pages/${pageId}/snapshot`, { account, tenantId: world.tenantId, method: 'POST', data: {} });

test('the tree: open a space, open a page from it, see its status dot and the review count', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: true });
  const hr = await makePage(request, world, world.owner, 'HR', 'hr');
  const leave = await makePage(request, world, world.owner, 'Leave policy', 'leave-policy', { parentId: hr });
  await snapshot(request, world, world.owner, leave);

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  const side = sidebar(page);

  // Nothing is fetched or shown until the space is opened.
  await expect(side.getByRole('link', { name: 'HR', exact: true })).toHaveCount(0);
  await side.getByRole('button', { name: 'Expand Docs' }).click();
  await side.getByRole('button', { name: 'Expand HR' }).click();
  // The tree row's name starts with the title; an Updates row starts with who did it.
  const row = side.getByRole('link', { name: /^Leave policy/ });
  // A page held for review wears the amber dot, named in words.
  await expect(row.getByRole('img', { name: 'Waiting for review' })).toBeVisible();
  // The Reviews count is the same queue the Reviews screen shows.
  await expect(side.getByRole('link', { name: /^Reviews/ })).toContainText('1 waiting');

  await row.click();
  await page.waitForURL(new RegExp(`/p/${leave}$`));
  await expect(row).toHaveAttribute('aria-current', 'page');

  // A folder can be closed even over the page being read, and a reload reveals the page again.
  await side.getByRole('button', { name: 'Collapse HR' }).click();
  await expect(side.getByRole('button', { name: 'Expand HR' })).toBeVisible();
  await page.reload();
  await expect(side.getByRole('button', { name: 'Collapse HR' })).toBeVisible();
  await expect(side.getByRole('link', { name: /^Leave policy/ })).toHaveAttribute('aria-current', 'page');

  // A space the person closed stays closed across a reload on a screen that is not inside it.
  await page.goto(`/w/${world.slug}`);
  await side.getByRole('button', { name: 'Collapse Docs' }).click();
  await page.reload();
  await expect(side.getByRole('button', { name: 'Expand Docs' })).toBeVisible();
});

test('adding a page from the sidebar opens it', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  const side = sidebar(page);
  await side.getByRole('button', { name: 'Expand Docs' }).click();
  await side.getByRole('link', { name: 'Docs', exact: true }).hover();
  await side.getByRole('button', { name: 'Add a page to Docs' }).click();
  await page.getByLabel('New page title').fill('Brand new page');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  await expect(side.getByRole('link', { name: 'Brand new page' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Brand new page', level: 1 })).toBeVisible();
});

test('updates show what others did, and your own changes read "You"; typing shows the edited dot', async ({
  browser,
  request,
}) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const eli = await addMember(request, world, 'Eli Editor', 'editor');
  const notes = await makePage(request, world, world.owner, 'Notes', 'notes');

  const a = await openAs(browser, world, world.owner);
  await a.goto(`/w/${world.slug}/p/${notes}`);
  await expectConnected(a);

  const b = await openAs(browser, world, eli);
  await b.goto(`/w/${world.slug}/p/${notes}`);
  await expectConnected(b);
  await typeAtEnd(b, ' Eli was here.');
  await expect(editorOf(b)).toContainText('Eli was here');

  // A page that is being edited shows the purple dot (the tree asks again on a reload).
  await expect(async () => {
    await a.reload();
    await expect(sidebar(a).getByRole('img', { name: 'Edited just now' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // Eli publishes; the owner's Updates names Eli, Eli's own reads "You".
  await b.getByRole('button', { name: 'Index now' }).click();
  await expect(async () => {
    await a.reload();
    await expect(sidebar(a).getByRole('region', { name: 'Updates' })).toContainText('Eli Editor published v1 of Notes', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(async () => {
    await b.reload();
    await expect(sidebar(b).getByRole('region', { name: 'Updates' })).toContainText('You published v1 of Notes', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });

  // The update is a link to the page.
  await sidebar(a).getByRole('region', { name: 'Updates' }).getByRole('link', { name: /Notes/ }).click();
  await a.waitForURL(new RegExp(`/p/${notes}$`));
});

test("someone else's Inbox page is in neither the tree nor Updates, but the creator and an admin see it", async ({
  browser,
  request,
}) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const eli = await addMember(request, world, 'Eli Editor', 'editor');
  const vera = await addMember(request, world, 'Vera Viewer', 'viewer');
  const spaces = await call<Array<{ id: string; kind: string }>>(request, '/spaces', {
    account: eli,
    tenantId: world.tenantId,
  });
  const inbox = spaces.find((s) => s.kind === 'inbox')!;
  const secret = await makePage(request, world, eli, 'Private note', 'private-note', { spaceId: inbox.id });
  await snapshot(request, world, eli, secret);
  // A page everyone can read, so Updates has something to show Vera.
  const shared = await makePage(request, world, world.owner, 'Shared page', 'shared-page');
  await snapshot(request, world, world.owner, shared);

  const owner = await openAs(browser, world, world.owner);
  await owner.goto(`/w/${world.slug}`);
  await expect(async () => {
    await owner.reload();
    await expect(sidebar(owner).getByRole('region', { name: 'Updates' })).toContainText('Private note', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await sidebar(owner).getByRole('button', { name: 'Expand Inbox' }).click();
  await expect(sidebar(owner).getByRole('link', { name: 'Private note' })).toBeVisible();

  const mine = await openAs(browser, world, eli);
  await mine.goto(`/w/${world.slug}`);
  await sidebar(mine).getByRole('button', { name: 'Expand Inbox' }).click();
  await expect(sidebar(mine).getByRole('link', { name: 'Private note' })).toBeVisible();

  const viewer = await openAs(browser, world, vera);
  await viewer.goto(`/w/${world.slug}`);
  const updates = sidebar(viewer).getByRole('region', { name: 'Updates' });
  await expect(updates).toContainText('Shared page');
  await sidebar(viewer).getByRole('button', { name: 'Expand Inbox' }).click();
  await expect(sidebar(viewer).getByText('No pages yet')).toBeVisible();
  await expect(sidebar(viewer).getByRole('link', { name: 'Private note' })).toHaveCount(0);
  await expect(updates).not.toContainText('Private note');
});

test('the theme: choose dark, it survives a reload, and System follows the operating system', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`/w/${world.slug}`);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await expect.poll(theme).toBe('light');

  await sidebar(page).getByRole('button', { name: 'Dark' }).click();
  await expect.poll(theme).toBe('dark');
  await page.reload();
  // No flash: the page is dark as soon as it loads, and the choice is still marked.
  await expect.poll(theme).toBe('dark');
  await expect(sidebar(page).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');

  await sidebar(page).getByRole('button', { name: 'System' }).click();
  await expect.poll(theme).toBe('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(theme).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(theme).toBe('light');
});

test('a phone: the sidebar is a slide-over that closes on navigation and on Escape', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/w/${world.slug}`);
  await expect(sidebar(page)).toHaveCount(0);

  const opener = page.getByRole('button', { name: 'Open sidebar' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Sidebar' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('link', { name: 'Search' }).click();
  await page.waitForURL(/\/search$/);
  await expect(dialog).toHaveCount(0);

  await opener.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('on a wide screen Ctrl+\\ hides and shows the sidebar', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}`);
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Control+\\');
  await expect(sidebar(page)).toHaveCount(0);
  await page.reload();
  await expect(sidebar(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(sidebar(page)).toBeVisible();
});
