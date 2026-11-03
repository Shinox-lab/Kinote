import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import {
  addTopup,
  enqueueJob,
  jobs,
  markWarned,
  periodOf,
  readStanding,
  recordUsage,
  releaseHeldIndexJobs,
  tenantLimits,
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

const event = (kind: 'capture' | 'ask' | 'index', millicredits: number) => ({
  kind,
  model: 'm',
  inputTokens: 10,
  outputTokens: 5,
  estimated: false,
  millicredits,
});

describe('periodOf', () => {
  it('starts on the anchor day, in UTC, with an exclusive end', () => {
    const p = periodOf(1, new Date('2026-11-03T10:00:00Z'));
    expect(p.key).toBe('2026-11-01');
    expect(p.start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(periodOf(15, new Date('2026-11-03T10:00:00Z')).key).toBe('2026-10-15');
    expect(periodOf(28, new Date('2027-02-28T00:00:00Z')).key).toBe('2027-02-28');
    const dec = periodOf(28, new Date('2026-12-31T12:00:00Z'));
    expect(dec.key).toBe('2026-12-28');
    expect(dec.end.toISOString()).toBe('2027-01-28T00:00:00.000Z');
    expect(periodOf(1, new Date('2026-12-15T00:00:00Z')).end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('usage ledger', () => {
  const now = new Date('2026-11-03T10:00:00Z');

  it('recordUsage adds capture and ask to credits and index to index credits', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const after = await withTenantTx(tenantId, (tx) =>
      recordUsage(tx, tenantId, [event('capture', 100), event('ask', 20), event('index', 7)], now)
    );
    expect(after.creditsUsedMilli).toBe(120);
    expect(after.indexCreditsUsedMilli).toBe(7);
    expect(after.period.key).toBe('2026-11-01');
    expect(after.limits).toBeNull();
    const again = await withTenantTx(tenantId, (tx) => recordUsage(tx, tenantId, [event('ask', 5)], now));
    expect(again.creditsUsedMilli).toBe(125);
  });

  it('uses the tenant anchor day for its period', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(tenantLimits).values({ tenantId, creditsPerMonth: 10, periodAnchorDay: 15 })
    );
    const s = await withTenantTx(tenantId, (tx) => readStanding(tx, tenantId, now));
    expect(s.period.key).toBe('2026-10-15');
    expect(s.limits).toMatchObject({ creditsPerMonth: 10, gracePercent: 10, periodAnchorDay: 15, seats: null });
  });

  it("a new period starts at zero and leaves last period's top-ups behind", async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const oct = new Date('2026-10-20T00:00:00Z');
    await withTenantTx(tenantId, async (tx) => {
      await recordUsage(tx, tenantId, [event('capture', 500), event('index', 9)], oct);
      await addTopup(tx, tenantId, 50, 'k1', oct);
    });
    const octStanding = await withTenantTx(tenantId, (tx) => readStanding(tx, tenantId, oct));
    expect(octStanding).toMatchObject({ creditsUsedMilli: 500, creditsTopup: 50 });
    const nov = await withTenantTx(tenantId, (tx) => readStanding(tx, tenantId, now));
    expect(nov).toMatchObject({ creditsUsedMilli: 0, indexCreditsUsedMilli: 0, creditsTopup: 0 });
  });

  it('markWarned is true once per level per period', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const key = periodOf(1, now).key;
    const results = await withTenantTx(tenantId, async (tx) => [
      await markWarned(tx, tenantId, key, 80, now),
      await markWarned(tx, tenantId, key, 80, now),
      await markWarned(tx, tenantId, key, 100, now),
      await markWarned(tx, tenantId, key, 100, now),
      await markWarned(tx, tenantId, '2026-12-01', 80, now),
    ]);
    expect(results).toEqual([true, false, true, false, true]);
    const s = await withTenantTx(tenantId, (tx) => readStanding(tx, tenantId, now));
    expect(s.warned80At).toBeInstanceOf(Date);
    expect(s.warned100At).toBeInstanceOf(Date);
  });

  it('addTopup with a repeated key adds nothing and reports created=false', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const first = await withTenantTx(tenantId, (tx) => addTopup(tx, tenantId, 30, 'same', now));
    const second = await withTenantTx(tenantId, (tx) => addTopup(tx, tenantId, 30, 'same', now));
    const third = await withTenantTx(tenantId, (tx) => addTopup(tx, tenantId, 5, 'other', now));
    expect(first).toEqual({ created: true, periodKey: '2026-11-01', creditsTopup: 30 });
    expect(second).toEqual({ created: false, periodKey: '2026-11-01', creditsTopup: 30 });
    expect(third.creditsTopup).toBe(35);
  });

  it('releaseHeldIndexJobs moves only future-dated index jobs', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const past = new Date(now.getTime() - 60_000);
    const ids = await withTenantTx(tenantId, async (tx) => {
      const held = await enqueueJob(tx, { tenantId, queue: 'version.index', idempotencyKey: 'a', payload: {}, runAt: tomorrow });
      const capture = await enqueueJob(tx, { tenantId, queue: 'capture.route', idempotencyKey: 'b', payload: {}, runAt: tomorrow });
      const due = await enqueueJob(tx, { tenantId, queue: 'version.card', idempotencyKey: 'c', payload: {}, runAt: past });
      return { held: held.id, capture: capture.id, due: due.id };
    });
    const moved = await withTenantTx(tenantId, (tx) => releaseHeldIndexJobs(tx, tenantId, now));
    expect(moved).toBe(1);
    const runAt = async (id: string) =>
      (await withTenantTx(tenantId, (tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0]!.runAt.getTime();
    expect(await runAt(ids.held)).toBe(now.getTime());
    expect(await runAt(ids.capture)).toBe(tomorrow.getTime());
    expect(await runAt(ids.due)).toBe(past.getTime());
  });
});
