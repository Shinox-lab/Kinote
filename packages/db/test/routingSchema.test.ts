import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../src/testing.js';
import {
  acquireRoutingLease,
  agents,
  captures,
  citations,
  documents,
  releaseRoutingLease,
  routingLeases,
  spaces,
  tenants,
  withTenantTx,
} from '../src/index.js';

async function seedTenant() {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` })
  );
  return tenantId;
}

describe('routing schema', () => {
  it('gives the lease to one holder until it expires or is released', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const take = (holder: string, seconds = 300) =>
      withTenantTx(tenantId, (tx) => acquireRoutingLease(tx, tenantId, holder, seconds));

    expect(await take('w1')).toBe(true);
    expect(await take('w2')).toBe(false);
    // The holder may renew its own lease.
    expect(await take('w1')).toBe(true);

    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, 'w2'));
    expect(await take('w2')).toBe(false);
    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, 'w1'));
    expect(await take('w2')).toBe(true);

    await withTenantTx(tenantId, (tx) =>
      tx.update(routingLeases).set({ expiresAt: new Date(Date.now() - 1000) })
    );
    expect(await take('w3')).toBe(true);
  });

  it('stores a capture citation without a version', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const userId = randomUUID();
    await withTenantTx(tenantId, async (tx) => {
      const [space] = await tx
        .insert(spaces)
        .values({ tenantId, name: 'Eng', slug: 'eng', createdBy: userId })
        .returning();
      const [doc] = await tx
        .insert(documents)
        .values({ tenantId, spaceId: space!.id, kind: 'page', title: 'Billing', createdByType: 'user', createdBy: userId })
        .returning();
      const [capture] = await tx
        .insert(captures)
        .values({ tenantId, senderType: 'user', senderId: userId, channel: 'console', text: 'Billing uses Adyen.' })
        .returning();
      await tx.insert(citations).values({
        tenantId,
        pageId: doc!.id,
        blockId: 'b1',
        sourceKind: 'capture',
        captureId: capture!.id,
        quote: 'Billing uses Adyen.',
        createdByType: 'agent',
        createdBy: randomUUID(),
      });
    });
    const rows = await withTenantTx(tenantId, (tx) => tx.select().from(citations));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceKind: 'capture', sourceVersionId: null, state: 'ok' });
  });

  it('accepts the router agent kind', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(agents).values({ tenantId, name: 'Routing engine', kind: 'router', createdBy: randomUUID() })
    );
    const rows = await withTenantTx(tenantId, (tx) => tx.select().from(agents));
    expect(rows[0]!.kind).toBe('router');
  });
});
