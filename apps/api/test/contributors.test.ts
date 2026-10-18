import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, versionContributors, pagePendingContributors } from '@living-wiki/db';
import { collabSettle, type CollabServer } from '../../collab/src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from '../../collab/test/support/wsClient.js';
import { readBlocks, fragmentText } from '../../collab/test/support/blocks.js';
import { editBlockText } from '../../collab/test/support/editBlock.js';
import { buildReviewWorld, waitFor } from '../../collab/test/support/collabWorld.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { buildTestApp, useTestDb } from './support/testkit.js';

/**
 * Snapshot contributors come from who actually edited since the previous
 * snapshot (recorded by collab from each transaction's origin), so nobody who
 * typed into a pending snapshot can approve it in a space without
 * self-approval, and contributors never carry over to the next snapshot.
 */
describe('snapshot contributors and self-approval', () => {
  let server: CollabServer;
  let port: number;
  let app: ReturnType<typeof buildTestApp>;
  const clients: ConnectedClient[] = [];

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
    app = buildTestApp({ collab: new InProcessCollabClient(server) });
  });

  useTestDb();

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await collabSettle(server);
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  async function connect(documentName: string, token: string) {
    const client = await connectClient({ port, documentName, token });
    clients.push(client);
    return client;
  }

  async function landed(name: string, text: string) {
    await waitFor(() => {
      const doc = server.documents.get(name);
      return !!doc && fragmentText(doc).includes(text);
    });
    await collabSettle(server);
  }

  async function contributorsOf(tenantId: string, versionId: string) {
    const rows = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(versionContributors)
        .where(
          and(eq(versionContributors.tenantId, tenantId), eq(versionContributors.versionId, versionId))
        )
    );
    return rows.map((r) => `${r.principalType}:${r.principalId}`).sort();
  }

  async function pendingOf(tenantId: string, pageId: string) {
    return withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(pagePendingContributors)
        .where(
          and(
            eq(pagePendingContributors.tenantId, tenantId),
            eq(pagePendingContributors.pageId, pageId)
          )
        )
    );
  }

  test('both editors of one block are contributors; the one who reviews cannot approve; the next snapshot starts fresh', async () => {
    const w = await buildReviewWorld(app);
    const ca = await connect(w.name, w.token('user', w.a.userId));
    const cb = await connect(w.name, w.token('user', w.b.userId));
    const first = readBlocks(ca.doc)[0]!.id as string;

    editBlockText(ca.doc, first, ' A was here');
    await landed(w.name, 'A was here');
    await waitFor(() => fragmentText(cb.doc).includes('A was here'));
    editBlockText(cb.doc, first, ' and B too');
    await landed(w.name, 'and B too');

    // B submits: the version holds both edits, and both editors contributed.
    const snap = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/snapshot`,
      headers: w.b.headers,
    });
    expect(snap.statusCode, snap.body).toBe(201);
    const v1 = snap.json();
    expect(v1.status).toBe('pending_review');
    expect(v1.markdown).toContain('A was here and B too');
    expect(await contributorsOf(w.tenant.id, v1.id)).toEqual(
      [`user:${w.a.userId}`, `user:${w.b.userId}`].sort()
    );
    expect(await pendingOf(w.tenant.id, w.page.id)).toEqual([]);

    // A typed into it, so A cannot approve it (though B took the snapshot).
    const byA = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v1.id}/approve`,
      headers: w.a.headers,
      payload: {},
    });
    expect(byA.statusCode).toBe(409);
    expect(byA.json().error).toBe('self_approval');

    const byR = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${v1.id}/approve`,
      headers: w.r.headers,
      payload: {},
    });
    expect(byR.statusCode, byR.body).toBe(200);

    // After that snapshot only C edits: C alone contributed to the next one.
    const cc = await connect(w.name, w.token('user', w.c.userId));
    const third = readBlocks(cc.doc)[2]!.id as string;
    editBlockText(cc.doc, third, ' C later');
    await landed(w.name, 'C later');
    const snap2 = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/snapshot`,
      headers: w.c.headers,
    });
    expect(snap2.statusCode, snap2.body).toBe(201);
    expect(await contributorsOf(w.tenant.id, snap2.json().id)).toEqual([`user:${w.c.userId}`]);
  });

  test('an agent edit makes the agent a contributor; a human who did not edit approves it', async () => {
    const w = await buildReviewWorld(app);
    const { openDirectSession } = await import('../../collab/src/server.js');
    const ca = await connect(w.name, w.token('user', w.a.userId));
    const second = readBlocks(ca.doc)[1]!.id as string;
    const session = await openDirectSession(server, {
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
    const snap = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.page.id}/snapshot`,
      headers: w.a.headers,
    });
    expect(snap.statusCode, snap.body).toBe(201);
    expect(await contributorsOf(w.tenant.id, snap.json().id)).toEqual(
      [`agent:${w.agentId}`, `user:${w.a.userId}`].sort()
    );
    const byR = await app.inject({
      method: 'POST',
      url: `/api/v1/versions/${snap.json().id}/approve`,
      headers: w.r.headers,
      payload: {},
    });
    expect(byR.statusCode, byR.body).toBe(200);
  });
});
