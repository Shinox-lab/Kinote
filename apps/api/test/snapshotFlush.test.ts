import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages, versions } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import type { CollabServer } from '../../collab/src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from '../../collab/test/support/wsClient.js';
import { readBlocks, writeBlocks, fragmentText } from '../../collab/test/support/blocks.js';
import { buildCollabWorld, storedDoc, waitFor } from '../../collab/test/support/collabWorld.js';
import { HttpCollabClient, type CollabClient } from '../src/collab/client.js';
import { encodePageYDoc } from '../src/routes/pages.js';
import { InProcessCollabClient } from './support/inProcessCollab.js';
import { buildTestApp, useTestDb } from './support/testkit.js';

/**
 * A manual snapshot captures what the user sees right now: the API asks the
 * collab server to store the live document before reading `pages.ydoc_state`.
 * The collab store debounce is a minute here, so only the flush can have
 * stored text typed a moment before the snapshot.
 */
describe('manual snapshots flush the live document first', () => {
  let server: CollabServer;
  let port: number;
  let collab: CollabClient;
  let app: ReturnType<typeof buildTestApp>;
  const clients: ConnectedClient[] = [];

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(undefined, {
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    }));
    collab = new InProcessCollabClient(server);
    app = buildTestApp({ collab });
  });

  useTestDb();

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  async function versionCount(tenantId: string, pageId: string) {
    const rows = await withTenantTx(tenantId, (tx) =>
      tx
        .select({ id: versions.id })
        .from(versions)
        .where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, pageId)))
    );
    return rows.length;
  }

  test('the snapshot includes text typed less than a second earlier', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageA.id);
    const TEXT = 'Typed a moment before pressing submit';
    const client = await connectClient({
      port,
      documentName: name,
      token: w.token(w.pageA.id, 'user', w.editor.userId),
    });
    clients.push(client);
    writeBlocks(client.doc, [
      ...readBlocks(client.doc),
      { id: 'fresh-paragraph', type: 'paragraph', text: TEXT },
    ]);
    await waitFor(() => fragmentText(server.documents.get(name)!).includes(TEXT));
    // A stale read of the database would miss it.
    expect(fragmentText(await storedDoc(w.tenant.id, w.pageA.id))).not.toContain(TEXT);

    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.pageA.id}/snapshot`,
      headers: w.editor.headers,
    });
    expect(res.statusCode, res.body).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/versions/${res.json().id}`,
      headers: w.editor.headers,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().markdown).toContain(TEXT);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test('a failed flush fails the snapshot (500 internal_error) and creates no version', async () => {
    let failFlush = true;
    const stub: CollabClient = {
      async flush() {
        if (failFlush) throw new AppError('internal_error');
      },
      async replaceBlocks() {},
      async revoke() {},
    };
    const stubApp = buildTestApp({ collab: stub });
    const w = await buildCollabWorld(stubApp);
    // The stored live state differs from version 1, so a snapshot would be taken.
    const state = await encodePageYDoc('Page A', 'Changed body that is not yet a version.');
    await withTenantTx(w.tenant.id, (tx) =>
      tx
        .update(pages)
        .set({ ydocState: state })
        .where(and(eq(pages.tenantId, w.tenant.id), eq(pages.documentId, w.pageA.id)))
        .then(() => undefined)
    );
    const before = await versionCount(w.tenant.id, w.pageA.id);

    const res = await stubApp.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.pageA.id}/snapshot`,
      headers: w.editor.headers,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'internal_error' });
    expect(await versionCount(w.tenant.id, w.pageA.id)).toBe(before);

    // The same request succeeds once the flush does: the 500 was the flush.
    failFlush = false;
    const ok = await stubApp.inject({
      method: 'POST',
      url: `/api/v1/pages/${w.pageA.id}/snapshot`,
      headers: w.editor.headers,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await versionCount(w.tenant.id, w.pageA.id)).toBe(before + 1);
  });

  test('the HTTP client turns a refused call into internal_error', async () => {
    const w = await buildCollabWorld(app);
    const wrong = new HttpCollabClient(
      `http://127.0.0.1:${port}`,
      'not-the-internal-secret-0123456789abcdef'
    );
    await expect(wrong.flush(w.docName(w.pageA.id))).rejects.toMatchObject({
      code: 'internal_error',
    });
    const unreachable = new HttpCollabClient('http://127.0.0.1:1', 'x'.repeat(40));
    await expect(unreachable.flush(w.docName(w.pageA.id))).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  test('replaceBlocks through the HTTP client changes the live page', async () => {
    const w = await buildCollabWorld(app);
    await collab.replaceBlocks({
      tenantId: w.tenant.id,
      pageId: w.pageA.id,
      title: 'Replaced over HTTP',
      blocks: [
        {
          id: 'http-1',
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: 'Replaced through the client', styles: {} }],
          children: [],
        },
      ],
      actor: { type: 'user', id: w.owner.userId },
      source: 'restore',
    });
    const stored = await storedDoc(w.tenant.id, w.pageA.id);
    expect(JSON.stringify(readBlocks(stored))).toContain('Replaced through the client');
    expect(stored.getMap('meta').get('title')).toBe('Replaced over HTTP');
  });
});
