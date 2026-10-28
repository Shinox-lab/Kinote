import { and, desc, eq, inArray } from 'drizzle-orm';
import { chunks, documents, versions, type DbTransaction, type DocumentRow } from '@living-wiki/db';
import { chunkInboxOwner } from '../indexing/inboxOwner.js';
import { deletePlacementIndex, movePlacementIndex } from '../placement/derived.js';

/**
 * Sends a document moved into a review space back to review: its chunks leave
 * the index and exactly one version is left waiting for review, so nothing it
 * held can reach the index again without a reviewer (Rule 9: adding is gated).
 *
 * "Newer pending" below means the latest version is `pending_review` and is not
 * the indexed one. "Newest live" is the highest-numbered version among the
 * indexed, indexing and failed ones.
 *
 * | status before      | newer pending exists | otherwise                                |
 * |--------------------|----------------------|------------------------------------------|
 * | `pending_review`   | stays pending        | (n/a: it would be the newer pending)     |
 * | `indexed`          | `superseded`         | `pending_review` if newest live, else `superseded` |
 * | `indexing`         | `superseded`         | `pending_review` if newest live, else `superseded` |
 * | `failed`           | `superseded`         | `pending_review` if newest live, else `superseded` |
 * | anything else      | unchanged            | unchanged                                |
 *
 * A failed version sent back to review loses its error text (Retry, which
 * only accepts `failed`, then refuses it). The caller holds the document lock
 * and clears `indexed_version_id`.
 */
export async function returnToReview(tx: DbTransaction, tenantId: string, doc: DocumentRow) {
  const candidates = await tx
    .select({ id: versions.id, number: versions.number, status: versions.status })
    .from(versions)
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, doc.id),
        inArray(versions.status, ['indexed', 'indexing', 'failed', 'pending_review'])
      )
    )
    .orderBy(desc(versions.number));

  const latestPending = candidates.find(
    (v) => v.id === doc.latestVersionId && v.status === 'pending_review' && v.id !== doc.indexedVersionId
  );
  const live = candidates.filter((v) => v.status === 'indexed' || v.status === 'indexing' || v.status === 'failed');
  const keep = latestPending ? null : live[0] ?? null;
  const supersede = live.filter((v) => v.id !== keep?.id).map((v) => v.id);

  if (keep) {
    await tx
      .update(versions)
      .set({ status: 'pending_review', indexedAt: null, error: null })
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, keep.id)));
  }
  if (supersede.length > 0) {
    await tx
      .update(versions)
      .set({ status: 'superseded' })
      .where(and(eq(versions.tenantId, tenantId), inArray(versions.id, supersede)));
  }
  await tx.delete(chunks).where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, doc.id)));
  await deletePlacementIndex(tx, tenantId, doc.id);
}

export interface RelocateTarget {
  spaceId: string;
  spaceKind: 'normal' | 'inbox';
  reviewRequired: boolean;
  /** Whether whoever moves it may approve in the target space: then a review space takes it as it is. */
  moverReviews: boolean;
  parentId: string | null;
  position?: string;
}

/**
 * Moves a file to another place, keeping search and placement in step: into
 * another space its chunks and placement rows follow it, except into a review
 * space for someone who can't approve there, where it goes back to review.
 * Permission checks are the caller's. Callers hold the document lock.
 */
export async function relocateFile(tx: DbTransaction, tenantId: string, doc: DocumentRow, target: RelocateTarget): Promise<DocumentRow> {
  let indexedVersionId = doc.indexedVersionId;
  if (doc.spaceId !== target.spaceId) {
    if (target.reviewRequired && !target.moverReviews) {
      await returnToReview(tx, tenantId, doc);
      indexedVersionId = null;
    } else {
      await tx
        .update(chunks)
        .set({ spaceId: target.spaceId, inboxOwner: chunkInboxOwner(target.spaceKind, doc) })
        .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, doc.id)));
      await movePlacementIndex(tx, tenantId, doc, { spaceId: target.spaceId, kind: target.spaceKind });
    }
  }
  const [updated] = await tx
    .update(documents)
    .set({
      spaceId: target.spaceId,
      parentId: target.parentId,
      ...(target.position !== undefined ? { position: target.position } : {}),
      placement: 'pinned',
      indexedVersionId,
    })
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.id)))
    .returning();
  return updated!;
}
