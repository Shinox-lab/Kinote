import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, versionContributors, pagePendingContributors } from '@living-wiki/db';
import { collabSettle, openDirectSession, type CollabServer } from '../../collab/src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from '../../collab/test/support/wsClient.js';
import { readBlocks, fragmentText } from '../../collab/test/support/blocks.js';
import { editBlockText } from '../../collab/test/support/editBlock.js';
import { buildReviewWorld, waitFor } from '../../collab/test/support/collabWorld.js';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { buildTestApp, useTestDb } from './support/testkit.js';

type App = ReturnType<typeof buildTestApp>;
type World = Awaited<ReturnType<typeof buildReviewWorld>>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Shared harness: a collab server (long store debounce: only flushes store),
 * the API wired to it through the real HTTP collab client, and helpers.
 */
function harness(deps: Parameters<typeof startCollabServer>[1] = {}) {
  const h = {} as {
    server: CollabServer;
    port: number;
    app: App;
    clients: ConnectedClient[];
  };
  h.clients = [];

  beforeAll(async () => {
    ({ server: h.server, port: h.port } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
      ...deps,
    }));
    h.app = buildTestApp({ collab: new InProcessCollabClient(h.server) });
  });

  useTestDb();

  afterEach(async () => {
    for (const c of h.clients.splice(0)) c.destroy();
    await collabSettle(h.server);
  });

  afterAll(async () => {
    await h.server.server.destroy();
  });

  return h;
}

async function contributorsOf(tenantId: string, versionId: string) {
  const rows = await withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(versionContributors)
      .where(and(eq(versionContributors.tenantId, tenantId), eq(versionContributors.versionId, versionId)))
  );
  return rows.map((r) => `${r.principalType}:${r.principalId}`).sort();
}

async function pendingOf(tenantId: string, pageId: string) {
  return withTenantTx(tenantId, (tx) =>
    tx
      .select()
      .from(pagePendingContributors)
      .where(
        and(eq(pagePendingContributors.tenantId, tenantId), eq(pagePendingContributors.pageId, pageId))
      )
  );
}

const users = (...ids: string[]) => ids.map((id) => `user:${id}`).sort();

/**
 * Snapshot contributors come from who actually edited the content a version
 * holds (recorded by collab from each transaction's origin, plus the page's
 * creator), so nobody who wrote into a pending snapshot can approve it in a
 * space without self-approval. Contributors of versions not yet approved and
 * indexed carry over; after an indexed version the next one starts fresh.
 */
