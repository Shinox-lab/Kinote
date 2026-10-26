import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { addMember, approveAll, call, openAs, seedWorld, type Account, type World } from './support.js';

// The Capture page: send anything, follow what the routing engine did with it,
// and take it back. The local stack routes captures with the deterministic model.

interface CaptureRow {
  id: string;
  status: string;
}
interface CaptureDetailRow {
  capture: CaptureRow;
  thread: Array<{ author: string; body: string; options: Array<{ label: string }> | null }>;
}

let world: World;

/** A page made through the API, snapshotted and left until the worker has indexed it. */
async function indexedPage(request: APIRequestContext, title: string, markdown: string, spaceId = world.spaceId): Promise<string> {
  const as = { account: world.owner, tenantId: world.tenantId };
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;
  const page = await call<{ id: string }>(request, '/pages', { ...as, method: 'POST', data: { space_id: spaceId, title, slug, markdown } });
  await call(request, `/pages/${page.id}/snapshot`, { ...as, method: 'POST' });
  await expect
    .poll(async () => (await call<{ badge: string }>(request, `/pages/${page.id}`, as)).badge, { timeout: 30_000 })
    .toMatch(/^Indexed/);
  return page.id;
}

async function captures(request: APIRequestContext, account: Account = world.owner): Promise<CaptureRow[]> {
  return call<CaptureRow[]>(request, '/captures', { account, tenantId: world.tenantId });
}

/** Sends a capture through the API and waits until the engine has finished with it. */
async function captureVia(request: APIRequestContext, text: string, pageId?: string): Promise<string> {
  const as = { account: world.owner, tenantId: world.tenantId };
  const created = await call<CaptureRow>(request, '/captures', {
    ...as,
    method: 'POST',
    data: { text, ...(pageId ? { scope_page_id: pageId } : {}) },
  });
  await expect
    .poll(async () => (await call<CaptureDetailRow>(request, `/captures/${created.id}`, as)).capture.status, { timeout: 15_000 })
    .not.toMatch(/^(queued|routing)$/);
  return created.id;
}

/** The live page's editor text. */
async function pageText(browser: Browser, pageId: string): Promise<string> {
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${pageId}`);
  await expect(page.getByRole('status', { name: 'Presence: connected' })).toBeVisible();
  const text = (await page.getByRole('textbox').first().innerText()).replace(/\s+/g, ' ');
  await page.context().close();
  return text;
}

async function openCapture(browser: Browser, query = ''): Promise<Page> {
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/capture${query}`);
  await expect(page.getByRole('heading', { name: 'Capture', level: 1 })).toBeVisible();
  return page;
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  world = await seedWorld(request, { reviewRequired: false });
});

