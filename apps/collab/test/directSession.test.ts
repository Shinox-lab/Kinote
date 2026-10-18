import { describe, test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages } from '@living-wiki/db';
import { collabSettle, openDirectSession, trackCollabWork, type CollabServer } from '../src/server.js';
import { startCollabServer } from './support/wsClient.js';
import { buildCollabWorld, storedDoc } from './support/collabWorld.js';
import { buildTestApp, useTestDb } from '../../api/test/support/testkit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Direct-session guarantees: a transaction resolves once ITS bookkeeping has
 * landed (unrelated in-flight work elsewhere on the server does not hold it
 * up), and a store that fails rejects the transaction instead of passing as saved.
 */
describe('direct collab sessions', () => {
  const app = buildTestApp();
  let server: CollabServer;
  let failStores = false;

  beforeAll(async () => {
    ({ server } = await startCollabServer(
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
  });

  afterAll(async () => {
    await server.server.destroy();
  });

  async function agentChangedAt(tenantId: string, pageId: string) {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx
        .select({ agentChangedAt: pages.agentChangedAt })
        .from(pages)
        .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)))
    );
    return row!.agentChangedAt;
  }

  test('transact waits for its own bookkeeping only, not unrelated in-flight work', async () => {
    const w = await buildCollabWorld(app);
    let release!: () => void;
    const unrelated = new Promise<void>((r) => (release = r));
    trackCollabWork(server, unrelated);

    const session = await openDirectSession(server, {
      documentName: w.docName(w.pageA.id),
      token: w.token(w.pageA.id, 'agent', w.agentId),
    });
    try {
      const outcome = await Promise.race([
        session
          .transact({ source: 'agent', actorId: w.agentId }, (doc) => {
            // A page change (the title): only page content is attributed.
            doc.getMap('meta').set('title', 'Retitled by the agent');
          })
          .then(() => 'done'),
        sleep(3000).then(() => 'still waiting'),
      ]);
      expect(outcome).toBe('done');
      // Its own bookkeeping did land before it resolved.
      expect(await agentChangedAt(w.tenant.id, w.pageA.id)).not.toBeNull();

      // The server-wide settle (shutdown) still waits for everything.
      const settled = await Promise.race([
        collabSettle(server).then(() => 'settled'),
        sleep(200).then(() => 'waiting'),
      ]);
      expect(settled).toBe('waiting');
    } finally {
      release();
      await session.close();
    }
    await collabSettle(server);
  });

  test('a failed store rejects the transaction with internal_error', async () => {
    const w = await buildCollabWorld(app);
    const session = await openDirectSession(server, {
      documentName: w.docName(w.pageA.id),
      token: w.token(w.pageA.id, 'user', w.editor.userId),
    });
    try {
      failStores = true;
      await expect(
        session.transact({ source: 'restore', actorId: w.editor.userId }, (doc) => {
          doc.getMap('probe').set('k', 'not saved');
        })
      ).rejects.toMatchObject({ code: 'internal_error' });
      expect((await storedDoc(w.tenant.id, w.pageA.id)).getMap('probe').get('k')).toBeUndefined();

      // Once storing works again the same session saves normally.
      failStores = false;
      await session.transact({ source: 'restore', actorId: w.editor.userId }, (doc) => {
        doc.getMap('probe').set('k', 'saved');
      });
      expect((await storedDoc(w.tenant.id, w.pageA.id)).getMap('probe').get('k')).toBe('saved');
    } finally {
      failStores = false;
      await session.close();
    }
  });
});
