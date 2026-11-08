import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import { getDb, readBillingState, readStanding, rowsOf, tenantBilling, tenants, withTenantTx } from '../src/index.js';

async function seedTenant() {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` })
  );
  return tenantId;
}

describe('tenant billing state', () => {
  it('is ok with no manage URL when no row exists', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    expect(await withTenantTx(tenantId, (tx) => readBillingState(tx, tenantId))).toEqual({ state: 'ok', manageUrl: null });
  });

  it('reads the stored state', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(tenantBilling).values({ tenantId, state: 'suspended', manageUrl: 'https://cp/portal' })
    );
    expect(await withTenantTx(tenantId, (tx) => readBillingState(tx, tenantId))).toEqual({
      state: 'suspended',
      manageUrl: 'https://cp/portal',
    });
    const s = await withTenantTx(tenantId, (tx) => readStanding(tx, tenantId, new Date()));
    expect(s.suspended).toBe(true);
  });

  it('refuses an unknown state', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    await expect(
      withTenantTx(tenantId, (tx) => tx.execute(sql`INSERT INTO tenant_billing (tenant_id, state) VALUES (${tenantId}, 'paused')`))
    ).rejects.toThrow();
  });

  it("another tenant's row is invisible", async () => {
    const { reset } = await createTestDb();
    await reset();
    const a = await seedTenant();
    const b = await seedTenant();
    await withTenantTx(a, (tx) => tx.insert(tenantBilling).values({ tenantId: a, state: 'past_due' }));
    expect(await withTenantTx(b, (tx) => readBillingState(tx, a))).toEqual({ state: 'ok', manageUrl: null });
    const s = await withTenantTx(a, (tx) => readStanding(tx, a, new Date()));
    expect(s.suspended).toBe(false);
  });

  it('cp_list_tenants returns the billing state', async () => {
    const { reset } = await createTestDb();
    await reset();
    const a = await seedTenant();
    const b = await seedTenant();
    await withTenantTx(b, (tx) => tx.insert(tenantBilling).values({ tenantId: b, state: 'past_due', manageUrl: 'https://cp/portal' }));
    const rows = rowsOf<{ id: string; billing_state: string; manage_url: string | null }>(
      await getDb().execute(sql`SELECT id, billing_state, manage_url FROM cp_list_tenants(NULL, 10)`)
    );
    expect(rows.find((r) => r.id === a)).toMatchObject({ billing_state: 'ok', manage_url: null });
    expect(rows.find((r) => r.id === b)).toMatchObject({ billing_state: 'past_due', manage_url: 'https://cp/portal' });
  });
});
