import { describe, test, beforeAll, beforeEach, afterEach, afterAll, expect } from 'vitest';
import { isTransactionOrigin } from '@hocuspocus/server';
import { getCollabTokenSecret } from '@kinote/shared';
import { createCollabServer, resolveOriginActor, type CollabServer } from '../src/server.js';
import { openDirectSession } from '../src/directSession.js';
import { connectClient, type ConnectedClient } from './support/wsClient.js';
import { buildCollabWorld, TEST_INTERNAL_SECRET, waitFor } from './support/collabWorld.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

/**
 * Pins what block authorship (Task 4.3) relies on: every change that reaches
 * `onChange` carries a transaction origin from which `resolveOriginActor`
 * recovers who made it — the websocket connection's principal for client
 * edits, the caller-supplied actor for direct-session edits — and the
 * initial document load carries no actor at all.
 */
describe('collab transaction origins', () => {
  const app = buildTestApp();
  const changes: Array<{ documentName: string; transactionOrigin: unknown }> = [];
  const clients: ConnectedClient[] = [];
  let server: CollabServer;
  let port: number;

  beforeAll(async () => {
    server = createCollabServer(
      { collabTokenSecret: getCollabTokenSecret(), internalSecret: TEST_INTERNAL_SECRET },
      {
        async onChange({ documentName, transactionOrigin }) {
          changes.push({ documentName, transactionOrigin });
        },
      }
    );
    await server.server.listen(0);
    port = server.server.address.port;
  });

  useTestDb();

  beforeEach(() => {
    changes.length = 0;
  });

  afterEach(() => {
    // Closing a test's clients unloads its documents before the next test.
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

  function changesFor(name: string) {
    return changes.filter((c) => c.documentName === name);
  }

  test('a websocket client edit resolves to the connection principal as a human', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageA.id);
    const client = await connect({
      documentName: name,
      token: w.token(w.pageA.id, 'user', w.editor.userId),
    });

    client.doc.getMap('probe').set('k', 'client');
    await waitFor(() => changesFor(name).length > 0);

    const [change] = changesFor(name);
    const origin = change!.transactionOrigin;
    expect(isTransactionOrigin(origin) && origin.source === 'connection').toBe(true);
    if (!isTransactionOrigin(origin) || origin.source !== 'connection') return;
    expect(origin.connection.context.actorId).toBe(w.editor.userId);
    expect(resolveOriginActor(origin)).toEqual({
      actorType: 'user',
      actorId: w.editor.userId,
      source: 'human',
    });
  });

  test('a direct-session agent edit resolves to the agent supplied by the call', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageA.id);
    const session = await openDirectSession(server, {
      documentName: name,
      token: w.token(w.pageA.id, 'agent', w.agentId),
    });
    await session.transact({ source: 'agent', actorId: w.agentId }, (doc) => {
      doc.getMap('probe').set('k', 'agent');
    });
    await waitFor(() => changesFor(name).length > 0);
    await session.close();

    const [change] = changesFor(name);
    const origin = change!.transactionOrigin;
    expect(isTransactionOrigin(origin) && origin.source === 'local').toBe(true);
    expect(resolveOriginActor(origin)).toEqual({
      actorType: 'agent',
      actorId: w.agentId,
      source: 'agent',
    });
  });

  test('a direct-session restore resolves to the caller actor, typed by the token principal', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageA.id);
    const session = await openDirectSession(server, {
      documentName: name,
      token: w.token(w.pageA.id, 'user', w.editor.userId),
    });
    // The restoring actor comes from the call, not the session's token.
    await session.transact({ source: 'restore', actorId: w.owner.userId }, (doc) => {
      doc.getMap('probe').set('k', 'restore');
    });
    await waitFor(() => changesFor(name).length > 0);
    await session.close();

    const [change] = changesFor(name);
    const origin = change!.transactionOrigin;
    expect(isTransactionOrigin(origin) && origin.source === 'local').toBe(true);
    expect(resolveOriginActor(origin)).toEqual({
      actorType: 'user',
      actorId: w.owner.userId,
      source: 'restore',
    });
  });

  test('consecutive direct-session transactions keep their own origins', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageA.id);
    const session = await openDirectSession(server, {
      documentName: name,
      token: w.token(w.pageA.id, 'user', w.editor.userId),
    });
    await session.transact({ source: 'restore', actorId: w.editor.userId }, (doc) => {
      doc.getMap('probe').set('k', 'first');
    });
    await session.transact({ source: 'restore', actorId: w.owner.userId }, (doc) => {
      doc.getMap('probe').set('k', 'second');
    });
    await waitFor(() => changesFor(name).length >= 2);
    await session.close();

    expect(changesFor(name).map((c) => resolveOriginActor(c.transactionOrigin)?.actorId)).toEqual([
      w.editor.userId,
      w.owner.userId,
    ]);
  });

  test('the initial document load carries no actor', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageB.id);
    // First connection loads the stored state of page B; nothing is edited.
    const client = await connect({
      documentName: name,
      token: w.token(w.pageB.id, 'user', w.editor.userId),
    });
    expect(client.doc.getXmlFragment('document-store').length).toBeGreaterThan(0);

    // Loading applies the stored state before change tracking starts, so the
    // load records no change at all (not even an actor-less one). Polled over
    // a bounded window rather than checked once after a fixed sleep.
    const end = Date.now() + 300;
    while (Date.now() < end) {
      expect(changesFor(name)).toEqual([]);
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  test('origins without an actor resolve to null', () => {
    expect(resolveOriginActor(undefined)).toBeNull();
    expect(resolveOriginActor(null)).toBeNull();
    expect(resolveOriginActor({})).toBeNull();
    expect(resolveOriginActor('some-string')).toBeNull();
    expect(resolveOriginActor({ source: 'redis' })).toBeNull();
    expect(resolveOriginActor({ source: 'local' })).toBeNull();
    expect(resolveOriginActor({ source: 'local', context: {} })).toBeNull();
    // The old v2 harness origin shape is not an actor-bearing origin any more.
    expect(resolveOriginActor({ source: 'agent', actorId: 'x' })).toBeNull();
  });
});
