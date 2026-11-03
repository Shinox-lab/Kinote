import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { captures, getDb, periodOf, tenantLimits, tenantUsage, withTenantTx } from '@kinote/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '@kinote/core';
import type { CreditRates } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

const rates: CreditRates = {
  default: { input: 0, output: 0 },
  models: { 'deterministic-placement-v1': { input: 1000, output: 1000 } },
};

/** "1 Dec": the day the current period (anchor day 1) ends. */
function renewalDay(): string {
  const end = periodOf(1, new Date()).end;
  return `${end.getUTCDate()} ${end.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

describe('AI credit enforcement', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  const model = new DeterministicPlacementModel();
  const embedder = new DeterministicEmbeddingProvider();
  let app: ReturnType<typeof buildTestApp>;
  let billed: ReturnType<typeof buildTestApp>;

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab, embeddingProvider: embedder, creditRates: rates });
    billed = buildTestApp({ collab, embeddingProvider: embedder, creditRates: rates, billingUrl: 'https://billing.example/up' });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const post = (a: typeof app, headers: Headers, url: string, payload: unknown = {}) =>
    a.inject({ method: 'POST', url, headers, payload: payload as any });
  const capture = (a: typeof app, headers: Headers) => post(a, headers, '/api/v1/captures', { text: 'Invoices go out weekly now.' });
  const ask = (a: typeof app, headers: Headers) => post(a, headers, '/api/v1/ask', { question: 'how are invoices sent?' });

  async function world(slug: string) {
    const w = await bootstrapTenant(app, { name: slug, slug });
    const space = await post(app, w.headers, '/api/v1/spaces', { name: 'Eng', slug: 'eng' });
    expect(space.statusCode, space.body).toBe(201);
    return w;
  }

  async function setLimits(tenantId: string, creditsPerMonth: number) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .insert(tenantLimits)
        .values({ tenantId, creditsPerMonth })
        .onConflictDoUpdate({ target: tenantLimits.tenantId, set: { creditsPerMonth } })
    );
  }

  async function setUsed(tenantId: string, credits: number) {
    const period = periodOf(1, new Date()).key;
    await withTenantTx(tenantId, (tx) =>
      tx
        .insert(tenantUsage)
        .values({ tenantId, period, creditsUsedMilli: credits * 1000 })
        .onConflictDoUpdate({
          target: [tenantUsage.tenantId, tenantUsage.period],
          set: { creditsUsedMilli: credits * 1000 },
        })
    );
  }

  async function usedMilli(tenantId: string) {
    const [row] = await withTenantTx(tenantId, (tx) => tx.select().from(tenantUsage).where(eq(tenantUsage.tenantId, tenantId)));
    return row?.creditsUsedMilli ?? 0;
  }

  test('a workspace past grace cannot capture or ask, and is told when credits renew', async () => {
    const w = await world('spent-co');
    await setLimits(w.tenant.id, 100);
    await setUsed(w.tenant.id, 110);
    for (const res of [await capture(app, w.headers), await ask(app, w.headers)]) {
      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error).toBe('credits_exhausted');
      expect(body.message).toBe(`This workspace has used this month's AI credits. They renew on ${renewalDay()}.`);
      expect(body.resetsAt).toBe(periodOf(1, new Date()).end.toISOString());
      expect(body.billingUrl).toBeUndefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
  });

  test('billingUrl is in the refusal only when configured', async () => {
    const w = await world('billed-co');
    await setLimits(w.tenant.id, 10);
    await setUsed(w.tenant.id, 11);
    const res = await capture(billed, w.headers);
    expect(res.statusCode).toBe(429);
    expect(res.json().billingUrl).toBe('https://billing.example/up');
  });

  test('inside grace the capture is accepted', async () => {
    const w = await world('grace-co');
    await setLimits(w.tenant.id, 100);
    await setUsed(w.tenant.id, 109);
    expect((await capture(app, w.headers)).statusCode).toBe(201);
    expect((await ask(app, w.headers)).statusCode).toBe(200);
  });

  test('a limit lowered below usage refuses the next capture', async () => {
    const w = await world('downgrade-co');
    await setLimits(w.tenant.id, 1000);
    await setUsed(w.tenant.id, 500);
    expect((await capture(app, w.headers)).statusCode).toBe(201);
    await setLimits(w.tenant.id, 100);
    expect((await capture(app, w.headers)).json().error).toBe('credits_exhausted');
  });

  test('work already queued finishes and is charged past the limit', async () => {
    const w = await world('inflight-co');
    await setLimits(w.tenant.id, 100);
    expect((await capture(app, w.headers)).statusCode).toBe(201);
    expect((await capture(app, w.headers)).statusCode).toBe(201);
    await setUsed(w.tenant.id, 110);
    await runPendingJobsForTenant(w.tenant.id, { collab, placementModel: model, embeddingProvider: embedder, creditRates: rates });
    const rows = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captures).where(eq(captures.tenantId, w.tenant.id)));
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.status !== 'queued' && c.status !== 'routing')).toBe(true);
    expect(await usedMilli(w.tenant.id)).toBeGreaterThan(110_000);
  });

  test('an unreadable standing lets the capture through', async () => {
    const w = await world('failopen-co');
    await setLimits(w.tenant.id, 1);
    await setUsed(w.tenant.id, 100);
    const db = getDb();
    await db.execute(sql`RESET ROLE`);
    await db.execute(sql`ALTER TABLE tenant_usage RENAME TO tenant_usage_gone`);
    await db.execute(sql`SET ROLE kinote_app`);
    try {
      expect((await capture(app, w.headers)).statusCode).toBe(201);
    } finally {
      await db.execute(sql`RESET ROLE`);
      await db.execute(sql`ALTER TABLE tenant_usage_gone RENAME TO tenant_usage`);
      await db.execute(sql`SET ROLE kinote_app`);
    }
  });
});
