import { describe, test, afterEach, expect } from 'vitest';
import { getCollabTokenSecret } from '@kinote/shared';
import { createCollabServer, type CollabServer } from '../src/server.js';
import { connectClient, type ConnectedClient } from './support/wsClient.js';
import { readBlocks, writeBlocks, fragmentText } from './support/blocks.js';
import {
  buildCollabWorld,
  storedDoc,
  TEST_INTERNAL_SECRET,
  waitFor,
} from './support/collabWorld.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

/**
 * Live content is saved continuously: a websocket edit reaches
 * `pages.ydoc_state` through the debounced store hook while the client is
 * still connected, and a fresh server instance on the same database serves it.
 */
describe('collab persistence', () => {
  const app = buildTestApp();
  const servers: CollabServer[] = [];
  const clients: ConnectedClient[] = [];

  useTestDb();

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    for (const s of servers.splice(0)) await s.server.destroy();
  });

  async function start(): Promise<{ server: CollabServer; port: number }> {
    // The production debounce (1000 ms, max 5000 ms): the poll below allows 8 s.
    const server = createCollabServer({
      collabTokenSecret: getCollabTokenSecret(),
      internalSecret: TEST_INTERNAL_SECRET,
    });
    servers.push(server);
    await server.server.listen(0);
    return { server, port: server.server.address.port };
  }

  test('a websocket edit is stored and a second server instance serves it', async () => {
    const w = await buildCollabWorld(app);
    const name = w.docName(w.pageA.id);
    const token = () => w.token(w.pageA.id, 'user', w.editor.userId);
    const TEXT = 'Typed over the websocket and never lost';

    const first = await start();
    const client = await connectClient({ port: first.port, documentName: name, token: token() });
    clients.push(client);
    writeBlocks(client.doc, [
      ...readBlocks(client.doc),
      { id: 'persisted-paragraph', type: 'paragraph', text: TEXT },
    ]);

    // Stored while the client is still connected (no disconnect flush).
    await waitFor(
      async () => fragmentText(await storedDoc(w.tenant.id, w.pageA.id)).includes(TEXT),
      8000
    );

    client.destroy();
    clients.splice(clients.indexOf(client), 1);
    await first.server.server.destroy();
    servers.splice(servers.indexOf(first.server), 1);

    const second = await start();
    const reader = await connectClient({ port: second.port, documentName: name, token: token() });
    clients.push(reader);
    expect(fragmentText(reader.doc)).toContain(TEXT);
    expect(readBlocks(reader.doc).map((b) => b.id)).toContain('persisted-paragraph');
  });
});
