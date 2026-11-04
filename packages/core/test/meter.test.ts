import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  memberships,
  notifications,
  tenantLimits,
  tenantUsage,
  tenants,
  usageEvents,
  users,
  withTenantTx,
} from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import type { CreditRates } from '@kinote/shared';
import { estimateTokens, reportModelCall, withUsageScope } from '../src/index.js';

const rates: CreditRates = { default: { input: 1, output: 1 }, models: {} };
let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

async function seedTenant() {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` })
  );
  return tenantId;
}

async function addUser(tenantId: string, role: 'owner' | 'admin' | 'member') {
  const userId = randomUUID();
  await testDb.db.insert(users).values({ id: userId, email: `${userId}@x.test`, name: role, passwordHash: 'x' });
  await withTenantTx(tenantId, (tx) => tx.insert(memberships).values({ tenantId, userId, role }));
  return userId;
}

const call = (inputTokens: number) => reportModelCall({ model: 'm', inputTokens, outputTokens: 0, estimated: false });

async function ledger(tenantId: string) {
  return withTenantTx(tenantId, async (tx) => ({
    events: await tx.select().from(usageEvents).where(eq(usageEvents.tenantId, tenantId)),
    usage: await tx.select().from(tenantUsage).where(eq(tenantUsage.tenantId, tenantId)),
  }));
}

describe('usage scope', () => {
  it('estimates 4 characters a token, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('calls inside a scope land in the ledger with credits', async () => {
    const tenantId = await seedTenant();
    const principalId = randomUUID();
    const out = await withUsageScope({ tenantId, kind: 'ask', principalId }, rates, async () => {
      call(1000);
      return 'done';
    });
    expect(out).toBe('done');
    const { events, usage } = await ledger(tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'ask', model: 'm', inputTokens: 1000, millicredits: 1000, principalId });
    expect(usage[0]!.creditsUsedMilli).toBe(1000);
  });

  it('a scope whose work throws still records what was spent, and rethrows', async () => {
    const tenantId = await seedTenant();
    await expect(
      withUsageScope({ tenantId, kind: 'capture' }, rates, async () => {
        call(500);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const { usage } = await ledger(tenantId);
    expect(usage[0]!.creditsUsedMilli).toBe(500);
  });

  it('a ledger failure does not fail the work', async () => {
    const tenantId = await seedTenant();
    await testDb.pglite.exec('RESET ROLE; ALTER TABLE usage_events RENAME TO usage_events_gone; SET ROLE kinote_app;');
    try {
      const out = await withUsageScope({ tenantId, kind: 'index' }, rates, async () => {
        call(10);
        return 42;
      });
      expect(out).toBe(42);
    } finally {
      await testDb.pglite.exec('RESET ROLE; ALTER TABLE usage_events_gone RENAME TO usage_events; SET ROLE kinote_app;');
    }
  });

  it('a call with no scope open is dropped, not thrown', () => {
    expect(() => call(10)).not.toThrow();
  });

  it('crossing 80% notifies owners and admins once', async () => {
    const tenantId = await seedTenant();
    const owner = await addUser(tenantId, 'owner');
    const admin = await addUser(tenantId, 'admin');
    await addUser(tenantId, 'member');
    await withTenantTx(tenantId, (tx) => tx.insert(tenantLimits).values({ tenantId, creditsPerMonth: 10 }));
    await withUsageScope({ tenantId, kind: 'capture' }, rates, async () => call(8000));
    await withUsageScope({ tenantId, kind: 'capture' }, rates, async () => call(500));
    const sent = await withTenantTx(tenantId, (tx) => tx.select().from(notifications));
    expect(sent.map((n) => n.recipientId).sort()).toEqual([owner, admin].sort());
    expect(sent.every((n) => n.kind === 'credits_warning' && n.excerpt === '80' && n.actorType === 'connector' && n.actorId === tenantId)).toBe(true);
  });

  it('crossing 100% sends the 100 warning; index usage never warns', async () => {
    const tenantId = await seedTenant();
    await addUser(tenantId, 'owner');
    await withTenantTx(tenantId, (tx) =>
      tx.insert(tenantLimits).values({ tenantId, creditsPerMonth: 10, indexCreditsPerMonth: 1 })
    );
    await withUsageScope({ tenantId, kind: 'index' }, rates, async () => call(5000));
    expect(await withTenantTx(tenantId, (tx) => tx.select().from(notifications))).toHaveLength(0);
    await withUsageScope({ tenantId, kind: 'ask' }, rates, async () => call(8000));
    await withUsageScope({ tenantId, kind: 'ask' }, rates, async () => call(2000));
    const sent = await withTenantTx(tenantId, (tx) => tx.select().from(notifications));
    expect(sent.map((n) => n.excerpt).sort()).toEqual(['100', '80']);
  });

  it('without limits nobody is warned', async () => {
    const tenantId = await seedTenant();
    await addUser(tenantId, 'owner');
    await withUsageScope({ tenantId, kind: 'ask' }, rates, async () => call(1_000_000));
    expect(await withTenantTx(tenantId, (tx) => tx.select().from(notifications))).toHaveLength(0);
  });
});
