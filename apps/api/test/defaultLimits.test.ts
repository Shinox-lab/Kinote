import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { tenantLimits, tenants, withTenantTx } from '@kinote/db';
import { ERROR_SENTENCES } from '@kinote/contracts';
import { asUser, buildTestApp, createTenant, signUp, useTestDb } from './support/testkit.js';

// New workspaces start on the control plane's stored defaults, and one person may own only so many
// workspaces on the defaults' plan (Kinote-SaaS sub-project 6).

const TOKEN = 'd'.repeat(40);
const BILLING_URL = 'https://cp.example.test/portal';
const cp = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const freeDefaults = { plan: 'free', seats: 3, storageBytes: 5000, creditsPerMonth: 50, indexCreditsPerMonth: 20, maxFreePerOwner: 2 };

describe('new-workspace defaults', () => {
  const app = buildTestApp({ controlPlaneTokens: [TOKEN], billingUrl: BILLING_URL });
  useTestDb();

  const setDefaults = async (body: unknown) => {
    const res = await app.inject({ method: 'PUT', url: '/internal/v1/defaults', headers: cp, payload: JSON.stringify(body) });
    expect(res.statusCode, res.body).toBe(200);
  };
  const tryCreate = (session: { token: string }, slug: string) =>
    app.inject({ method: 'POST', url: '/api/v1/tenants', headers: asUser(session), payload: { name: slug, slug } });
  const planOf = (id: string) => withTenantTx(id, async (tx) => (await tx.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, id)))[0]!.plan);
  const limitsOf = (id: string) => withTenantTx(id, async (tx) => (await tx.select().from(tenantLimits).where(eq(tenantLimits.tenantId, id)))[0]);

  test('without defaults a new workspace has no limits and plan standard', async () => {
    const owner = await signUp(app);
    const { tenant } = await createTenant(app, owner, { name: 'Plain', slug: 'plain' });
    expect(await planOf(tenant.id)).toBe('standard');
    expect(await limitsOf(tenant.id)).toBeUndefined();
  });

  test('with defaults a new workspace gets them: plan free, tenant_limits row, anchor day min(today,28), updated_by defaults', async () => {
    await setDefaults(freeDefaults);
    const owner = await signUp(app);
    const { tenant } = await createTenant(app, owner, { name: 'Freebie', slug: 'freebie' });
    expect(await planOf(tenant.id)).toBe('free');
    const limits = await limitsOf(tenant.id);
    expect(limits).toMatchObject({
      seats: 3,
      storageBytes: 5000,
      creditsPerMonth: 50,
      indexCreditsPerMonth: 20,
      gracePercent: 10,
      periodAnchorDay: Math.min(new Date().getUTCDate(), 28),
      updatedBy: 'defaults',
    });
    // The owner sees Free limits straight away.
    const usage = await app.inject({ method: 'GET', url: '/api/v1/usage', headers: asUser(owner, tenant.id) });
    expect(usage.json()).toMatchObject({ plan: 'free', limitCredits: 50 });
  });

  test("a new workspace copies the defaults' askModel and multiplier", async () => {
    await setDefaults({ ...freeDefaults, askModel: 'free-model', creditMultiplier: 1.5 });
    const owner = await signUp(app);
    const { tenant } = await createTenant(app, owner, { name: 'Modelled', slug: 'modelled' });
    const detail = await app.inject({ method: 'GET', url: `/internal/v1/tenants/${tenant.id}`, headers: cp });
    expect(detail.json().limits).toMatchObject({ askModel: 'free-model', creditMultiplier: 1.5 });
  });

  test('the Free cap refuses the next free workspace with 409 free_workspace_limit and billingUrl', async () => {
    await setDefaults(freeDefaults);
    const owner = await signUp(app);
    await createTenant(app, owner, { name: 'One', slug: 'one' });
    await createTenant(app, owner, { name: 'Two', slug: 'two' });
    const third = await tryCreate(owner, 'three');
    expect(third.statusCode).toBe(409);
    expect(third.json()).toEqual({
      error: 'free_workspace_limit',
      message: ERROR_SENTENCES.free_workspace_limit,
      billingUrl: BILLING_URL,
    });
    expect(ERROR_SENTENCES.free_workspace_limit).toBe(
      'You have reached the number of free workspaces. Upgrade one or delete one to create another.'
    );
    // Someone else still can.
    expect((await tryCreate(await signUp(app), 'elsewhere')).statusCode).toBe(201);
  });

  test('paid, unlimited and deleted workspaces do not count', async () => {
    const owner = await signUp(app);
    await createTenant(app, owner, { name: 'Old', slug: 'old' }); // before defaults: plan standard
    await setDefaults({ ...freeDefaults, maxFreePerOwner: 1 });
    const { tenant: paid } = await createTenant(app, owner, { name: 'Paid', slug: 'paid' });
    const relabel = await app.inject({
      method: 'PUT',
      url: `/internal/v1/tenants/${paid.id}/limits`,
      headers: cp,
      payload: JSON.stringify({ plan: 'team', seats: 10, storageBytes: null, creditsPerMonth: 1000, indexCreditsPerMonth: null }),
    });
    expect(relabel.statusCode, relabel.body).toBe(200);
    const { tenant: gone } = await createTenant(app, owner, { name: 'Gone', slug: 'gone' });
    await withTenantTx(gone.id, (tx) => tx.update(tenants).set({ deletedAt: new Date() }).where(eq(tenants.id, gone.id)));
    // Old (standard), Paid (team) and Gone (deleted) leave the one free slot open.
    expect((await tryCreate(owner, 'f1')).statusCode).toBe(201);
    expect((await tryCreate(owner, 'f2')).statusCode).toBe(409);
  });

  test('null cap means none', async () => {
    await setDefaults({ ...freeDefaults, maxFreePerOwner: null });
    const owner = await signUp(app);
    for (let i = 1; i <= 5; i++) expect((await tryCreate(owner, `n${i}`)).statusCode).toBe(201);
  });

  test('concurrent creates at the cap', async () => {
    await setDefaults(freeDefaults);
    const owner = await signUp(app);
    await createTenant(app, owner, { name: 'First', slug: 'first' });
    const results = await Promise.all([tryCreate(owner, 'race-a'), tryCreate(owner, 'race-b')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});
