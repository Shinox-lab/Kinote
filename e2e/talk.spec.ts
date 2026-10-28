import { expect, test, type Page } from '@playwright/test';
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

const notificationsRow = (page: Page) => page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: /Notifications/ });

test('select text, comment; a reply shows in the other person’s notifications and opens the comments', async ({ browser }) => {
  const page = await openAs(browser, world, ed);
  const pageId = await createPageInSpace(page, world, 'Launch plan');
  await typeAtEnd(page, 'The launch is in May.');

  // Select "in May" and comment on it.
  await page.keyboard.down('Shift');
  for (let i = 0; i < 'in May.'.length; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.keyboard.type('Is this still right?');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(editorOf(page).locator('.bn-thread-mark')).toHaveText('in May.');

  // The owner answers from the comments panel.
  const owner = await openAs(browser, world, world.owner);
  await owner.goto(`/w/${world.slug}/p/${pageId}`);
  await owner.getByRole('button', { name: '1 comment' }).click();
  const panel = owner.getByRole('region', { name: 'Comments' });
  await expect(panel.getByText('Is this still right?')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'in May.' })).toBeVisible();
  await panel.getByLabel('Reply').fill('No, June.');
  await panel.getByRole('button', { name: 'Reply' }).click();
  await expect(panel.getByText('No, June.')).toBeVisible();

  // Ed hears about it, and the notification opens the page with its comments.
  await page.reload();
  await expect(notificationsRow(page)).toContainText('1', { timeout: 15_000 });
  await notificationsRow(page).click();
  const item = page.getByRole('list', { name: 'Notifications' }).getByRole('button', { name: /replied to a comment on Launch plan/ });
  await expect(item).toContainText('No, June.');
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/p/${pageId}\\?comments=1`));
  await expect(page.getByRole('region', { name: 'Comments' }).getByText('No, June.')).toBeVisible();
  await expect(notificationsRow(page)).not.toContainText('1');
});

test('@ mentions a person; once the page is saved they are told', async ({ browser, request }) => {
  const page = await openAs(browser, world, world.owner);
  const pageId = await createPageInSpace(page, world, 'Standup');
  await typeAtEnd(page, 'Ask @Ed');
  await page.getByRole('option', { name: /Ed Editor/ }).click();
  await expect(editorOf(page).locator('.mention')).toHaveText('@Ed Editor');

  await expect(async () => {
    await call(request, `/pages/${pageId}/snapshot`, { account: world.owner, tenantId: world.tenantId, method: 'POST' }).catch(() => undefined);
    const box = await call<{ items: Array<{ kind: string; documentId: string }> }>(request, '/notifications', {
      account: ed,
      tenantId: world.tenantId,
    });
    expect(box.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mention', documentId: pageId })]));
  }).toPass({ timeout: 30_000 });

  const edPage = await openAs(browser, world, ed);
  await edPage.goto(`/w/${world.slug}/notifications`);
  const item = edPage.getByRole('button', { name: /Olive Owner mentioned you in Standup/ });
  await expect(item).toContainText('Ask @Ed Editor');
  await item.click();
  await expect(edPage).toHaveURL(new RegExp(`/p/${pageId}#block-`));
  await expect(editorOf(edPage).locator('.mention')).toHaveText('@Ed Editor');
});
