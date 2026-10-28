import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  rowsOf,
  documents,
  versions,
  chunks,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { requireDocumentRole, assertValidUuid, deletePlacementIndex, type Actor } from '@living-wiki/core';

// Lifecycle rules shared by pages and files: the same document lock order, the
// same review-return table, the same cycle check. Callers hold the document lock.

/**
 * Checks that `parentId` is a live page in `spaceId` that the actor can see,
 * or throws 404 `parent_not_found`. Visibility includes the Inbox rule, so
 * another member's Inbox item behaves exactly like a nonexistent parent (same
 * status, code and message) and can never get children it does not know of.
 */
export async function requireVisibleParent(
  tx: DbTransaction,
  actor: Actor,
  parentId: string,
  spaceId: string
): Promise<void> {
  assertValidUuid(parentId, 'parent_not_found');
  const [parentDoc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, parentId)));
  if (
    !parentDoc ||
    parentDoc.spaceId !== spaceId ||
    parentDoc.kind !== 'page' ||
    parentDoc.archivedAt !== null
  ) {
    throw new AppError('parent_not_found');
  }
  await requireDocumentRole(tx, actor, parentDoc, 'viewer', { notFound: 'parent_not_found' });
}

/**
 * Takes a document out of the index (Rule 9: removing is fast): every version
 * that is extracting, indexed, indexing, failed, stored or waiting for review becomes `withdrawn`
 * and the document's chunks are deleted. `failed` is included so a withdrawn
 * page can never be revived by Retry (which only accepts `failed`). The caller
 * holds the document lock and clears `indexed_version_id`.
 */
export async function withdrawLiveVersions(tx: DbTransaction, tenantId: string, documentId: string) {
  await tx
    .update(versions)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, documentId),
        inArray(versions.status, ['extracting', 'indexed', 'indexing', 'failed', 'pending_review', 'stored'])
      )
    );
  await tx
    .delete(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)));
  await deletePlacementIndex(tx, tenantId, documentId);
}

/**
 * True when `pageId` is `targetParentId` or one of its ancestors, i.e. moving
 * the page under the target parent would create a cycle. Walks up from the
 * target parent with a recursive CTE (UNION, so a corrupt cyclic chain still
 * terminates) instead of loading the tenant's documents.
 */
export async function wouldCreateCycle(
  tx: DbTransaction,
  tenantId: string,
  pageId: string,
  targetParentId: string
): Promise<boolean> {
  const result = await tx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT d.id, d.parent_id
      FROM documents d
      WHERE d.tenant_id = ${tenantId}::uuid AND d.id = ${targetParentId}::uuid
      UNION
      SELECT p.id, p.parent_id
      FROM documents p
      JOIN ancestors a ON p.id = a.parent_id
      WHERE p.tenant_id = ${tenantId}::uuid
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${pageId}::uuid) AS cycle
  `);
  const [row] = rowsOf<{ cycle: boolean | string }>(result);
  return row?.cycle === true || row?.cycle === 't';
}

// The review-return table lives with the file move in core (`returnToReview`).
export { returnToReview } from '@living-wiki/core';
