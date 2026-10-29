import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages } from '@kinote/db';
import type { CollabServer } from '../src/server.js';
import { connectClient, startCollabServer, type ConnectedClient } from './support/wsClient.js';
import { readBlocks, writeBlocks, fragmentText } from './support/blocks.js';
import {
  buildCollabWorld,
  storedDoc,
  TEST_INTERNAL_SECRET,
  waitFor,
} from './support/collabWorld.js';
import { documentName, getCollabTokenSecret, signCollabToken } from '@kinote/shared';
import { bootstrapTenant, buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

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

  /**
   * Writes `head` (and then `body`, if any) on a raw TCP connection and
   * collects what comes back until the server closes it, or `ms` passes.
   */
  function rawRequest(
    head: string,
    opts: { body?: Buffer; ms?: number } = {}
  ): Promise<{ text: string; closed: boolean; elapsedMs: number }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const socket = net.connect(port, '127.0.0.1');
      let text = '';
      let settled = false;
      const finish = (closed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ text, closed, elapsedMs: Date.now() - started });
      };
      const timer = setTimeout(() => finish(false), opts.ms ?? 3000);
      socket.on('data', (d) => (text += d.toString('latin1')));
      socket.on('close', () => finish(true));
      socket.on('error', () => finish(true));
      socket.on('connect', () => {
        socket.write(head);
        if (opts.body) socket.write(opts.body);
      });
    });
  }

  describe('malformed request targets', () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);

    beforeAll(() => {
      process.on('unhandledRejection', onRejection);
    });

    afterAll(() => {
      process.off('unhandledRejection', onRejection);
    });

    test('targets that URL parsing rejects never crash the server', async () => {
      for (const target of ['http://[x', 'http://a:99999/', '//[', 'http://%zz/', 'http://:80/']) {
        await rawRequest(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        await rawRequest(
          `POST ${target} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`
        );
      }
      // Give any stray rejection a chance to surface.
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);

      // Still serving: the default reply and a secret-authenticated flush.
      const health = await fetch(`http://127.0.0.1:${port}/`);
      expect(health.status).toBe(200);
      const w = await buildCollabWorld(app);
      const res = await call('/internal/flush', { json: { documentName: w.docName(w.pageA.id) } });
      expect(res.status).toBe(204);
    });
  });

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

    test('an oversized declared body is 413 at once and the connection is closed unread', async () => {
      // Only the headers are sent: the reply must not wait for the 50 MB body.
      const res = await rawRequest(
        `POST /internal/flush HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
          `x-internal-secret: ${TEST_INTERNAL_SECRET}\r\nContent-Length: ${50 * 1024 * 1024}\r\n\r\n`
      );
      expect(res.text).toMatch(/^HTTP\/1\.1 413 /);
      expect(res.text.toLowerCase()).toContain('connection: close');
      expect(res.closed).toBe(true);
      expect(res.elapsedMs).toBeLessThan(2000);
    });

    test('a streamed body that grows past the cap is refused and its connection closed', async () => {
      const big = JSON.stringify({ documentName: 'x', pad: 'a'.repeat(3 * 1024 * 1024) });
      const res = await rawRequest(
        `POST /internal/flush HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
          `x-internal-secret: ${TEST_INTERNAL_SECRET}\r\nTransfer-Encoding: chunked\r\n\r\n`,
        { body: Buffer.from(`${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`) }
      );
      // The 413 may be lost to a reset while the client is still sending;
      // what matters is that the server stops reading and closes promptly.
      if (res.text) expect(res.text).toMatch(/^HTTP\/1\.1 413 /);
      expect(res.closed).toBe(true);
      expect(res.elapsedMs).toBeLessThan(2000);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    });

    test('a 401 for a huge declared body answers at once and closes the connection', async () => {
      const res = await rawRequest(
        `POST /internal/flush HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${100 * 1024 * 1024}\r\n\r\n`
      );
      expect(res.text).toMatch(/^HTTP\/1\.1 401 /);
      expect(res.text.toLowerCase()).toContain('connection: close');
      expect(res.text).toContain('"error":"unauthenticated"');
      // Closed by the server well inside the 3 s window, none of the 100 MB sent.
      expect(res.closed).toBe(true);
      expect(res.elapsedMs).toBeLessThan(2000);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
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

    test('empty blocks are 400 validation_failed and leave the document unchanged', async () => {
      const w = await buildCollabWorld(app);
      const before = readBlocks(await storedDoc(w.tenant.id, w.pageA.id));
      const res = await call('/internal/replace-blocks', {
        json: {
          documentName: w.docName(w.pageA.id),
          title: 'Nothing',
          blocks: [],
          actor: { type: 'user', id: w.owner.userId },
          source: 'restore',
        },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'validation_failed' });
      expect(readBlocks(await storedDoc(w.tenant.id, w.pageA.id))).toEqual(before);
      expect(server.documents.has(w.docName(w.pageA.id))).toBe(false);
    });

    test('source and actor type must agree: agent needs an agent, restore needs a user', async () => {
      const w = await buildCollabWorld(app);
      for (const [actor, source] of [
        [{ type: 'user', id: w.owner.userId }, 'agent'],
        [{ type: 'agent', id: w.agentId }, 'restore'],
      ] as const) {
        const res = await call('/internal/replace-blocks', {
          json: {
            documentName: w.docName(w.pageA.id),
            title: 'Mismatch',
            blocks: [paragraph('mismatch-1', 'Should not land')],
            actor,
            source,
          },
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'validation_failed' });
      }
      expect(JSON.stringify(readBlocks(await storedDoc(w.tenant.id, w.pageA.id)))).not.toContain(
        'Should not land'
      );
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

  describe('POST /internal/revoke', () => {
    /** Counts the times the client's websocket was closed under it. */
    function watchDisconnects(client: ConnectedClient) {
      const seen = { count: 0 };
      client.provider.configuration.websocketProvider.on('disconnect', () => {
        seen.count += 1;
      });
      return seen;
    }

    /** A page in a second tenant, and a write token for its owner. */
    async function otherTenantPage() {
      const other = await bootstrapTenant(app, { name: 'Elsewhere Co', slug: 'elsewhere-co' });
      const post = async (url: string, payload: unknown) => {
        const res = await app.inject({ method: 'POST', url, headers: other.headers, payload: payload as any });
        expect(res.statusCode, res.body).toBe(201);
        return res.json();
      };
      const space = await post('/api/v1/spaces', { name: 'Docs', slug: 'docs' });
      const page = await post('/api/v1/pages', { space_id: space.id, title: 'Far', slug: 'far', markdown: '# Far' });
      return {
        documentName: documentName(other.tenant.id, page.id),
        token: signCollabToken(
          { tenantId: other.tenant.id, pageId: page.id, principalType: 'user', principalId: other.owner.userId, access: 'write' },
          getCollabTokenSecret()
        ),
      };
    }

    async function fourClients() {
      const w = await buildCollabWorld(app);
      const editor = await connect({
        documentName: w.docName(w.pageA.id),
        token: w.token(w.pageA.id, 'user', w.editor.userId),
      });
      const owner = await connect({
        documentName: w.docName(w.pageB.id),
        token: w.token(w.pageB.id, 'user', w.owner.userId),
      });
      const agent = await connect({
        documentName: w.docName(w.pageA.id),
        token: w.token(w.pageA.id, 'agent', w.agentId),
      });
      const elsewhere = await connect(await otherTenantPage());
      return {
        w,
        drops: {
          editor: watchDisconnects(editor),
          owner: watchDisconnects(owner),
          agent: watchDisconnects(agent),
          elsewhere: watchDisconnects(elsewhere),
        },
      };
    }

    async function staysZero(counts: Array<{ count: number }>, ms = 300) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        expect(counts.map((c) => c.count)).toEqual(counts.map(() => 0));
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    test("with user_id it closes that user's connections in the tenant and nobody else's", async () => {
      const { w, drops } = await fourClients();
      const res = await call('/internal/revoke', {
        json: { tenant_id: w.tenant.id, user_id: w.editor.userId },
      });
      expect(res.status).toBe(204);
      await waitFor(() => drops.editor.count > 0);
      await staysZero([drops.owner, drops.agent, drops.elsewhere]);
    });

    test('without user_id it closes every connection of the tenant, and only that tenant', async () => {
      const { w, drops } = await fourClients();
      const res = await call('/internal/revoke', { json: { tenant_id: w.tenant.id } });
      expect(res.status).toBe(204);
      await waitFor(() => drops.editor.count > 0 && drops.owner.count > 0 && drops.agent.count > 0);
      await staysZero([drops.elsewhere]);
    });

    test('no or a wrong secret is 401 and closes nothing', async () => {
      const { w, drops } = await fourClients();
      for (const secret of [null, 'wrong-secret']) {
        const res = await call('/internal/revoke', { secret, json: { tenant_id: w.tenant.id } });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
      }
      await staysZero(Object.values(drops));
    });

    test('an invalid body is 400 validation_failed', async () => {
      for (const json of [{}, { tenant_id: 'nope' }, { tenant_id: randomUUID(), user_id: 'nope' }]) {
        const res = await call('/internal/revoke', { json });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'validation_failed' });
      }
    });
  });
});
