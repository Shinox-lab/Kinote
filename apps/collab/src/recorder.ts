import type * as Y from 'yjs';
import { isTransactionOrigin, type Document } from '@hocuspocus/server';
import { and, eq, sql } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  pages,
  blockActivity,
  pagePendingContributors,
  enqueueJob,
} from '@kinote/db';
import { parseDocumentName } from '@kinote/shared';
import type { CollabContext } from './auth.js';
import { changedBlockIds, changesPage } from './attribution.js';
import { resolveOriginActor, type OriginActor } from './origin.js';
import { trackWork, type ServerState } from './serverState.js';

/** Quiet period when an origin's context carries none (spaces default to 120 s). */
const DEFAULT_QUIET_SECONDS = 120;

export interface Attribution {
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
 * One transaction's bookkeeping, in one tenant transaction.
 *
 * Lock protocol with `takePageSnapshot`: the first statement takes FOR KEY
 * SHARE on the page's document row, which conflicts with the snapshot's
 * `lockDocument` (FOR UPDATE). So this write waits while a snapshot holds the
 * lock, and a snapshot's `lockDocument` waits for a write already under way.
 * A write therefore commits wholly before a snapshot reads (and consumes) the
 * pending contributors, or wholly after it commits; never in between. It is
 * explicit because the inserts below cannot be relied on for it: an insert
 * that hits ON CONFLICT DO NOTHING fires no foreign-key check and so takes no
 * lock on the document row.
 *
 * What this does not guarantee is that a consumed contributor's edit is in
 * the snapshot's content: that holds when the snapshot stored the live
 * document first and waited for its bookkeeping (a manual snapshot: the
 * flush, see `storeDocumentNow`). The quiet snapshot does not flush, so an
 * edit made after its job was claimed but not yet stored can have its
 * pending row consumed by that snapshot while its text lands in the next
 * version. The gap is bounded: the quiet delay (>= 10 s) is longer than the
 * store's max debounce (5 s), so the stored state is normally current when
 * the quiet snapshot runs.
 */
export async function writeAttribution(a: Attribution): Promise<void> {
  const { tenantId, pageId, quietSeconds, actor, blockIds } = a;
  const { actorType, actorId, source } = actor;

  await withTenantTx(tenantId, async (tx) => {
    await tx
      .select({ one: sql`1` })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)))
      .for('key share');

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
 * direct session's `transact` can wait for its own. Because the link is
 * queued inside the transaction, every transaction already applied has its
 * link on the chain: `storeDocumentNow` waits for the chain's tail after
 * storing, so a flushed state's authors are recorded before a snapshot reads
 * the pending contributors.
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
    const beforeWrite = state.deps.testHooks?.beforeBookkeeping;
    const work = previous
      .then(async () => {
        if (beforeWrite) await beforeWrite(documentName);
        await writeAttribution({ tenantId, pageId, quietSeconds, actor, blockIds });
      })
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
