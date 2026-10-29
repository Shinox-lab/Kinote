import { and, eq, inArray } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  versions,
  chunks,
  spaces,
  embeddingCache,
  writeAuditEvent,
  lockDocument,
  NonRetryableError,
} from '@living-wiki/db';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '../embedding.js';
import { AppError } from '@living-wiki/contracts';
import type { BlockLike, ObjectStorage } from '@living-wiki/shared';
import { chunkPageBlocks } from './chunkPage.js';
import { chunkInboxOwner } from './inboxOwner.js';
import { loadFileChunks } from '../files/loadChunks.js';
import { enqueuePlacementJobs } from '../placement/derived.js';
import { pageFieldEntries } from '../collections/fields.js';

/** What indexing needs beyond the database: file versions read their extracted text from storage. */
export interface IndexDeps {
  storage?: ObjectStorage;
  /**
   * Re-index the document's already indexed version in place (its field
   * header changed: a field or choice was removed, or the page moved into or
   * out of a collection). Its status, the document and the audit trail stay
   * as they are; only its chunks and placement data are rebuilt.
   */
  reindex?: boolean;
}

export type IndexVersionResult =
  | { outcome: 'indexed' }
  | { outcome: 'skipped'; reason: 'not_indexing' | 'archived' | 'source_deleted' | 'older_than_indexed' | 'not_indexed' };

/**
 * Rows per multi-row INSERT. Each row binds about a dozen parameters (the
 * halfvec travels as one text literal of ~2560 numbers), so 100 rows stay far
 * below Postgres's 65535-parameter limit and keep a statement to ~1.5 MB.
 */
const INSERT_BATCH_ROWS = 100;

function batches<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Publishes an approved version's chunks, in three phases so no transaction is
 * held across the embedding call:
 *
 * A. (short transactions) load the version (skip unless `indexing`), chunk it
 *    (a page from its blocks; a file from its extracted text in object
 *    storage, read with no transaction open), read the cached embeddings of
 *    exactly those chunks;
 * B. (no transaction) embed the chunks the cache does not have;
 * C. (transaction, document row locked) re-check the version is still
 *    `indexing`, the document is not archived and no newer version is indexed,
 *    then swap the document's chunks for this version's in one go.
 *
 * Skips (returned, not thrown) are final: the job completes and nothing is
 * published. A provider failure is `embedding_unavailable` (retryable).
 */
