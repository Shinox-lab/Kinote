import { Server, type Extension, type Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, pages, blockActivity, enqueueJob } from '@living-wiki/db';
import { parseDocumentName } from '@living-wiki/shared';
import { authenticateCollabConnection, type CollabContext } from './auth.js';
import { directOriginOf, resolveOriginActor } from './origin.js';
import { handleInternalRequest } from './internal.js';
import {
  markStored,
  newServerState,
  registerCollabServer,
  trackWork,
  type CollabServerDeps,
} from './serverState.js';

export { resolveOriginActor, type OriginActor, type DirectOrigin } from './origin.js';
export { openDirectSession, type DirectSession } from './directSession.js';
export { collabServerDeps, collabSettle, trackCollabWork } from './serverState.js';
export { flushDocument, replaceDocumentBlocks, INTERNAL_PATHS } from './internal.js';
export { BLOCK_FRAGMENT } from './fragment.js';

export type { CollabServerDeps } from './serverState.js';

/**
 * The Hocuspocus instance the factory builds. Its websocket/HTTP server is
 * always attached (`server.server.listen(port)`, `server.server.destroy()`).
 */
export type CollabServer = Hocuspocus<CollabContext> & { server: Server<CollabContext> };

const DEFAULT_DEBOUNCE_MS = 1000;
const DEFAULT_MAX_DEBOUNCE_MS = 5000;

function requireDocumentName(name: string): { tenantId: string; pageId: string } {
  const parsed = parseDocumentName(name);
  if (!parsed) throw new Error(`Malformed collab document name: ${name}`);
  return parsed;
}

async function handleCollabChange(args: {
  documentName: string;
  context: CollabContext;
  transactionOrigin: unknown;
}) {
  const { context, transactionOrigin } = args;
  const actor = resolveOriginActor(transactionOrigin);
  // Dev visibility: one line per collab change (log only a safe shape).
  console.log(`[collab] change on ${args.documentName} (origin=${actor?.source ?? 'none'})`);
  // No actor (initial load, replayed or foreign origin): nothing to attribute.
  if (!actor) return;

  const { source, actorId, actorType } = actor;
  const changedBlockIds = directOriginOf(transactionOrigin)?.changedBlockIds;
  const { tenantId, pageId, quietSeconds } = context;

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
            actorType,
            actorId,
            changedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [blockActivity.tenantId, blockActivity.pageId, blockActivity.blockId],
            set: {
              actorType,
              actorId,
              changedAt: new Date(),
            },
          });
      }
    }

    // Schedule or push out the debounced quiet snapshot job
    const runAt = new Date(Date.now() + quietSeconds * 1000);
    await enqueueJob(tx, {
      tenantId,
      queue: 'page.snapshot',
      idempotencyKey: `quiet:${pageId}`,
      payload: {
        pageId,
        reason: 'quiet',
        actorType,
        actorId,
      },
      runAt,
    });
  });
}

/** Postgres store: the page's whole Yjs state lives in `pages.ydoc_state`. */
function pageStateStore(): Database {
  return new Database({
    async fetch({ documentName }) {
      const { tenantId, pageId } = requireDocumentName(documentName);
      return withTenantTx(tenantId, async (tx) => {
        const [row] = await tx
          .select({ ydocState: pages.ydocState })
          .from(pages)
          .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
        return row?.ydocState ?? null;
      });
    },
    async store({ documentName, state }) {
      const { tenantId, pageId } = requireDocumentName(documentName);
      await withTenantTx(tenantId, async (tx) => {
        await tx
          .update(pages)
          .set({ ydocState: Buffer.from(state) })
          .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
      });
    },
  });
}

/**
 * Builds a collab server: Hocuspocus 4 with signed-token authentication, the
 * Postgres page store, and change bookkeeping. Nothing is shared between
 * instances, so tests (and future shards) can run several side by side.
 *
 * `extraHooks` is merged in as one more extension after the built-in ones —
 * a seam for tests to observe hooks (e.g. `onChange`).
 *
 * The HTTP server defaults to port 0 (any free port) until `listen(port)`.
 */
export function createCollabServer(
  deps: CollabServerDeps,
  extraHooks?: Partial<Extension<CollabContext>>
): CollabServer {
  const state = newServerState(deps);

  const core: Extension<CollabContext> = {
    extensionName: 'LivingWikiCollab',
    // Runs before other extensions, so its onChange has started by the time a
    // direct session's transact returns.
    priority: 1000,
    async onConnect({ documentName, socketId }) {
      console.log(`[collab] ws connect ${documentName} (${socketId})`);
    },
    async onDisconnect({ documentName, socketId }) {
      console.log(`[collab] ws disconnect ${documentName} (${socketId})`);
    },
    async onAuthenticate({ token, documentName, connectionConfig }) {
      // Throws (refusing the connection) for a bad, expired, or mismatched token.
      const context = await authenticateCollabConnection(
        token,
        documentName,
        deps.collabTokenSecret
      );
      // A read-only connection may sync, but its updates are dropped and
      // answered with a negative sync status.
      connectionConfig.readOnly = context.readOnly;
      return context;
    },
    async onChange({ documentName, context, transactionOrigin }) {
      const work = handleCollabChange({ documentName, context, transactionOrigin }).catch(
        (err: unknown) => {
          // Never break the hook chain (or leave an unhandled rejection) over
          // bookkeeping; the edit itself is already applied and will be stored.
          console.error(
            `[collab] change bookkeeping failed on ${documentName}:`,
            err instanceof Error ? err.message : err
          );
        }
      );
      // Keyed by the change's context: a direct-session call stamps a fresh
      // context per transaction, so it can wait for exactly its own work.
      trackWork(state, work, context && typeof context === 'object' ? context : undefined);
      await work;
    },
    async afterStoreDocument(payload) {
      // Runs only when every onStoreDocument hook succeeded: the evidence
      // `storeDocumentNow` checks, since Hocuspocus swallows store errors.
      markStored(state, payload);
    },
    async onRequest({ request, response, instance }) {
      // The internal endpoints; every other path falls through untouched.
      await handleInternalRequest(instance, request, response);
    },
  };

  const server = new Server<CollabContext>({
    port: 0,
    quiet: true,
    // main.ts owns signal handling (it also closes the database pool).
    stopOnSignals: false,
    debounce: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxDebounce: deps.maxDebounceMs ?? DEFAULT_MAX_DEBOUNCE_MS,
    extensions: [core, pageStateStore(), ...(extraHooks ? [extraHooks as Extension] : [])],
  });

  const hocuspocus = server.hocuspocus as CollabServer;
  registerCollabServer(hocuspocus, state);
  return hocuspocus;
}