describe('snapshot contributors and self-approval', () => {
  const h = harness();

  async function connect(w: World, principalId: string) {
    const client = await connectClient({
      port: h.port,
      documentName: w.name,
      token: w.token('user', principalId),
    });
    h.clients.push(client);
    return client;
  }

  async function landed(name: string, text: string) {
    await waitFor(() => {
      const doc = h.server.documents.get(name);
      return !!doc && fragmentText(doc).includes(text);
    });
    await collabSettle(h.server);
  }

  async function edit(w: World, principalId: string, blockIndex: number, text: string) {
    const client = await connect(w, principalId);
    editBlockText(client.doc, readBlocks(client.doc)[blockIndex]!.id as string, text);
    await landed(w.name, text);
  }

  async function snapshot(w: World, headers: Record<string, string>) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/snapshot`,
      headers,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function review(versionId: string, headers: Record<string, string>, action: 'approve' | 'reject') {
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/versions/${versionId}/${action}`,
      headers,
      payload: action === 'reject' ? { review_note: 'Not like this.' } : {},
    });
  }

  test('both editors of one block (and the creator) are contributors; the one who reviews cannot approve; after indexing the next snapshot starts fresh', async () => {
    const w = await buildReviewWorld(app());
    const ca = await connect(w, w.a.userId);
    const cb = await connect(w, w.b.userId);
    const first = readBlocks(ca.doc)[0]!.id as string;

    editBlockText(ca.doc, first, ' A was here');
    await landed(w.name, 'A was here');
    await waitFor(() => fragmentText(cb.doc).includes('A was here'));
    editBlockText(cb.doc, first, ' and B too');
    await landed(w.name, 'and B too');

    // B submits: the version holds both edits, and both editors contributed,
    // as did the owner who created the page with its initial text.
    const v1 = await snapshot(w, w.b.headers);
    expect(v1.status).toBe('pending_review');
    expect(v1.markdown).toContain('A was here and B too');
    expect(await contributorsOf(w.tenant.id, v1.id)).toEqual(users(w.owner.userId, w.a.userId, w.b.userId));
    expect(await pendingOf(w.tenant.id, w.page.id)).toEqual([]);

    // A typed into it, so A cannot approve it (though B took the snapshot).
    const byA = await review(v1.id, w.a.headers, 'approve');
    expect(byA.statusCode).toBe(409);
    expect(byA.json().error).toBe('self_approval');

    const byR = await review(v1.id, w.r.headers, 'approve');
    expect(byR.statusCode, byR.body).toBe(200);
    await runPendingJobsForTenant(w.tenant.id);

    // V1 is indexed; after it only C edits: C alone contributed to the next one.
    await edit(w, w.c.userId, 2, ' C later');
    const v2 = await snapshot(w, w.c.headers);
    expect(await contributorsOf(w.tenant.id, v2.id)).toEqual(users(w.c.userId));
  });

  test('a superseded version carries its contributors: A cannot approve B\'s fix on top of A\'s unreviewed text', async () => {
    const w = await buildReviewWorld(app());
    await edit(w, w.a.userId, 0, ' A wrote this');
    const v1 = await snapshot(w, w.a.headers);
    expect(await contributorsOf(w.tenant.id, v1.id)).toEqual(users(w.owner.userId, w.a.userId));

    await edit(w, w.b.userId, 1, ' typo fixed by B');
    const v2 = await snapshot(w, w.b.headers);
    expect(v2.markdown).toContain('A wrote this');
    expect(await contributorsOf(w.tenant.id, v2.id)).toEqual(
      users(w.owner.userId, w.a.userId, w.b.userId)
    );
    const byA = await review(v2.id, w.a.headers, 'approve');
    expect(byA.statusCode).toBe(409);
    expect(byA.json().error).toBe('self_approval');

    // Once V2 is approved and indexed, a later version by C is C's alone.
    expect((await review(v2.id, w.r.headers, 'approve')).statusCode).toBe(200);
    await runPendingJobsForTenant(w.tenant.id);
    await edit(w, w.c.userId, 2, ' C afterwards');
    const v3 = await snapshot(w, w.c.headers);
    expect(await contributorsOf(w.tenant.id, v3.id)).toEqual(users(w.c.userId));
  });

  test('a rejected version carries its contributors to the next snapshot', async () => {
    const w = await buildReviewWorld(app());
    await edit(w, w.a.userId, 0, ' A wrote this');
    const v1 = await snapshot(w, w.a.headers);
    const rejected = await review(v1.id, w.r.headers, 'reject');
    expect(rejected.statusCode, rejected.body).toBe(200);

    await edit(w, w.b.userId, 1, ' B on top');
    const v2 = await snapshot(w, w.b.headers);
    expect(await contributorsOf(w.tenant.id, v2.id)).toEqual(
      users(w.owner.userId, w.a.userId, w.b.userId)
    );
  });

  test('the page creator contributes: an owner who created the page cannot approve its first snapshot', async () => {
    const w = await buildReviewWorld(app());
    await edit(w, w.b.userId, 1, ' only B edited');
    const v1 = await snapshot(w, w.b.headers);
    expect(await contributorsOf(w.tenant.id, v1.id)).toEqual(users(w.owner.userId, w.b.userId));
    const byOwner = await review(v1.id, w.headers, 'approve');
    expect(byOwner.statusCode).toBe(409);
    expect(byOwner.json().error).toBe('self_approval');
    expect((await review(v1.id, w.r.headers, 'approve')).statusCode).toBe(200);
  });

  test('an agent edit makes the agent a contributor; a human who did not edit approves it', async () => {
    const w = await buildReviewWorld(app());
    const ca = await connect(w, w.a.userId);
    const second = readBlocks(ca.doc)[1]!.id as string;
    const session = await openDirectSession(h.server, {
      documentName: w.name,
      token: w.token('agent', w.agentId),
    });
    try {
      await session.transact({ source: 'agent', actorId: w.agentId }, (doc) =>
        editBlockText(doc, second, ' agent note')
      );
    } finally {
      await session.close();
    }
    const v1 = await snapshot(w, w.a.headers);
    expect(await contributorsOf(w.tenant.id, v1.id)).toEqual(
      [`agent:${w.agentId}`, ...users(w.owner.userId, w.a.userId)].sort()
    );
    const byR = await review(v1.id, w.r.headers, 'approve');
    expect(byR.statusCode, byR.body).toBe(200);
  });

  function app() {
    return h.app;
  }
});

/**
 * A manual snapshot right after someone typed: the flush stores the text and
 * also waits for the bookkeeping of what it stored, so the typist is a
 * contributor of the version holding their text. The bookkeeping is slowed
 * down here so that a flush that did not wait would lose the race every time.
 */
describe('a manual snapshot waits for the bookkeeping of what it flushed', () => {
  const h = harness({ testHooks: { beforeBookkeeping: () => sleep(400) } });

  test('text typed a moment before another user submits counts its author', async () => {
    const w = await buildReviewWorld(h.app);
    const ca = await connectClient({ port: h.port, documentName: w.name, token: w.token('user', w.a.userId) });
    h.clients.push(ca);
    editBlockText(ca.doc, readBlocks(ca.doc)[0]!.id as string, ' typed just now by A');
    // Only until the server has the text: no settle, no sleep.
    await waitFor(() => fragmentText(h.server.documents.get(w.name)!).includes('typed just now by A'));

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/snapshot`,
      headers: w.b.headers,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().markdown).toContain('typed just now by A');
    expect(await contributorsOf(w.tenant.id, res.json().id)).toContain(`user:${w.a.userId}`);
  });
});
