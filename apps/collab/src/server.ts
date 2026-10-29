import { Server, type Extension, type Hocuspocus } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { and, eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { withTenantTx, pages, pageFieldValues } from '@living-wiki/db';
import { FIELDS_MAP } from '@living-wiki/contracts';
import { parseDocumentName } from '@living-wiki/shared';
import { authenticateCollabConnection, type CollabContext } from './auth.js';
import { handleInternalRequest } from './internal.js';
import { recordPageTransactions } from './recorder.js';
import {
  markStored,
  newServerState,
  registerCollabServer,
  type CollabServerDeps,
} from './serverState.js';

export { resolveOriginActor, type OriginActor, type DirectOrigin } from './origin.js';
export { openDirectSession, type DirectSession } from './directSession.js';
export { collabServerDeps, collabSettle, trackCollabWork } from './serverState.js';
export { flushDocument, replaceDocumentBlocks, INTERNAL_PATHS } from './internal.js';
export { BLOCK_FRAGMENT } from './fragment.js';
export { changedBlockIds, changesPage } from './attribution.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rewrites the page's `page_field_values` from its `fields` map: one row per
 * key, raw (never checked against the collection's fields; readers do that).
 * A key that isn't a field id can't be one, so it is left out.
 */
async function mirrorFieldValues(
  tx: Parameters<Parameters<typeof withTenantTx>[1]>[0],
  tenantId: string,
  pageId: string,
  state: Uint8Array
): Promise<void> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const rows = Object.entries(doc.getMap(FIELDS_MAP).toJSON())
    .filter(([key, value]) => UUID_RE.test(key) && value !== undefined && value !== null)
    .map(([fieldId, value]) => ({ tenantId, pageId, fieldId, value }));
  await tx.delete(pageFieldValues).where(and(eq(pageFieldValues.tenantId, tenantId), eq(pageFieldValues.pageId, pageId)));
  if (rows.length > 0) await tx.insert(pageFieldValues).values(rows);
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
      const bytes = Buffer.from(state);
      await withTenantTx(tenantId, async (tx) => {
        // A store that changes the stored state also marks the page
        // live-changed (R20), so a snapshot that read the older state just
        // before this landed cannot leave the page looking unchanged since
        // it. Identical bytes change nothing and are not written again.
        const changed = await tx
          .update(pages)
          .set({ ydocState: bytes, liveUpdatedAt: sql`now()`, liveChangedSinceSnapshot: true })
          .where(
            and(
              eq(pages.tenantId, tenantId),
              eq(pages.documentId, pageId),
              sql`${pages.ydocState} IS DISTINCT FROM ${bytes}`
            )
          )
          .returning({ id: pages.documentId });
        // Collection views read field values from this mirror, kept in the
        // same transaction as the state it mirrors.
        if (changed.length > 0) await mirrorFieldValues(tx, tenantId, pageId, state);
      });
    },
  });
}

/**
 * Builds a collab server: Hocuspocus 4 with signed-token authentication, the
 * Postgres page store, and per-transaction authorship bookkeeping. Nothing
 * is shared between instances, so tests (and future shards) can run several
 * side by side.
 *
 * `extraHooks` is merged in as one more extension after the built-in ones —
 * a seam for tests to observe hooks (e.g. `onChange`, `onStoreDocument`).
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
    // First among the extensions: its afterLoadDocument attaches the
    // transaction recorder before anything else can touch the loaded document.
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
    async afterLoadDocument({ document, documentName }) {
      // Attached after the stored state was applied: the initial load is
      // never attributed. Every later transaction with an actor is recorded.
      recordPageTransactions(state, document, documentName);
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
    ...(deps.address ? { address: deps.address } : {}),
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
