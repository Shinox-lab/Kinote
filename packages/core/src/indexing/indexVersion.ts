import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  versions,
  chunks,
  embeddingCache,
  writeAuditEvent,
  NonRetryableError,
} from '@living-wiki/db';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '../embedding.js';
import { AppError } from '@living-wiki/contracts';
import type { BlockLike } from '@living-wiki/shared';
import { chunkPageBlocks } from './chunkPage.js';

export async function indexVersion(
  params: { tenantId: string; versionId: string },
  provider: EmbeddingProvider = defaultEmbeddingProvider
) {
  const { tenantId, versionId } = params;

  return withTenantTx(tenantId, async (tx) => {
    const [ver] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));

    if (!ver) {
      throw new AppError('version_not_found', 'Version not found.');
    }

    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, ver.documentId)));

    if (!doc) {
      throw new AppError('document_not_found', 'Document not found.');
    }

    if (!Array.isArray(ver.blocks)) {
      throw new NonRetryableError('version has no blocks');
    }
    const rawChunks = chunkPageBlocks(ver.title, ver.blocks as BlockLike[]);
    if (rawChunks.length === 0) {
      throw new NonRetryableError('version has no indexable content');
    }

    // Resolve embeddings using embedding_cache first
    const existingCacheRows = await tx
      .select()
      .from(embeddingCache)
      .where(
        and(eq(embeddingCache.tenantId, tenantId), eq(embeddingCache.model, provider.model))
      );

    const cacheByHash = new Map<string, number[]>(
      existingCacheRows.map((r) => [r.contentHash, r.embedding])
    );

    const missingChunks = rawChunks.filter((c) => !cacheByHash.has(c.contentHash));
    if (missingChunks.length > 0) {
      const uniqueMissingHashes = Array.from(new Set(missingChunks.map((c) => c.contentHash)));
      const textsToEmbed = uniqueMissingHashes.map(
        (h) => missingChunks.find((c) => c.contentHash === h)!.text
      );
      const newEmbeddings = await provider.embed(textsToEmbed);

      for (let i = 0; i < uniqueMissingHashes.length; i++) {
        const hash = uniqueMissingHashes[i];
        const emb = newEmbeddings[i];
        cacheByHash.set(hash, emb);
        await tx
          .insert(embeddingCache)
          .values({
            tenantId,
            model: provider.model,
            contentHash: hash,
            embedding: emb,
          })
          .onConflictDoUpdate({
            target: [
              embeddingCache.tenantId,
              embeddingCache.model,
              embeddingCache.contentHash,
            ],
            set: { embedding: emb },
          });
      }
    }

    // Rule S6: Only chunks of indexed versions exist. Delete old chunks and insert new chunks in one transaction.
    await tx
      .delete(chunks)
      .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, doc.id)));

    for (const rc of rawChunks) {
      const emb = cacheByHash.get(rc.contentHash)!;
      await tx.insert(chunks).values({
        tenantId,
        spaceId: doc.spaceId,
        documentId: doc.id,
        versionId: ver.id,
        ordinal: rc.ordinal,
        headingPath: rc.headingPath,
        blockIds: rc.blockIds,
        text: rc.text,
        tokenCount: rc.tokenCount,
        contentHash: rc.contentHash,
        embedding: emb,
        embeddingModel: provider.model,
      });
    }

    if (doc.indexedVersionId && doc.indexedVersionId !== ver.id) {
      await tx
        .update(versions)
        .set({ status: 'superseded' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, doc.indexedVersionId)));
    }

    const [indexedVer] = await tx
      .update(versions)
      .set({ status: 'indexed', indexedAt: new Date(), error: null })
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)))
      .returning();

    await tx
      .update(documents)
      .set({ indexedVersionId: ver.id, title: ver.title })
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.id)));

    await writeAuditEvent(tx, {
      tenantId,
      type: 'version.indexed',
      actorType: ver.createdByType as 'user' | 'agent' | 'connector',
      actorId: ver.createdBy,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number, chunkCount: rawChunks.length },
    });

    return indexedVer;
  });
}
