import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages } from '@living-wiki/db';
import type { CollabServer } from '../src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from './support/wsClient.js';
import { readBlocks, writeBlocks, fragmentText } from './support/blocks.js';
import {
  buildCollabWorld,
  storedDoc,
  TEST_INTERNAL_SECRET,
  waitFor,
} from './support/collabWorld.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

/**
 * The privileged API-to-collab endpoints (Task 4.2). Only the shared internal
 * secret opens them. The store debounce is a minute here, so anything found in
 * `pages.ydoc_state` during a test was stored by a flush or a direct session,
 * never by the debounce.
 */
describe('collab internal endpoints', () => {
  const app = buildTestApp();
  const clients: ConnectedClient[] = [];
  let server: CollabServer;
  let port: number;
  let failStores = false;

  beforeAll(async () => {
    ({ server, port } = await startCollabServer(
      {
        // Ahead of the Postgres store (priority 100), so a failure means nothing was written.
        priority: 500,
        async onStoreDocument() {
          if (failStores) throw new Error('simulated store failure');
        },
      },
      { debounceMs: 60_000, maxDebounceMs: 60_000 }
    ));
  });

  useTestDb();

  afterEach(() => {
    failStores = false;
    for (const c of clients.splice(0)) c.destroy();
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  async function connect(args: { documentName: string; token: string }) {
    const client = await connectClient({ port, ...args });
    clients.push(client);
    return client;
  }

  function call(
    path: string,
    init: { method?: string; secret?: string | null; body?: string; json?: unknown } = {}
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const secret = init.secret === undefined ? TEST_INTERNAL_SECRET : init.secret;
    if (secret !== null) headers['x-internal-secret'] = secret;
    const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'POST',
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  }

  async function pageRow(tenantId: string, pageId: string) {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(pages)
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
    );
    return row!;
  }

  function paragraph(id: string, text: string) {
    return { id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] };
  }

  describe('authentication and request handling', () => {
    test('no secret is 401 unauthenticated', async () => {
      const res = await call('/internal/flush', { secret: null, json: { documentName: 'x' } });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
    });

    test('a wrong secret (same or different length) is 401', async () => {
      const sameLength = TEST_INTERNAL_SECRET.replace(/.$/, '?');
      for (const secret of [sameLength, 'short', `${TEST_INTERNAL_SECRET}-longer`]) {
        const res = await call('/internal/replace-blocks', { secret, json: {} });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
      }
    });

    test('only POST is accepted', async () => {
      const res = await call('/internal/flush', { method: 'GET' });
      expect(res.status).toBe(405);
    });

    test('malformed JSON is 400 validation_failed', async () => {
      const res = await call('/internal/flush', { body: '{"documentName": ' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed' });
    });

    test('an oversized body is 413', async () => {
      const big = JSON.stringify({ documentName: 'x', pad: 'a'.repeat(3 * 1024 * 1024) });
      const res = await call('/internal/flush', { body: big });
      expect(res.status).toBe(413);
    });

    test('a malformed document name is 400', async () => {
      const res = await call('/internal/flush', { json: { documentName: 'not-a-document' } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed' });
    });

    test('non-internal paths fall through to the Hocuspocus default response', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/Hocuspocus/);
    });
  });

  describe('POST /internal/flush', () => {
    test('stores a loaded document immediately: text typed a moment ago is in pages.ydoc_state', async () => {
      const w = await buildCollabWorld(app);
      const name = w.docName(w.pageA.id);
      const TEXT = 'Typed just now and flushed before the debounce';
      const client = await connect({
        documentName: name,
        token: w.token(w.pageA.id, 'user', w.editor.userId),
      });
      writeBlocks(client.doc, [
        ...readBlocks(client.doc),
        { id: 'flushed-paragraph', type: 'paragraph', text: TEXT },
      ]);
      // The edit has reached the server, but the minute-long debounce has not stored it.
      await waitFor(() => fragmentText(server.documents.get(name)!).includes(TEXT));
      expect(fragmentText(await storedDoc(w.tenant.id, w.pageA.id))).not.toContain(TEXT);

      const res = await call('/internal/flush', { json: { documentName: name } });
      expect(res.status).toBe(204);

      const stored = await storedDoc(w.tenant.id, w.pageA.id);
      const blocks = readBlocks(stored);
      expect(blocks.map((b) => b.id)).toContain('flushed-paragraph');
      expect(JSON.stringify(blocks)).toContain(TEXT);
    });

    test('a document that is not loaded is 204: nothing to flush', async () => {
      const w = await buildCollabWorld(app);
      const res = await call('/internal/flush', { json: { documentName: w.docName(w.pageB.id) } });
      expect(res.status).toBe(204);
    });

    test('a failed store is 500 internal_error, not a silent 204', async () => {
      const w = await buildCollabWorld(app);
      const name = w.docName(w.pageA.id);
      const client = await connect({
        documentName: name,
        token: w.token(w.pageA.id, 'user', w.editor.userId),
      });
      client.doc.getMap('probe').set('k', 'unsaved');
      await waitFor(() => server.documents.get(name)?.getMap('probe').get('k') === 'unsaved');

      failStores = true;
      const res = await call('/internal/flush', { json: { documentName: name } });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ error: 'internal_error' });
    });
  });

  describe('POST /internal/replace-blocks', () => {
    test('a connected client observes the new blocks and title; a restore leaves agent_changed_at null', async () => {
      const w = await buildCollabWorld(app);
      const name = w.docName(w.pageA.id);
      const client = await connect({
        documentName: name,
        token: w.token(w.pageA.id, 'user', w.editor.userId),
      });
      expect(fragmentText(client.doc)).toContain('A');

      const res = await call('/internal/replace-blocks', {
        json: {
          documentName: name,
          title: 'Restored title',
          blocks: [paragraph('restored-1', 'Restored body text')],
          actor: { type: 'user', id: w.owner.userId },
          source: 'restore',
        },
      });
      expect(res.status).toBe(204);

      await waitFor(() => readBlocks(client.doc).some((b) => b.id === 'restored-1'));
      const blocks = readBlocks(client.doc);
      // The fragment was replaced, not appended to: the old "# A" heading is gone.
      expect(blocks.map((b) => b.id)).toEqual(['restored-1']);
      expect(JSON.stringify(blocks)).toContain('Restored body text');
      await waitFor(() => client.doc.getMap('meta').get('title') === 'Restored title');

      // Stored right away (no debounce) and attributed as a restore.
      const stored = await storedDoc(w.tenant.id, w.pageA.id);
      expect(JSON.stringify(readBlocks(stored))).toContain('Restored body text');
      expect(stored.getMap('meta').get('title')).toBe('Restored title');
      const row = await pageRow(w.tenant.id, w.pageA.id);
      expect(row.agentChangedAt).toBeNull();
      expect(row.liveChangedSinceSnapshot).toBe(true);
    });

    test('an agent replace sets agent_changed_at', async () => {
      const w = await buildCollabWorld(app);
      const name = w.docName(w.pageA.id);
      const res = await call('/internal/replace-blocks', {
        json: {
          documentName: name,
          title: 'Agent title',
          blocks: [paragraph('agent-1', 'Written by the agent')],
          actor: { type: 'agent', id: w.agentId },
          source: 'agent',
        },
      });
      expect(res.status).toBe(204);
      const row = await pageRow(w.tenant.id, w.pageA.id);
      expect(row.agentChangedAt).not.toBeNull();
      const stored = await storedDoc(w.tenant.id, w.pageA.id);
      expect(JSON.stringify(readBlocks(stored))).toContain('Written by the agent');
    });

    test('a page that does not exist is 404 page_not_found', async () => {
      const w = await buildCollabWorld(app);
      const res = await call('/internal/replace-blocks', {
        json: {
          documentName: w.docName(randomUUID()),
          title: 'Ghost',
          blocks: [paragraph('ghost-1', 'Nowhere')],
          actor: { type: 'user', id: w.owner.userId },
          source: 'restore',
        },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'page_not_found' });
    });

    test('an invalid body is 400 validation_failed', async () => {
      const w = await buildCollabWorld(app);
      const res = await call('/internal/replace-blocks', {
        json: {
          documentName: w.docName(w.pageA.id),
          title: 'No source',
          blocks: [],
          actor: { type: 'user', id: w.owner.userId },
        },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed' });
    });
  });
});