test.describe('Capture page', () => {
  let billing: string;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    billing = await indexedPage(request, 'Billing service', 'Billing uses Stripe.\n\nInvoices go out monthly.');
  });

  test('the receipt appears without reloading', async ({ browser }) => {
    const page = await openAs(browser, world, world.owner);
    await page.goto(`/w/${world.slug}`);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Capture' }).click();
    await expect(page.getByRole('heading', { name: 'Capture', level: 1 })).toBeVisible();

    await page.goto(`/w/${world.slug}/capture?page=${billing}`);
    await expect(page.getByLabel('Limit to')).toHaveValue(`page:${billing}`);
    await expect(page.getByLabel('Limit to').locator('option:checked')).toHaveText('This page: Billing service');
    await page.getByLabel('What do you want to file?').fill('Billing moved to Adyen.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const card = page.getByRole('article').filter({ hasText: 'Billing moved to Adyen.' }).first();
    await expect(card.getByText('Applied', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('sending twice quickly makes one capture', async ({ browser, request }) => {
    const before = (await captures(request)).length;
    const page = await openCapture(browser, `?page=${billing}`);
    await page.getByLabel('What do you want to file?').fill('Invoices are emailed.');
    await page.getByRole('button', { name: 'Send', exact: true }).dblclick();
    await page.waitForTimeout(2_000);
    expect((await captures(request)).length).toBe(before + 1);
  });

  test('the count turns red past 20,000 characters and Send is off', async ({ browser }) => {
    const page = await openCapture(browser);
    await page.getByLabel('What do you want to file?').fill('a'.repeat(20_001));
    await expect(page.getByText('20,001 / 20,000')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  });

  test('the Capture page fits a phone', async ({ browser }) => {
    const page = await openCapture(browser);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Capture', level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('a question is answered inline', async ({ browser, request }) => {
    await indexedPage(request, 'Team', 'Aisha Rahman leads Payments.');
    await indexedPage(request, 'People', 'Aisha Tan leads Search.');
    const as = { account: world.owner, tenantId: world.tenantId };
    // The entity graph is built by the worker after indexing: ask until the engine knows both.
    await expect(async () => {
      const created = await call<CaptureRow>(request, '/captures', { ...as, method: 'POST', data: { text: 'Aisha is on leave.' } });
      await expect
        .poll(async () => (await call<CaptureDetailRow>(request, `/captures/${created.id}`, as)).capture.status, { timeout: 10_000 })
        .not.toMatch(/^(queued|routing)$/);
      const detail = await call<CaptureDetailRow>(request, `/captures/${created.id}`, as);
      expect(detail.thread.some((m) => m.body === 'Which Aisha do you mean?')).toBe(true);
    }).toPass({ timeout: 60_000 });

    const page = await openCapture(browser);
    const card = page.getByRole('article').filter({ hasText: 'Which Aisha do you mean?' }).first();
    await card.getByRole('button', { name: 'Aisha Rahman' }).click();
    await expect(card.getByText('You answered: Aisha Rahman')).toBeVisible();
  });

  test('undo shows what was undone', async ({ browser, request }) => {
    const target = await indexedPage(request, 'Undo billing', 'Billing uses Stripe.');
    await captureVia(request, 'Billing moved to Adyen.', target);
    expect(await pageText(browser, target)).toContain('Billing moved to Adyen.');

    const page = await openCapture(browser);
    const card = page.getByRole('article').first();
    await card.getByRole('region', { name: 'Undo billing' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Undid 1 change.' })).toBeVisible();
    expect(await pageText(browser, target)).toContain('Billing uses Stripe.');
  });

  test('wrong page moves the fact', async ({ browser, request }) => {
    const from = await indexedPage(request, 'Move billing', 'Billing uses Stripe.');
    const to = await indexedPage(request, 'Runbook Moves', 'Page the on-call.');
    await captureVia(request, 'Billing has a new dashboard.', from);

    const page = await openCapture(browser);
    const card = page.getByRole('article').first();
    await card.getByRole('button', { name: 'Wrong page → move to…' }).click();
    await card.getByLabel('Find a page').fill('Runbook Moves');
    await card.getByRole('button', { name: 'Runbook Moves' }).click();
    await expect.poll(() => pageText(browser, to), { timeout: 20_000 }).toContain('Billing has a new dashboard.');
    expect(await pageText(browser, from)).not.toContain('Billing has a new dashboard.');
  });

  test('a fact nobody can place waits in Needs a home and can be placed', async ({ browser, request }) => {
    const scope = await indexedPage(request, 'Lunch scope', 'Billing uses Stripe.');
    const to = await indexedPage(request, 'Runbook Places', 'Page the on-call.');
    await captureVia(request, 'Lunch is at noon.', scope);

    const page = await openCapture(browser);
    const home = page.getByRole('region', { name: 'Needs a home' });
    const item = home.getByRole('listitem').filter({ hasText: 'Lunch is at noon.' }).first();
    await item.getByRole('button', { name: 'Place…' }).click();
    await item.getByLabel('Find a page').fill('Runbook Places');
    await item.getByRole('button', { name: 'Runbook Places' }).click();
    await expect(home.getByText('Lunch is at noon.')).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => pageText(browser, to), { timeout: 20_000 }).toContain('Lunch is at noon.');
  });

  test('dismiss removes it from Needs a home', async ({ browser, request }) => {
    const scope = await indexedPage(request, 'Dismiss scope', 'Billing uses Stripe.');
    await captureVia(request, 'The coffee machine is broken.', scope);
    const page = await openCapture(browser);
    const home = page.getByRole('region', { name: 'Needs a home' });
    const item = home.getByRole('listitem').filter({ hasText: 'The coffee machine is broken.' });
    await item.getByRole('button', { name: 'Dismiss' }).click();
    await expect(home.getByText('The coffee machine is broken.')).toHaveCount(0);
  });

  test('a receipt card opens the page with the capture\'s blocks highlighted, and Exit leaves', async ({ browser, request }) => {
    const target = await indexedPage(request, 'Highlight billing', 'Billing uses Stripe.\n\nInvoices go out monthly.');
    await captureVia(request, 'Billing moved to Adyen.', target);
    const page = await openCapture(browser);
    await page.getByRole('article').first().getByRole('link', { name: 'Highlight billing' }).click();
    await expect(page).toHaveURL(/\?capture=[0-9a-f-]{36}/);
    await expect(page.getByText('Changes from this capture · Routing engine on behalf of Olive Owner')).toBeVisible();
    const block = page.locator('.bn-block-content', { hasText: 'Billing moved to Adyen.' });
    await expect.poll(() => block.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(124, 92, 255)');

    await page.getByRole('link', { name: 'Exit' }).click();
    await expect(page.getByText('Changes from this capture')).toHaveCount(0);
    expect(page.url()).not.toContain('capture=');
  });

  test('a removal becomes a suggestion the editor approves on the page', async ({ browser, request }) => {
    const target = await indexedPage(request, 'Suggest billing', 'Billing uses Stripe.\n\nInvoices go out monthly.');
    await captureVia(request, 'Billing no longer uses Stripe.', target);
    const page = await openAs(browser, world, world.owner);
    await page.goto(`/w/${world.slug}/p/${target}`);
    await page.getByRole('button', { name: '1 suggestion' }).click();
    const panel = page.getByRole('region', { name: 'Suggestions' });
    await expect(panel.getByText('Removals always wait for a person')).toBeVisible();
    await panel.getByRole('button', { name: 'Approve removal' }).click();
    await expect(page.getByRole('textbox').first()).not.toContainText('Billing uses Stripe.');
    await expect(page.getByRole('button', { name: /suggestion/ })).toHaveCount(0);
  });
});

test.describe('review bundles', () => {
  let reviewWorld: World;
  let ed: Account;
  let rae: Account;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    reviewWorld = await seedWorld(request, { reviewRequired: true });
    ed = await addMember(request, reviewWorld, 'Ed Editor', 'editor');
    rae = await addMember(request, reviewWorld, 'Rae Reviewer', 'reviewer');
    const as = { account: reviewWorld.owner, tenantId: reviewWorld.tenantId };
    const ids: string[] = [];
    for (const [title, markdown] of [
      ['Acme', 'Acme pays yearly.'],
      ['Globex', 'Globex pays quarterly.'],
    ] as const) {
      const page = await call<{ id: string }>(request, '/pages', {
        ...as,
        method: 'POST',
        data: { space_id: reviewWorld.spaceId, title, slug: title.toLowerCase(), markdown },
      });
      await call(request, `/pages/${page.id}/snapshot`, { ...as, method: 'POST' });
      ids.push(page.id);
    }
    await approveAll(request, reviewWorld, rae);
    for (const id of ids) {
      await expect
        .poll(async () => (await call<{ badge: string }>(request, `/pages/${id}`, as)).badge, { timeout: 30_000 })
        .toMatch(/^Indexed/);
    }
  });

  test('approve all from this capture', async ({ browser, request }) => {
    const asEd = { account: ed, tenantId: reviewWorld.tenantId };
    // Cards and the entity graph are built after indexing: send until both pages are waiting.
    await expect(async () => {
      await call(request, '/captures', { ...asEd, method: 'POST', data: { text: 'Acme now pays monthly. Globex now pays monthly.' } });
      await expect
        .poll(async () => (await call<unknown[]>(request, '/reviews', { account: rae, tenantId: reviewWorld.tenantId })).length, { timeout: 10_000 })
        .toBe(2);
    }).toPass({ timeout: 60_000 });

    const page = await openAs(browser, reviewWorld, rae);
    await page.goto(`/w/${reviewWorld.slug}/reviews`);
    await expect(page.getByText('Routing engine on behalf of Ed Editor · from Capture').first()).toBeVisible();
    await page.getByRole('button', { name: 'Approve all from this capture' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'Approved 2.' })).toBeVisible();
    await expect(page.getByText('Nothing is waiting for your review.')).toBeVisible();
  });
});