export async function indexVersion(
  params: { tenantId: string; versionId: string },
  provider: EmbeddingProvider = defaultEmbeddingProvider,
  deps: IndexDeps = {}
): Promise<IndexVersionResult> {
  const { tenantId, versionId } = params;

  // Phase A: read-only snapshot of what to index. A file version's text lives
  // in object storage, so it is read between two short transactions.
  const ver = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
    if (!row) {
      throw new AppError('version_not_found');
    }
    const fieldLines = (await pageFieldEntries(tx, tenantId, row.documentId, row.fields)).map((e) => e.text);
    return { ...row, fieldLines };
  });
  if (deps.reindex) {
    if (ver.status !== 'indexed') return { outcome: 'skipped', reason: 'not_indexed' };
  } else if (ver.status !== 'indexing') return { outcome: 'skipped', reason: 'not_indexing' };

  let rawChunks;
  if (ver.objectKey !== null) {
    if (!deps.storage) throw new NonRetryableError('file versions need object storage to be indexed');
    rawChunks = (await loadFileChunks(deps.storage, tenantId, ver)).chunks;
  } else {
    if (!Array.isArray(ver.blocks)) {
      throw new NonRetryableError('version has no blocks');
    }
    rawChunks = chunkPageBlocks(ver.title, ver.blocks as BlockLike[], undefined, ver.fieldLines);
  }
  if (rawChunks.length === 0) {
    throw new NonRetryableError('version has no indexable content');
  }

  const hashes = Array.from(new Set(rawChunks.map((c) => c.contentHash)));
  const cached = await withTenantTx(tenantId, (tx) =>
    tx
      .select({ contentHash: embeddingCache.contentHash, embedding: embeddingCache.embedding })
      .from(embeddingCache)
      .where(
        and(
          eq(embeddingCache.tenantId, tenantId),
          eq(embeddingCache.model, provider.model),
          inArray(embeddingCache.contentHash, hashes)
        )
      )
  );

  const embeddingByHash = new Map<string, number[]>(
    cached.map((r) => [r.contentHash, r.embedding])
  );

  // Phase B: embed the missing chunks with no transaction open.
  const missingTextByHash = new Map<string, string>();
  for (const c of rawChunks) {
    if (!embeddingByHash.has(c.contentHash) && !missingTextByHash.has(c.contentHash)) {
      missingTextByHash.set(c.contentHash, c.text);
    }
  }
  const newCacheRows: Array<{ contentHash: string; embedding: number[] }> = [];
  if (missingTextByHash.size > 0) {
    const missingHashes = Array.from(missingTextByHash.keys());
    const texts = Array.from(missingTextByHash.values());
    let vectors: number[][];
    try {
      vectors = await provider.embed(texts);
    } catch (err) {
      // Preserve the provider's neutral cause (for example a 401 or a
      // timeout) instead of nesting one contract sentence inside another.
      if (err instanceof AppError && err.code === 'embedding_unavailable') throw err;
      const unavailable = new AppError('embedding_unavailable');
      unavailable.cause = err;
      throw unavailable;
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new NonRetryableError(
        `embedding provider returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${texts.length} texts`
      );
    }
    vectors.forEach((vec, i) => {
      if (!Array.isArray(vec) || vec.length !== provider.dimensions) {
        throw new NonRetryableError(
          `embedding provider returned a vector of ${Array.isArray(vec) ? vec.length : 'no'} dimensions (expected ${provider.dimensions})`
        );
      }
      embeddingByHash.set(missingHashes[i], vec);
      newCacheRows.push({ contentHash: missingHashes[i], embedding: vec });
    });
  }

  // Phase C: publish under the document lock, re-checking everything Phase A saw.
  return withTenantTx(tenantId, async (tx): Promise<IndexVersionResult> => {
    const doc = await lockDocument(tx, tenantId, ver.documentId);

    const [current] = await tx
      .select({ status: versions.status })
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)))
      .for('update');
    if (!current) {
      throw new AppError('version_not_found');
    }
    if (deps.reindex) {
      // Only the version still indexed for a live document is rebuilt.
      if (current.status !== 'indexed' || doc.indexedVersionId !== ver.id || doc.archivedAt || doc.sourceDeletedAt) {
        return { outcome: 'skipped', reason: 'not_indexed' };
      }
    } else if (current.status !== 'indexing') return { outcome: 'skipped', reason: 'not_indexing' };

    if (doc.archivedAt) {
      await tx
        .update(versions)
        .set({ status: 'withdrawn' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));
      return { outcome: 'skipped', reason: 'archived' };
    }

    if (doc.sourceDeletedAt) {
      await tx
        .update(versions)
        .set({ status: 'withdrawn' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));
      return { outcome: 'skipped', reason: 'source_deleted' };
    }

    if (doc.indexedVersionId && doc.indexedVersionId !== ver.id) {
      const [indexed] = await tx
        .select({ number: versions.number })
        .from(versions)
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, doc.indexedVersionId)));
      if (indexed && indexed.number > ver.number) {
        await tx
          .update(versions)
          .set({ status: 'superseded' })
          .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));
        return { outcome: 'skipped', reason: 'older_than_indexed' };
      }
    }

    // Cache rows are content-addressed: an existing row is identical, so keep it.
    for (const batch of batches(newCacheRows, INSERT_BATCH_ROWS)) {
      await tx
        .insert(embeddingCache)
        .values(batch.map((r) => ({ tenantId, model: provider.model, ...r })))
        .onConflictDoNothing({
          target: [embeddingCache.tenantId, embeddingCache.model, embeddingCache.contentHash],
        });
    }

    // Rule S6: only chunks of indexed versions exist. Old chunks out, new chunks in, one transaction.
    await tx
      .delete(chunks)
      .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, doc.id)));

    // The space is read from the locked document row, so a concurrent move
    // (which takes the same lock) cannot leave the chunks with a stale owner.
    const [space] = await tx
      .select({ kind: spaces.kind })
      .from(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, doc.spaceId)));
    if (!space) {
      throw new AppError('space_not_found');
    }
    const inboxOwner = chunkInboxOwner(space.kind, doc);

    const chunkRows = rawChunks.map((rc) => ({
      tenantId,
      spaceId: doc.spaceId,
      inboxOwner,
      documentId: doc.id,
      versionId: ver.id,
      ordinal: rc.ordinal,
      headingPath: rc.headingPath,
      blockIds: rc.blockIds,
      pageFrom: rc.pageFrom ?? null,
      pageTo: rc.pageTo ?? null,
      text: rc.text,
      tokenCount: rc.tokenCount,
      contentHash: rc.contentHash,
      embedding: embeddingByHash.get(rc.contentHash)!,
      embeddingModel: provider.model,
    }));
    for (const batch of batches(chunkRows, INSERT_BATCH_ROWS)) {
      await tx.insert(chunks).values(batch);
    }

    if (deps.reindex) {
      if (space.kind !== 'inbox') await enqueuePlacementJobs(tx, tenantId, ver.id, doc.kind);
      return { outcome: 'indexed' };
    }

    if (doc.indexedVersionId && doc.indexedVersionId !== ver.id) {
      await tx
        .update(versions)
        .set({ status: 'superseded' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, doc.indexedVersionId)));
    }

    await tx
      .update(versions)
      .set({ status: 'indexed', indexedAt: new Date(), error: null })
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));

    await tx
      .update(documents)
      .set({ indexedVersionId: ver.id, title: ver.title })
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.id)));

    // The routing engine's card and entity graph follow the index (never in the Inbox, R17).
    if (space.kind !== 'inbox') await enqueuePlacementJobs(tx, tenantId, ver.id, doc.kind);

    await writeAuditEvent(tx, {
      tenantId,
      type: 'version.indexed',
      actorType: ver.createdByType as 'user' | 'agent' | 'connector',
      actorId: ver.createdBy,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number, chunkCount: rawChunks.length },
    });

    return { outcome: 'indexed' };
  });
}
