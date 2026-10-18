import type * as Y from 'yjs';
import { isTransactionOrigin, type Document } from '@hocuspocus/server';
import { and, eq, sql } from 'drizzle-orm';
import {
  withTenantTx,
  pages,
  blockActivity,
  pagePendingContributors,
  enqueueJob,
} from '@living-wiki/db';
import { parseDocumentName } from '@living-wiki/shared';
import type { CollabContext } from './auth.js';
import { changedBlockIds, changesPage } from './attribution.js';
import { resolveOriginActor, type OriginActor } from './origin.js';
import { trackWork, type ServerState } from './serverState.js';

/** Quiet period when an origin's context carries none (spaces default to 120 s). */
const DEFAULT_QUIET_SECONDS = 120;

interface Attribution {
  tenantId: string;
  pageId: string;
  quietSeconds: number;
  actor: OriginActor;
  blockIds: string[];
}

/**
 * The collab context a transaction was made under: a websocket connection's
 * authenticated context, or a direct session's per-call context. This object
 * also keys the bookkeeping, so a direct session waits for exactly its own.
 */
function contextOf(origin: unknown): Partial<CollabContext> | undefined {
  if (!isTransactionOrigin(origin)) return undefined;
  if (origin.source === 'connection') return origin.connection?.context as Partial<CollabContext>;
  if (origin.source === 'local') return origin.context as Partial<CollabContext> | undefined;
  return undefined;
}

/**
 * One transaction's bookkeeping, in one tenant transaction. The first write
 * (the pending contributor) references the document row, so it waits behind
 * a snapshot holding that row's lock: an edit lands wholly before a snapshot
 * (and is in its contributors) or wholly after it (and is in the next one's).
 */
async function writeAttribution(a: Attribution): Promise<void> {
  const { tenantId, pageId, quietSeconds, actor, blockIds } = a;
  const { actorType, actorId, source } = actor;

  await withTenantTx(tenantId, async (tx) => {
    await tx
      .insert(pagePendingContributors)
      .values({ tenantId, pageId, principalType: actorType, principalId: actorId })
      .onConflictDoNothing({
        target: [
          pagePendingContributors.tenantId,
          pagePendingContributors.pageId,
          pagePendingContributors.principalType,
          pagePendingContributors.principalId,
        ],
      });

    if (blockIds.length > 0) {
      await tx
        .insert(blockActivity)
        .values(
          blockIds.map((blockId) => ({
            tenantId,
            pageId,
            blockId,
            actorType,
            actorId,
            changedAt: sql`now()`,
          }))
        )
        .onConflictDoUpdate({
          target: [blockActivity.tenantId, blockActivity.pageId, blockActivity.blockId],
          set: {
            actorType: sql`excluded.actor_type`,
            actorId: sql`excluded.actor_id`,
            changedAt: sql`excluded.changed_at`,
          },
        });
    }

    await tx
      .update(pages)
      .set({
        liveUpdatedAt: sql`now()`,
        liveChangedSinceSnapshot: true,
        // A restore is not an agent change, whoever runs it.
        ...(actorType === 'agent' && source === 'agent' ? { agentChangedAt: sql`now()` } : {}),
      })
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    // Schedule, or push out, the debounced quiet snapshot (a job already
    // running is asked to run again).
    await enqueueJob(tx, {
      tenantId,
      queue: 'page.snapshot',
      idempotencyKey: `quiet:${pageId}`,
      payload: { pageId, reason: 'quiet', actorType, actorId },
      runAt: new Date(Date.now() + quietSeconds * 1000),
    });
  });
}

/**
 * Records who changed the page for every transaction on `document` from now
 * on (attached in `afterLoadDocument`, so the initial load is not recorded).
 *
 * Skipped: transactions without an actor (`resolveOriginActor` is null: a
 * load, a replay, a foreign origin) and ones that change neither the block
 * fragment nor `meta`. Read-only connections never get here: Hocuspocus
 * drops their updates before applying anything.
 *
 * The changed block ids are read synchronously (the transaction is only
 * valid during the event); the writes are chained per document so they land
 * in transaction order, and tracked under the transaction's context so a
 * direct session's `transact` can wait for its own.
 */
export function recordPageTransactions(
  state: ServerState,
  document: Document,
  documentName: string
): void {
  const parsed = parseDocumentName(documentName);
  if (!parsed) return;
  const { tenantId, pageId } = parsed;

  document.on('afterTransaction', (tx: Y.Transaction) => {
    const actor = resolveOriginActor(tx.origin);
    if (!actor || !changesPage(tx)) return;
    const blockIds = changedBlockIds(tx);
    const context = contextOf(tx.origin);
    const quietSeconds =
      typeof context?.quietSeconds === 'number' ? context.quietSeconds : DEFAULT_QUIET_SECONDS;

    const previous = state.chains.get(documentName) ?? Promise.resolve();
    const work = previous
      .then(() => writeAttribution({ tenantId, pageId, quietSeconds, actor, blockIds }))
      .catch((err: unknown) => {
        // Never reject: the chain must go on, and the edit itself is applied
        // and will be stored regardless of its bookkeeping.
        console.error(
          `[collab] authorship bookkeeping failed on ${documentName}:`,
          err instanceof Error ? err.message : err
        );
      });
    state.chains.set(documentName, work);
    void work.then(() => {
      if (state.chains.get(documentName) === work) state.chains.delete(documentName);
    });
    trackWork(state, work, context && typeof context === 'object' ? context : undefined);
  });
}
