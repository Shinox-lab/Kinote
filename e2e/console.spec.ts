// The console screens that need a real browser: the review queue, the history drawer and
// citations. The accounts are made through the api; each spec drives the screen it covers.
// Serial: the tests share one workspace and build on each other's pages, so running a single test with --grep is not supported.
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  addMember,
  badgeOf,
  call,
  createPageInSpace,
  openAs,
  runPageAction,
  seedWorld,
  typeAtEnd,
  type Account,
  type World,
} from './support.js';

interface VersionRow {
  id: string;
  number: number;
  status: string;
  reason: string;
}

test.describe.configure({ mode: 'serial' });

let world: World;
let ed: Account;
let rae: Account;
let edPageId: string;

const versionsOf = (request: Parameters<typeof call>[0], account: Account, pageId: string) =>
  call<VersionRow[]>(request, `/pages/${pageId}/versions`, { account, tenantId: world.tenantId });

const queue = (page: Page) => page.getByRole('list', { name: 'Changes waiting for review' });

/** Types into the page and submits it for review; the badge then reads "awaiting approval". */
async function writeAndSubmit(page: Page, text: string): Promise<void> {
  await typeAtEnd(page, text);
  await runPageAction(page, 'Submit for review');
  await expect(badgeOf(page)).toHaveText('Saved · not indexed (awaiting approval)');
}

test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  world = await seedWorld(request, { reviewRequired: true });
  ed = await addMember(request, world, 'Ed Editor', 'editor');
  rae = await addMember(request, world, 'Rae Reviewer', 'reviewer');
  await request.dispose();
});

