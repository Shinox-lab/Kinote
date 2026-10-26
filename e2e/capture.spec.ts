import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { call, openAs, seedWorld, type Account, type World } from './support.js';

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
});
