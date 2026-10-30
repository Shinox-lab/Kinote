import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { versions, withTenantTx } from '@kinote/db';
import { DeterministicEmbeddingProvider, DeterministicPlacementModel } from '@kinote/core';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { startCollabServer } from '../../collab/test/support/wsClient.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { bootstrapTenant, buildTestApp, signUpMember, useTestDb } from './support/testkit.js';

type Headers = Record<string, string>;

/**
 * GET /api/v1/attention: the pages and files that need someone, across the spaces the caller can read: failed first,
 * then waiting for a reviewer, then unindexed changes. Clean, archived and unreadable documents are left out.
 */
describe('what needs attention', () => {
  let server: CollabServer;
  let collab: InProcessCollabClient;
  let app: ReturnType<typeof buildTestApp>;
  const model = new DeterministicPlacementModel();
  const embedder = new DeterministicEmbeddingProvider();

  beforeAll(async () => {
    ({ server } = await startCollabServer(undefined, { debounceMs: 60_000, maxDebounceMs: 60_000 }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab, embeddingProvider: embedder });
  });
  useTestDb();
  afterEach(async () => collabSettle(server));
  afterAll(async () => server.server.destroy());

  const post = (headers: Headers, url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers, payload: payload as any });
  const get = (headers: Headers, url: string) => app.inject({ method: 'GET', url, headers });

  async function world() {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Care Co', slug: 'care-co' });
    const run = () => runPendingJobsForTenant(tenant.id, { collab, placementModel: model, embeddingProvider: embedder });
    const space = async (slug: string, review: boolean) => (await post(headers, '/api/v1/spaces', { name: slug, slug, review_required: review })).json().id as string;
    const open = await space('team', false);
    const held = await space('clients', true);
    const secret = await space('secret', false);
    const page = async (spaceId: string, title: string) => {
      const res = await post(headers, '/api/v1/pages', { space_id: spaceId, title, slug: title.toLowerCase().replace(/\W+/g, '-'), markdown: `${title} text.` });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const snapshot = async (pageId: string) => {
      const res = await post(headers, `/api/v1/pages/${pageId}/snapshot`);
      expect(res.statusCode, res.body).toBeLessThan(300);
      await run();
    };
    const reader = await signUpMember(app, tenant.id, 'member');
    for (const s of [open, held]) await post(headers, `/api/v1/spaces/${s}/grants`, { principal_type: 'user', principal_id: reader.userId, role: 'viewer' });
    return { tenant, headers, open, held, secret, page, snapshot, reader };
  }

  test('lists failed, then waiting for review, then unindexed; leaves out clean, archived and unreadable ones', async () => {
    const w = await world();
    const clean = await w.page(w.open, 'Clean');
    await w.snapshot(clean);
    const draft = await w.page(w.open, 'Draft');
    const waiting = await w.page(w.held, 'Waiting');
    await w.snapshot(waiting);
    const broken = await w.page(w.open, 'Broken');
    await w.snapshot(broken);
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(versions).set({ status: 'failed' }).where(and(eq(versions.tenantId, w.tenant.id), eq(versions.documentId, broken))),
    );
    const archived = await w.page(w.open, 'Archived');
    expect((await post(w.headers, `/api/v1/pages/${archived}/archive`)).statusCode).toBe(200);
    await w.page(w.secret, 'Secret draft');

    const res = await get(w.reader.headers, '/api/v1/attention');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json() as Array<{ reason: string; badge: string; document: { id: string; title: string; spaceName: string } }>;
    expect(items.map((i) => [i.reason, i.document.title])).toEqual([
      ['failed', 'Broken'],
      ['review', 'Waiting'],
      ['unindexed', 'Draft'],
    ]);
    expect(items[0]!.badge).toBe('Index failed');
    expect(items[1]!.badge).toBe('Saved · not indexed (awaiting approval)');
    expect(items[1]!.document.spaceName).toBe('clients');
    expect(items[2]!.badge).toBe('Saved · indexing soon');
    void draft;
    void clean;

    // The owner reads every space, so the secret draft is there too.
    const mine = (await get(w.headers, '/api/v1/attention')).json() as Array<{ document: { title: string } }>;
    expect(mine.map((i) => i.document.title)).toContain('Secret draft');
  });
});
