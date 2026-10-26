import { and, eq } from 'drizzle-orm';
import {
  enqueueJob,
  entityEdges,
  entityMentions,
  pageCards,
  spaces,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import { deleteOrphanEntities, previousEntityIds } from './entities.js';

/** The placement jobs of an indexed version: a card for a page, entities for any document. */
export async function enqueuePlacementJobs(
  tx: DbTransaction,
  tenantId: string,
  versionId: string,
  documentKind: 'page' | 'file'
): Promise<void> {
  if (documentKind === 'page') {
    await enqueueJob(tx, { tenantId, queue: 'version.card', idempotencyKey: `card:${versionId}`, payload: { versionId } });
  }
  await enqueueJob(tx, {
    tenantId,
    queue: 'version.entities',
    idempotencyKey: `entities:${versionId}`,
    payload: { versionId },
  });
}

/**
 * Removes the document's card, mentions and edges, then the entities nothing
 * else mentions (Rule 9: removing is fast). Called in the transaction that
 * deletes the document's chunks.
 */
export async function deletePlacementIndex(tx: DbTransaction, tenantId: string, documentId: string): Promise<void> {
  const previous = await previousEntityIds(tx, tenantId, documentId);
  await tx.delete(pageCards).where(and(eq(pageCards.tenantId, tenantId), eq(pageCards.documentId, documentId)));
  await tx.delete(entityEdges).where(and(eq(entityEdges.tenantId, tenantId), eq(entityEdges.documentId, documentId)));
  await tx
    .delete(entityMentions)
    .where(and(eq(entityMentions.tenantId, tenantId), eq(entityMentions.documentId, documentId)));
  await deleteOrphanEntities(tx, tenantId, previous);
}

/**
 * After a cross-space move whose chunks moved with the document (Rule 4):
 * into the Inbox the card and graph rows go (R17); elsewhere they take the new
 * space; out of the Inbox the indexed version gets its placement jobs, since
 * nothing was built while it was there. `doc` is the row from before the move.
 */
export async function movePlacementIndex(
  tx: DbTransaction,
  tenantId: string,
  doc: DocumentRow,
  target: { spaceId: string; kind: 'normal' | 'inbox' }
): Promise<void> {
  if (target.kind === 'inbox') {
    await deletePlacementIndex(tx, tenantId, doc.id);
    return;
  }
  const [from] = await tx
    .select({ kind: spaces.kind })
    .from(spaces)
    .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, doc.spaceId)));
  if (from?.kind === 'inbox') {
    if (doc.indexedVersionId) await enqueuePlacementJobs(tx, tenantId, doc.indexedVersionId, doc.kind);
    return;
  }
  const set = { spaceId: target.spaceId };
  await tx.update(pageCards).set(set).where(and(eq(pageCards.tenantId, tenantId), eq(pageCards.documentId, doc.id)));
  await tx
    .update(entityMentions)
    .set(set)
    .where(and(eq(entityMentions.tenantId, tenantId), eq(entityMentions.documentId, doc.id)));
  await tx.update(entityEdges).set(set).where(and(eq(entityEdges.tenantId, tenantId), eq(entityEdges.documentId, doc.id)));
}
