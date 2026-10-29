import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { documents, enqueueJob, withTenantTx, type DbTransaction } from '@living-wiki/db';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '../embedding.js';
import { indexVersion, type IndexDeps, type IndexVersionResult } from './indexVersion.js';

/**
 * Queues a re-index of each document's indexed version (`document.reindex`):
 * what its index says about it changed without a new version (a field or
 * choice removed, a move into or out of a collection). One job per document;
 * a later request revives a finished one.
 */
export async function enqueueReindex(tx: DbTransaction, tenantId: string, documentIds: string[]): Promise<void> {
  for (const documentId of new Set(documentIds)) {
    await enqueueJob(tx, { tenantId, queue: 'document.reindex', idempotencyKey: `reindex:${documentId}`, payload: { documentId } });
  }
}

/** The live, indexed pages directly under `parentId`: a collection's rows that have anything in the index. */
export async function indexedChildPages(tx: DbTransaction, tenantId: string, parentId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.parentId, parentId),
        eq(documents.kind, 'page'),
        isNull(documents.archivedAt),
        isNotNull(documents.indexedVersionId)
      )
    );
  return rows.map((r) => r.id);
}

/** Rebuilds the chunks and placement data of the document's indexed version in place. */
export async function reindexDocument(
  tenantId: string,
  documentId: string,
  provider: EmbeddingProvider = defaultEmbeddingProvider,
  deps: IndexDeps = {}
): Promise<IndexVersionResult> {
  const [doc] = await withTenantTx(tenantId, (tx) =>
    tx
      .select({ indexedVersionId: documents.indexedVersionId })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, [documentId])))
  );
  if (!doc?.indexedVersionId) return { outcome: 'skipped', reason: 'not_indexed' };
  return indexVersion({ tenantId, versionId: doc.indexedVersionId }, provider, { ...deps, reindex: true });
}
