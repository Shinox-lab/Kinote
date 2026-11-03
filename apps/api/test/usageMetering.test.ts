import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { captureChanges, usageEvents, withTenantTx } from '@kinote/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '@kinote/core';
import type { CreditRates } from '@kinote/shared';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

// Deterministic providers, listed so they are charged.
const rates: CreditRates = {
  default: { input: 0, output: 0 },
  models: {
    'kinote-deterministic-2560-v1': { input: 1, output: 1 },
    'deterministic-placement-v1': { input: 1, output: 1 },
    'deterministic-answer-v1': { input: 1, output: 1 },
  },
};

describe('usage metering', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  let app: ReturnType<typeof buildTestApp>;
  const model = new DeterministicPlacementModel();
  const embedder = new DeterministicEmbeddingProvider();

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab, embeddingProvider: embedder, creditRates: rates });
  });
  useTestDb();
  afterEach(async () => {
    await collabSettle(server);
  });
  afterAll(async () => {
    await server.server.destroy();
  });

  const post = (headers: Headers, url: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url, headers, payload: payload as any });
  const run = (tenantId: string) =>
    runPendingJobsForTenant(tenantId, { collab, placementModel: model, embeddingProvider: embedder, creditRates: rates });
  const events = (tenantId: string) =>
    withTenantTx(tenantId, (tx) => tx.select().from(usageEvents).where(eq(usageEvents.tenantId, tenantId)));

  async function world(slug: string) {
    const w = await bootstrapTenant(app, { name: slug, slug });
    const space = (await post(w.headers, '/api/v1/spaces', { name: 'Eng', slug: 'eng' })).json().id as string;
    const page = await post(w.headers, '/api/v1/pages', {
      space_id: space,
      title: 'billing',
      slug: 'billing',
      markdown: 'Billing uses Stripe.\n\nInvoices go out monthly.',
    });
    expect(page.statusCode, page.body).toBe(201);
    const pageId = page.json().id as string;
    const snap = await post(w.headers, `/api/v1/pages/${pageId}/snapshot`);
    expect(snap.statusCode, snap.body).toBe(201);
    return { ...w, space, pageId };
  }

  test('Ask records an ask event, Search an index event, both with credits', async () => {
    const w = await world('ask-co');
    await run(w.tenant.id);
    const before = (await events(w.tenant.id)).length;
    expect((await post(w.headers, '/api/v1/ask', { question: 'how does billing work?' })).statusCode).toBe(200);
    const asked = (await events(w.tenant.id)).slice(before);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((e) => e.kind === 'ask' && e.principalId === w.owner.userId)).toBe(true);
    expect(asked.some((e) => e.model === 'deterministic-answer-v1')).toBe(true);
    expect(asked.every((e) => e.millicredits > 0)).toBe(true);

    const mid = (await events(w.tenant.id)).length;
    expect((await post(w.headers, '/api/v1/search', { query: 'billing' })).statusCode).toBe(200);
    const searched = (await events(w.tenant.id)).slice(mid);
    expect(searched).toHaveLength(1);
    expect(searched[0]).toMatchObject({ kind: 'index', model: 'kinote-deterministic-2560-v1' });
  });

  test('moving a captured change to another page charges its model call to the person, as capture', async () => {
    const w = await world('move-co');
    const other = await post(w.headers, '/api/v1/pages', { space_id: w.space, title: 'runbook', slug: 'runbook', markdown: 'Page the on-call.' });
    expect(other.statusCode, other.body).toBe(201);
    await post(w.headers, `/api/v1/pages/${other.json().id}/snapshot`);
    await run(w.tenant.id);
    const res = await post(w.headers, '/api/v1/captures', { text: 'Billing has a new dashboard.', scope_page_id: w.pageId });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id);
    const [change] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(captureChanges).where(eq(captureChanges.captureId, res.json().id)));
    expect(change).toBeDefined();
    const before = (await events(w.tenant.id)).length;
    const moved = await post(w.headers, `/api/v1/capture-changes/${change!.id}/move`, { target_page_id: other.json().id });
    expect(moved.statusCode, moved.body).toBe(200);
    const charged = (await events(w.tenant.id)).slice(before);
    expect(charged.length).toBeGreaterThan(0);
    expect(charged.every((e) => e.kind === 'capture' && e.principalId === w.owner.userId)).toBe(true);
  });

  test('a capture.route job records capture events; version.index records index events', async () => {
    const w = await world('cap-co');
    await run(w.tenant.id);
    const indexed = await events(w.tenant.id);
    expect(indexed.some((e) => e.kind === 'index' && e.model === 'kinote-deterministic-2560-v1')).toBe(true);
    expect(indexed.every((e) => e.kind === 'index')).toBe(true);

    const res = await post(w.headers, '/api/v1/captures', { text: 'Invoices now go out weekly.', scope_page_id: w.pageId });
    expect(res.statusCode, res.body).toBe(201);
    await run(w.tenant.id);
    const after = (await events(w.tenant.id)).slice(indexed.length);
    const captured = after.filter((e) => e.kind === 'capture');
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((e) => e.model === 'deterministic-placement-v1')).toBe(true);
  });
});
