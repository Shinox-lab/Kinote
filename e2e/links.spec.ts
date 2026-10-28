import { expect, test } from '@playwright/test';
import { addMember, call, createPageInSpace, editorOf, openAs, seedWorld, typeAtEnd, type Account, type World } from './support.js';

test.describe.configure({ mode: 'serial' });

let world: World;
let ed: Account;

test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  world = await seedWorld(request, { reviewRequired: false });
  ed = await addMember(request, world, 'Ed Editor', 'editor');
  await request.dispose();
});

const newPage = (request: Parameters<typeof call>[0], title: string, slug: string) =>
  call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: world.spaceId, title, slug: `${slug}-${world.suffix}`, markdown: `${title} body.` },
  });

test('[[ links a page; the link follows a rename, opens in the side panel, and shows as a backlink', async ({ browser, request }) => {
  const target = await newPage(request, 'Client George', 'client-george');
  const page = await openAs(browser, world, ed);
  const linkerId = await createPageInSpace(page, world, 'Weekly notes');

  await typeAtEnd(page, 'See [[Client Geo');
  const menu = page.getByRole('listbox');
  await expect(menu.getByRole('option', { name: /Client George/ })).toBeVisible();
  await page.keyboard.press('Enter');
  const link = editorOf(page).locator(`[data-page-link="${target.id}"]`);
  await expect(link).toHaveText('Client George');

  // The link shows the target's current title.
  await call(request, `/pages/${target.id}`, {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'PATCH',
    data: { title: 'Client George (renamed)' },
  });
  await page.reload();
  await expect(editorOf(page).locator(`[data-page-link="${target.id}"]`)).toHaveText('Client George (renamed)');

  // A click opens the side panel; Escape closes it.
  await editorOf(page).locator(`[data-page-link="${target.id}"]`).click();
  const peek = page.getByRole('complementary', { name: 'Page preview' });
  await expect(peek.getByRole('heading', { level: 1, name: 'Client George (renamed)' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`peek=${target.id}`));
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);

  // Once the linking page is snapshotted, the target lists it.
  await expect(async () => {
    await call(request, `/pages/${linkerId}/snapshot`, { account: world.owner, tenantId: world.tenantId, method: 'POST' }).catch(
      () => undefined
    );
    const c = await call<{ linkedFrom: Array<{ pageId: string }> }>(request, `/pages/${target.id}/connections`, {
      account: ed,
      tenantId: world.tenantId,
    });
    expect(c.linkedFrom.map((l) => l.pageId)).toContain(linkerId);
  }).toPass({ timeout: 30_000 });
  await page.goto(`/w/${world.slug}/p/${target.id}`);
  const connections = page.getByRole('region', { name: 'Connections' });
  await expect(connections.getByRole('link', { name: /Weekly notes/ })).toContainText('See Client George');
  await connections.getByRole('link', { name: /Weekly notes/ }).click();
  await expect(page.getByRole('complementary', { name: 'Page preview' }).getByRole('heading', { name: 'Weekly notes' })).toBeVisible();
});

test('the slash menu makes a linked sub-page', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  await createPageInSpace(page, world, 'Parent for sub-page');
  await typeAtEnd(page, '/sub-page');
  await page.getByRole('option', { name: /New sub-page/ }).click();
  const link = editorOf(page).locator('[data-page-link]');
  await expect(link).toHaveText('Untitled');
  // The new page is a child of this one: it opens from the link.
  await link.click();
  await expect(page.getByRole('complementary', { name: 'Page preview' }).getByRole('heading', { level: 1, name: 'Untitled' })).toBeVisible();
});

test('a link to a page the reader cannot open says so, without its title', async ({ browser, request }) => {
  const hidden = await call<{ id: string }>(request, '/spaces', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { name: `Private ${world.suffix}`, slug: `private-${world.suffix}` },
  });
  const secret = await call<{ id: string }>(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: { space_id: hidden.id, title: 'Secret plan', slug: `secret-${world.suffix}`, markdown: 'x' },
  });
  await call(request, '/pages', {
    account: world.owner,
    tenantId: world.tenantId,
    method: 'POST',
    data: {
      space_id: world.spaceId,
      title: 'Points at secret',
      slug: `points-${world.suffix}`,
      markdown: `Look at [Secret plan](/p/${secret.id}).`,
    },
  });
  const page = await openAs(browser, world, ed);
  await page.goto(`/w/${world.slug}/s/${world.spaceSlug}`);
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Points at secret' }).click();
  const link = editorOf(page).locator(`[data-page-link="${secret.id}"]`);
  await expect(link).toHaveText('Page unavailable');
  await expect(editorOf(page)).not.toContainText('Secret plan');
});

test('the slash menu makes a callout; its emoji changes on click', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  await createPageInSpace(page, world, 'Callout page');
  await typeAtEnd(page, '/callout');
  await page.getByRole('option', { name: /^Callout/ }).click();
  await page.keyboard.type('Mind the gap');
  const callout = editorOf(page).locator('.callout');
  await expect(callout).toContainText('Mind the gap');
  await callout.getByRole('button', { name: /Callout icon 💡/ }).click();
  await expect(callout.getByRole('button', { name: /Callout icon ⚠️/ })).toBeVisible();
});
