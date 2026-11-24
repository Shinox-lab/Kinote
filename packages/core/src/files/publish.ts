import { and, desc, eq, notInArray } from 'drizzle-orm';
import { chunks, documents, versions, type DbTransaction, type DocumentRow } from '@kinote/db';
import { deletePlacementIndex } from '../placement/derived.js';
import type { VersionRow } from './versions.js';

/**
 * Settles a file version with no readable text as `stored` and makes it the one readers below editor open.
 * The file no longer says the words of an older indexed version, so that version is superseded and its text
 * leaves search (chunks and placement rows), as indexing a newer version would replace them. A previously
 * published no-text version gives way too. The caller holds the document lock.
 */
export async function publishStoredVersion(
  tx: DbTransaction,
  tenantId: string,
  doc: DocumentRow,
  versionId: string
): Promise<void> {
  await tx
    .update(versions)
    .set({ status: 'stored', noText: true })
    .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
  for (const old of [doc.indexedVersionId, doc.publishedVersionId]) {
    if (old && old !== versionId) {
      await tx
        .update(versions)
        .set({ status: 'superseded' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, old)));
    }
  }
  if (doc.indexedVersionId && doc.indexedVersionId !== versionId) {
    await tx.delete(chunks).where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, doc.id)));
    await deletePlacementIndex(tx, tenantId, doc.id);
  }
  await tx
    .update(documents)
    .set({ publishedVersionId: versionId, ...(doc.indexedVersionId && doc.indexedVersionId !== versionId ? { indexedVersionId: null } : {}) })
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.id)));
}

/**
 * The file's current version, the one a replace builds on: the newest that is not rejected, withdrawn or
 * failed (a refused or broken attempt does not move the base). Null when there is none.
 */
export async function currentFileVersion(
  tx: DbTransaction,
  tenantId: string,
  documentId: string
): Promise<VersionRow | null> {
  const [row] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, documentId),
        notInArray(versions.status, ['rejected', 'withdrawn', 'failed'])
      )
    )
    .orderBy(desc(versions.number))
    .limit(1);
  return row ?? null;
}
