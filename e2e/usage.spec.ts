import { expect, test, type APIRequestContext } from '@playwright/test';
import { badgeOf, call, openAs, seedWorld, type World } from './support.js';

// Plans and usage: limits set through the control-plane API (/internal/v1, straight to the
// api: no proxy forwards it), what the console then shows, and the refusal past grace.
// The local stack charges the deterministic models 1 credit per token (e2e/harness/local-stack.ts).

test.skip(process.env.E2E_MODE !== 'local', 'the local stack turns the control-plane API on');

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18787}`;
const TOKEN = process.env.CONTROL_PLANE_TOKENS?.split(',')[0]?.trim() ?? 'e2e-control-plane-token-0123456789abcdef';

interface Limits {
  plan: string;
  seats: number | null;
  storageBytes: number | null;
  creditsPerMonth: number | null;
  indexCreditsPerMonth: number | null;
}
const UNLIMITED: Limits = { plan: 'team', seats: null, storageBytes: null, creditsPerMonth: null, indexCreditsPerMonth: null };

async function putLimits(request: APIRequestContext, world: World, limits: Limits | null): Promise<void> {
  const res = await request.fetch(`${API}/internal/v1/tenants/${world.tenantId}/limits`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    data: JSON.stringify(limits),
  });
  expect(res.status(), await res.text()).toBe(200);
}

interface Usage {
  usedCredits: number;
  state: string;
}
const usage = (request: APIRequestContext, world: World) =>
  call<Usage>(request, '/usage', { account: world.owner, tenantId: world.tenantId });

/** A capture through the api, waited on until the engine is done with it. */
async function captureVia(request: APIRequestContext, world: World, text: string): Promise<void> {
  const as = { account: world.owner, tenantId: world.tenantId };
  const created = await call<{ id: string }>(request, '/captures', { ...as, method: 'POST', data: { text } });
  await expect
    .poll(async () => (await call<{ capture: { status: string } }>(request, `/captures/${created.id}`, as)).capture.status, {
      timeout: 15_000,
    })
    .not.toMatch(/^(queued|routing)$/);
}

test('the console warns at 80%, counts down in grace, and refuses past it', async ({ request, browser }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  await captureVia(request, world, 'Invoices go out on the first working day of the month.');
  // What one capture cost, measured: limits below are sized from it.
  await expect.poll(async () => (await usage(request, world)).usedCredits, { timeout: 15_000 }).toBeGreaterThan(0);
  const used = (await usage(request, world)).usedCredits;
  expect(Number.isInteger(used)).toBe(true);

  const page = await openAs(browser, world, world.owner);
  const banner = page.getByRole('status').filter({ hasText: /AI credits/ });

  // 85% of the plan: the 80% warning.
  await putLimits(request, world, { ...UNLIMITED, creditsPerMonth: Math.floor(used / 0.85) });
  await page.goto(`/w/${world.slug}`);
  await expect(banner).toHaveText(/This workspace has used 80% of this month's AI credits\./);
  await expect(banner.getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', 'https://billing.example.test/upgrade');

  // Past 100% but inside the 10% grace: the countdown.
  const inGrace = Math.ceil(used / 1.05);
  const left = Math.floor(inGrace * 1.1 - used);
  await putLimits(request, world, { ...UNLIMITED, creditsPerMonth: inGrace });
  await page.reload();
  await expect(banner).toHaveText(new RegExp(`Over this month's AI credits: ${left} left before AI actions pause\\.`));

  // Past grace: the banner says when credits renew, and Capture is refused with the same sentence.
  await putLimits(request, world, { ...UNLIMITED, creditsPerMonth: Math.floor(used / 1.2) });
  await page.goto(`/w/${world.slug}/capture`);
  const renewal = /This workspace has used this month's AI credits\. They renew on \d{1,2} [A-Z][a-z]{2}\./;
  await expect(banner).toHaveText(renewal);
  await page.getByLabel('What do you want to file?').fill('Payroll runs on the 25th.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(renewal);
  await page.context().close();
});

test('the Usage page shows plan, credits, storage and seats', async ({ request, browser }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  await putLimits(request, world, {
    plan: 'business',
    seats: 5,
    storageBytes: 1_000_000_000,
    creditsPerMonth: 100_000,
    indexCreditsPerMonth: null,
  });
  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/admin`);
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByText(/Plan: business · Renews on \d{1,2} [A-Z][a-z]{2}/)).toBeVisible();
  await expect(page.getByTestId('usage-ai-credits')).toHaveText(/ of 100,000$/);
  await expect(page.getByTestId('usage-storage')).toHaveText(/ of 1 GB$/);
  await expect(page.getByTestId('usage-seats')).toHaveText('1 of 5');
  // No index limit: just what was used.
  await expect(page.getByTestId('usage-indexing-credits')).not.toHaveText(/ of /);
  await page.context().close();
});

test('a page waits with "indexing limit reached" and is indexed after the limit is raised', async ({ request, browser }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  await putLimits(request, world, { ...UNLIMITED, indexCreditsPerMonth: 0 });
  const as = { account: world.owner, tenantId: world.tenantId };
  const created = await call<{ id: string }>(request, '/pages', {
    ...as,
    method: 'POST',
    data: { space_id: world.spaceId, parent_id: null, title: 'Held page', slug: `held-${world.suffix}`, markdown: 'Waits for credits.' },
  });
  await call(request, `/pages/${created.id}/snapshot`, { ...as, method: 'POST' });

  const page = await openAs(browser, world, world.owner);
  await page.goto(`/w/${world.slug}/p/${created.id}`);
  await expect(badgeOf(page)).toContainText('Saved · not indexed (indexing limit reached)');

  await putLimits(request, world, { ...UNLIMITED, indexCreditsPerMonth: 1_000_000 });
  await expect
    .poll(async () => (await call<{ badge: string }>(request, `/pages/${created.id}`, as)).badge, { timeout: 30_000 })
    .toMatch(/^Indexed/);
  await page.reload();
  await expect(badgeOf(page)).toContainText('Indexed');
  await page.context().close();
});
