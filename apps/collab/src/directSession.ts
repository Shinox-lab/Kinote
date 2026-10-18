import type * as Y from 'yjs';
import type { Hocuspocus } from '@hocuspocus/server';
import { AppError } from '@living-wiki/contracts';
import { authenticateCollabConnection } from './auth.js';
import type { DirectOrigin, DirectSessionContext } from './origin.js';
import { collabServerDeps, collabSettle } from './serverState.js';

export interface DirectSession {
  /**
   * Runs `fn` as one Yjs transaction on the live document. The change is
   * attributed to `origin` (see `resolveOriginActor`), stored to Postgres
   * right away, and its change bookkeeping has landed when this resolves.
   */
  transact(origin: DirectOrigin, fn: (doc: Y.Doc) => void): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens a server-side editing session on a page document, for agent edits
 * and restores. The token is verified exactly like a websocket connection's
 * (signature, expiry, document match, role re-read from the database); a
 * read-only context (viewer, read token, archived page) is refused.
 */
export async function openDirectSession(
  server: Hocuspocus,
  args: { documentName: string; token: string }
): Promise<DirectSession> {
  const { documentName, token } = args;
  const { collabTokenSecret } = collabServerDeps(server);
  const context = await authenticateCollabConnection(token, documentName, collabTokenSecret);
  if (context.readOnly) {
    throw new AppError('forbidden', 'This collab session is read-only.');
  }
  const conn = await server.openDirectConnection(documentName, context);
  let closed = false;

  return {
    async transact(origin, fn) {
      if (closed || !conn.document) throw new Error('Direct collab session is closed.');
      if (
        (origin.source !== 'agent' && origin.source !== 'restore') ||
        typeof origin.actorId !== 'string' ||
        origin.actorId === ''
      ) {
        throw new Error('A direct collab transaction needs an agent or restore origin and an actor id.');
      }
      // Hocuspocus 4 stamps each direct transaction with
      // `{ source: 'local', context: conn.context }`, read when transact is
      // called. A fresh context object per call carries this call's actor
      // without leaking into earlier or later transactions.
      const txContext: DirectSessionContext = {
        ...context,
        directOrigin: {
          source: origin.source,
          actorId: origin.actorId,
          ...(origin.changedBlockIds ? { changedBlockIds: [...origin.changedBlockIds] } : {}),
        },
      };
      conn.context = txContext;
      try {
        await conn.transact((doc) => fn(doc));
      } finally {
        conn.context = context;
      }

      // Server-side edits are persisted immediately rather than waiting out
      // the store debounce, so a caller that snapshots right after sees them.
      const document = conn.document;
      await server.storeDocumentHooks(
        document,
        {
          clientsCount: document.getConnectionsCount(),
          lastContext: txContext,
          lastTransactionOrigin: { source: 'local', context: txContext },
          document,
          documentName,
          instance: server,
        },
        true
      );
      await collabSettle(server);
    },
    async close() {
      if (closed) return;
      closed = true;
      await conn.disconnect();
    },
  };
}
