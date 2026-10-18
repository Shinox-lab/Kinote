import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages, blockActivity, jobs } from '@living-wiki/db';
import { verifyCollabToken, type CollabContext } from './auth.js';

export interface TransactionOrigin {
  source: 'human' | 'agent' | 'restore';
  actorId: string;
  changedBlockIds?: string[];
}

// The Y.XmlFragment name inside each page's Y.Doc that holds the BlockNote
// blocks. Must stay in sync with apps/api (encodePageYDoc) and apps/worker
// (snapshot handler).
const BLOCK_FRAGMENT = 'document-store';

const blocknoteEditor = ServerBlockNoteEditor.create();

// Track in-flight onChange work so local sessions can await it (the shared
// onChange hook below is fire-and-forget inside hocuspocus).
let inflightChanges = 0;

export async function collabSettle(): Promise<void> {
  while (inflightChanges > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface CollabSession {
  documentName: string;
  transact(origin: TransactionOrigin, fn: (doc: unknown) => void): Promise<void>;
  close(): Promise<void>;
}

// Full Hocuspocus configuration shape plus the convenience API this module
// attaches to the same server singleton (used by the test/live-check harness).
interface CollabServerLike {
  openSession(args: { documentName: string; token: string }): Promise<CollabSession>;
  activeDocs: {
    clear(): void;
  };
  documents: Map<string, { destroy(): void }>;
  openDirectConnection(documentName: string, context: unknown): Promise<any>;
}

// A view over the block list stored in the shared XmlFragment. Reading gives
// the current BlockNote blocks; writes (index assignment, push, replace) mark
// the view dirty and are written back to the fragment when flushed.
function createBlocksView(doc: any) {
  const frag = doc.getXmlFragment(BLOCK_FRAGMENT);
  let blocks = blocknoteEditor.yXmlFragmentToBlocks(frag) as any[];
  let dirty = false;

  const blocksProxy = new Proxy(blocks, {
    set: (target, key, value) => {
      const ok = Reflect.set(target, key, value);
      dirty = true;
      return ok;
    },
    deleteProperty: (target, key) => {
      const ok = Reflect.deleteProperty(target, key);
      dirty = true;
      return ok;
    },
  });

  return {
    proxy: blocksProxy,
    setBlocks: (next: any[]) => {
      blocks = next;
      dirty = true;
    },
    flush: () => {
      if (!dirty) return false;
      const valid = blocks.map(normalizeBlock);
      blocknoteEditor.blocksToYXmlFragment(valid as any, frag);
      dirty = false;
      return true;
    },
  };
}

// Test/e2e blocks use the simplified shape {id, type, text, markdown?, level?}.
// Convert those into valid BlockNote blocks before writing to the Y.Doc. Real
// BlockNote block objects pass through untouched.
function normalizeBlock(block: any): any {
  if (!block || block.content) return block;
  const text = block.text != null ? String(block.text) : '';
  return {
    id: block.id,
    type: block.type,
    ...(block.type === 'heading' && block.level ? { props: { level: block.level } } : {}),
    content: text ? [{ type: 'text', styles: {}, text }] : [],
  };
}

// Attach a live `.blocks` view on the ydoc handed to session callbacks, so
// callers can do `ydoc.blocks = [...]` or `ydoc.blocks.push(...)` while the
// underlying state stays in the Y.Doc XmlFragment.
function attachBlocks(doc: any, view: ReturnType<typeof createBlocksView>) {
  return new Proxy(doc, {
    get: (target, key, receiver) => {
      if (key === 'blocks') return view.proxy;
      return Reflect.get(target, key, receiver);
    },
    set: (target, key, value, receiver) => {
      if (key === 'blocks') {
        view.setBlocks(value);
        return true;
      }
      return Reflect.set(target, key, value, receiver);
    },
  });
}

async function openSession({
  documentName,
  token,
}: {
  documentName: string;
  token: string;
}): Promise<CollabSession> {
  // documentName format: "{tenantId}:{pageDocumentId}"
  const [tenantId, pageId] = documentName.split(':');
  const context = await verifyCollabToken(token, tenantId, pageId);
  const conn = await (collabServer as unknown as CollabServerLike).openDirectConnection(
    documentName,
    context
  );

  return {
    documentName,
    async transact(origin, fn) {
      // The Yjs transaction origin doubles as hocuspocus's "connection" on the
      // update path: handleDocumentUpdate reads `connection.context` to fill
      // the onChange hook payload, so the collab context must ride along.
      const contextedOrigin = { ...origin, context };
      await conn.transact((doc: any) => {
        doc.transact(() => {
          const view = createBlocksView(doc);
          fn(attachBlocks(doc, view));
          view.flush();
        }, contextedOrigin);
      }, contextedOrigin);
      // Wait until the deferred onChange bookkeeping above has landed.
      await collabSettle();
    },
    async close() {
      await conn.disconnect();
    },
  };
}

async function handleCollabChange(args: {
  documentName: string;
  context: CollabContext;
  transactionOrigin: unknown;
}) {
  const { context, transactionOrigin } = args;
  // Dev visibility: one line per collab change (origin may embed timers/doc
  // state, so log only a safe shape — never the raw object).
  const originKind =
    transactionOrigin && typeof transactionOrigin === 'object'
      ? (transactionOrigin as { source?: unknown }).source ?? transactionOrigin.constructor?.name
      : String(transactionOrigin);
  console.log(`[collab] change on ${args.documentName} (origin=${String(originKind)})`);
  const origin = (transactionOrigin ?? {}) as Partial<TransactionOrigin>;
  const resolvedOrigin: TransactionOrigin = {
    source: origin.source ?? (context.actorType === 'agent' ? 'agent' : 'human'),
    actorId: origin.actorId ?? context.actorId,
    changedBlockIds: origin.changedBlockIds,
  };
  const { tenantId, pageId, quietSeconds } = context;
  const {
    source,
    actorId,
    changedBlockIds,
  } = resolvedOrigin;

  await withTenantTx(tenantId, async (tx) => {
    await tx
      .update(pages)
      .set({
        liveUpdatedAt: new Date(),
        liveChangedSinceSnapshot: true,
        ...(source === 'agent' ? { agentChangedAt: new Date() } : {}),
      })
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    if (changedBlockIds?.length) {
      for (const blockId of changedBlockIds) {
        await tx
          .insert(blockActivity)
          .values({
            tenantId,
            pageId,
            blockId,
            actorType: source === 'agent' ? 'agent' : 'user',
            actorId,
            changedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [blockActivity.tenantId, blockActivity.pageId, blockActivity.blockId],
            set: {
              actorType: source === 'agent' ? 'agent' : 'user',
              actorId,
              changedAt: new Date(),
            },
          });
      }
    }

    // Schedule or push out the debounced quiet snapshot job
    const runAt = new Date(Date.now() + quietSeconds * 1000);
    await tx
      .insert(jobs)
      .values({
        tenantId,
        queue: 'page.snapshot',
        idempotencyKey: `quiet:${pageId}`,
        payload: {
          pageId,
          reason: 'quiet',
          actorType: source === 'agent' ? 'agent' : 'user',
          actorId,
        },
        runAt,
      })
      .onConflictDoUpdate({
        target: [jobs.tenantId, jobs.queue, jobs.idempotencyKey],
        set: { runAt, status: 'queued' },
      });
  });
}

export const collabServer = Server.configure({
  async onConnect({ documentName, socketId }) {
    console.log(`[collab] ws connect ${documentName} (${socketId})`);
  },
  async onDisconnect({ documentName, socketId, document }) {
    console.log(`[collab] ws disconnect ${documentName} (${socketId})`);
  },
  async onAuthenticate({ token, documentName }) {
    console.log(`[collab] ws auth ${documentName}`);
    // documentName format: "{tenantId}:{pageDocumentId}"
    const [tenantId, pageId] = documentName.split(':');
    const context = await verifyCollabToken(token, tenantId, pageId);
    return context; // { tenantId, pageId, spaceId, actorType, actorId, quietSeconds }
  },

  async onChange(args: { documentName: string; context: CollabContext; transactionOrigin: unknown }) {
    inflightChanges += 1;
    try {
      await handleCollabChange(args);
    } finally {
      inflightChanges -= 1;
    }
  },

  extensions: [
    new Database({
      async fetch({ documentName }) {
        const [tenantId, pageId] = documentName.split(':');
        return withTenantTx(tenantId, async (tx) => {
          const [row] = await tx
            .select({ ydocState: pages.ydocState })
            .from(pages)
            .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
          return row?.ydocState ?? null;
        });
      },
      async store({ documentName, state }) {
        const [tenantId, pageId] = documentName.split(':');
        await withTenantTx(tenantId, async (tx) => {
          await tx
            .update(pages)
            .set({ ydocState: Buffer.from(state) })
            .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
        });
      },
    }),
  ],
}) as unknown as CollabServerLike;

// Convenience API on the same server instance used by the test/live-check
// harness: `collabServer.activeDocs.clear()` and `collabServer.openSession(...)`.

(collabServer as unknown as CollabServerLike).openSession = openSession;
(collabServer as unknown as CollabServerLike).activeDocs = {
  clear() {
    for (const doc of collabServer.documents.values()) {
      try {
        doc.destroy();
      } catch {
        // ignore: document already torn down
      }
    }
    (collabServer.documents as unknown as { clear(): void }).clear();
  },
};