test('review queue: Approve and Reject states, lazy diff', async ({ browser, request }) => {
  const edPage = await openAs(browser, world, ed);
  edPageId = await createPageInSpace(edPage, world, 'Leave policy');
  await writeAndSubmit(edPage, 'Employees get twenty days of annual leave.');

  const raePage = await openAs(browser, world, rae);
  await createPageInSpace(raePage, world, 'Rae notes');
  await writeAndSubmit(raePage, 'Quarterly planning notes for the platform team.');

  const diffRequests: Request[] = [];
  raePage.on('request', (r) => {
    if (/\/versions\/[^/]+\/diff/.test(r.url())) diffRequests.push(r);
  });
  await raePage.goto(`/w/${world.slug}/reviews`);
  const own = queue(raePage).getByRole('listitem').filter({ hasText: 'Rae notes' });
  const others = queue(raePage).getByRole('listitem').filter({ hasText: 'Leave policy' });

  await test.step('Approve is off for the reviewer\'s own change, and says why', async () => {
    await expect(own.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await expect(own).toContainText("You can't approve this change");
    await expect(others.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  await test.step('the block diff is fetched only when an item is expanded', async () => {
    expect(diffRequests).toHaveLength(0);
    const toggle = own.getByRole('button', { name: 'Show changes' });
    await toggle.click();
    const diff = own.getByRole('list', { name: 'Changes in version 1 of Rae notes' });
    await expect(diff).toContainText('Added');
    await expect(diff).toContainText('Quarterly planning notes');
    await expect(own.getByRole('button', { name: 'Hide changes' })).toHaveAttribute('aria-expanded', 'true');
    expect(diffRequests).toHaveLength(1);
    await own.getByRole('button', { name: 'Hide changes' }).click();
    await expect(diff).toBeHidden();
    expect(diffRequests).toHaveLength(1);
  });

  await test.step('Reject stays off until the note is 1 to 300 characters', async () => {
    await own.getByRole('button', { name: /^Reject/ }).click();
    const reject = own.getByRole('button', { name: 'Reject change' });
    const note = own.getByLabel('Why is this change rejected?');
    await expect(reject).toBeDisabled();
    await note.fill('   \n  ');
    await expect(reject).toBeDisabled();
    await expect(own).toContainText('0 / 300 characters (a note is required)');
    await note.fill('x'.repeat(301));
    await expect(reject).toBeDisabled();
    await expect(own).toContainText('301 / 300 characters (too long)');
    await note.fill('x'.repeat(300));
    await expect(reject).toBeEnabled();
    await note.fill('  needs sources  ');
    await expect(reject).toBeEnabled();
    await expect(own).toContainText('13 / 300 characters');
    await own.getByRole('button', { name: 'Cancel' }).click();
    await expect(reject).toHaveCount(0);
  });

  await test.step('another reviewer approves: the item leaves the queue', async () => {
    await others.getByRole('button', { name: 'Approve' }).click();
    await expect(others).toHaveCount(0);
    // The version is no longer waiting, whatever the worker has done since.
    await expect.poll(async () => (await versionsOf(request, ed, edPageId))[0]?.status).not.toBe('pending_review');
  });
  await edPage.context().close();
  await raePage.context().close();
});

test('history drawer: compare two versions, restore with confirmation, Escape returns focus', async ({ browser, request }) => {
  // A second version, approved: Ed edits and submits, Rae approves through the api.
  const edPage = await openAs(browser, world, ed);
  await edPage.goto(`/w/${world.slug}/p/${edPageId}`);
  await expect(edPage.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await writeAndSubmit(edPage, ' Part-timers accrue leave pro rata.');
  await expect.poll(async () => (await versionsOf(request, ed, edPageId))[0]).toMatchObject({ number: 2, status: 'pending_review' });
  const second = (await versionsOf(request, ed, edPageId))[0]!;
  await call(request, `/versions/${second.id}/approve`, { account: rae, tenantId: world.tenantId, method: 'POST' });

  await edPage.reload();
  const historyButton = edPage.getByRole('button', { name: 'Page status and actions' });
  await historyButton.focus();
  await historyButton.click();
  await edPage
    .getByRole('dialog', { name: 'Page status and actions' })
    .getByRole('button', { name: 'History' })
    .click();
  const drawer = edPage.getByRole('dialog', { name: 'Page history' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toBeFocused();

  await test.step('versions are listed, newest first', async () => {
    const versions = drawer.getByRole('list', { name: 'Versions' });
    await expect(versions).toContainText('Version 2');
    await expect(versions).toContainText('Version 1');
    await expect(versions).toContainText('You');
  });

  await test.step('compare: the default pair, then any two', async () => {
    const forward = drawer.getByRole('list', { name: 'Changes from version 1 to version 2' });
    await expect(forward).toContainText('pro rata');
    await expect(drawer).toContainText('1 changed');

    await drawer.getByLabel('From', { exact: true }).selectOption('2');
    await expect(drawer.getByRole('button', { name: 'Compare', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(drawer).toContainText('Choose two different versions.');
    await drawer.getByLabel('To', { exact: true }).selectOption('1');
    await drawer.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(drawer.getByRole('list', { name: 'Changes from version 2 to version 1' })).toBeVisible();
  });

  await test.step('restore asks first; cancel changes nothing, confirm makes version 3', async () => {
    await drawer.getByRole('button', { name: 'Restore version 1' }).click();
    const confirm = drawer.getByRole('alertdialog', { name: 'Restore version 1?' });
    await expect(confirm).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    expect(await versionsOf(request, ed, edPageId)).toHaveLength(2);

    await drawer.getByRole('button', { name: 'Restore version 1' }).click();
    await drawer.getByRole('alertdialog').getByRole('button', { name: 'Restore version 1' }).click();
    await expect(drawer.getByRole('list', { name: 'Versions' })).toContainText('Version 3');
    const latest = (await versionsOf(request, ed, edPageId))[0]!;
    expect(latest).toMatchObject({ number: 3, reason: 'restore' });
  });

  await test.step('Escape closes the drawer and focus returns to the status chip', async () => {
    await edPage.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(historyButton).toBeFocused();
  });
  await edPage.context().close();
});

test('citations link to the cited page', async ({ browser, request }) => {
  // The second version is approved and indexed by the worker.
  await expect
    .poll(async () => (await versionsOf(request, ed, edPageId)).find((v) => v.number === 2)?.status, { timeout: 30_000 })
    .toBe('indexed');

  const page = await openAs(browser, world, rae);
  await page.goto(`/w/${world.slug}/search`);
  await page.getByLabel('Search or ask a question').fill('annual leave');

  await test.step('a search result links to its page and shows the citation', async () => {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const results = page.getByRole('region', { name: 'Search results' });
    await expect(results).toContainText(/\(v2, updated \d{4}-\d{2}-\d{2}\)/);
    await results.getByRole('link', { name: 'Leave policy' }).first().click();
    await page.waitForURL(`**/w/${world.slug}/p/${edPageId}`);
    await expect(page.getByRole('heading', { name: 'Leave policy' })).toBeVisible();
  });

  await test.step('Ask cites its sources, and each source links to the page', async () => {
    await page.goto(`/w/${world.slug}/search`);
    await page.getByLabel('Search or ask a question').fill('annual leave');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const sources = page.getByRole('list', { name: 'Sources' });
    const source = sources.getByRole('link').first();
    await expect(source).toHaveText(/^Leave policy \(v2, updated \d{4}-\d{2}-\d{2}\)$/);
    await expect(source).toHaveAttribute('href', `/w/${world.slug}/p/${edPageId}`);
    // The numbered marker inside the answer goes to the same page.
    const marker = page.getByRole('link', { name: '[1]' });
    await marker.click();
    await page.waitForURL(`**/w/${world.slug}/p/${edPageId}`);
  });
  await page.context().close();
});
