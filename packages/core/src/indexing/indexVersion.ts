import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  versions,
  chunks,
  embeddingCache,
  writeAuditEvent,
} from '@living-wiki/db';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '../embedding.js';
import { AppError } from '@living-wiki/contracts';

export interface RawChunk {
  ordinal: number;
  headingPath: string[];
  blockIds: string[];
  text: string;
  tokenCount: number;
  contentHash: string;
}

/**
 * Splits a page's blocks at headings (never inside a block).
 * Each chunk's indexed text starts with the document title and heading path.
 */
export function chunkPageBlocks(
  title: string,
  blocks: Array<{ id?: string; type?: string; level?: number; text?: string; markdown?: string }>,
  fallbackMarkdown: string
): RawChunk[] {
  const sourceBlocks =
    Array.isArray(blocks) && blocks.length > 0
      ? blocks
      : fallbackMarkdown
          .split(/\n\n+/)
          .filter(Boolean)
          .map((line, idx) => ({
            id: `block-${idx + 1}`,
            type: line.startsWith('#') ? 'heading' : 'paragraph',
            level: line.match(/^#+/)?.[0].length ?? 1,
            text: line.replace(/^#+\s*/, ''),
            markdown: line,
          }));

  const sections: Array<{ headingPath: string[]; blockIds: string[]; lines: string[] }> = [];
  let currentHeadingStack: string[] = [];
  let currentBlockIds: string[] = [];
  let currentLines: string[] = [];

  const flushSection = () => {
    if (currentLines.length === 0) return;
    sections.push({
      headingPath: [...currentHeadingStack],
      blockIds: [...currentBlockIds],
      lines: [...currentLines],
    });
    currentBlockIds = [];
    currentLines = [];
  };

  for (const b of sourceBlocks) {
    const isHeading = b.type === 'heading' || (b.markdown && /^#{1,6}\s+/.test(b.markdown));
    const blockText = (b.markdown ?? b.text ?? '').trim();
    if (!blockText) continue;

    if (isHeading) {
      flushSection();
      const headingText = blockText.replace(/^#{1,6}\s+/, '').trim();
      const level = b.level ?? (blockText.match(/^#+/)?.[0].length || 1);
      currentHeadingStack = currentHeadingStack.slice(0, Math.max(0, level - 1));
      currentHeadingStack.push(headingText);
    }

    currentBlockIds.push(b.id ?? `block-${currentBlockIds.length + 1}`);
    currentLines.push(blockText);
  }
  flushSection();

  if (sections.length === 0 && fallbackMarkdown.trim()) {
    sections.push({
      headingPath: [],
      blockIds: ['block-1'],
      lines: [fallbackMarkdown.trim()],
    });
  }

  return sections.map((sec, idx) => {
    const pathPrefix =
      sec.headingPath.length > 0 ? `${title} > ${sec.headingPath.join(' > ')}` : title;
    const text = `# ${pathPrefix}\n\n${sec.lines.join('\n\n')}`;
    const tokenCount = text.split(/\s+/).filter(Boolean).length;
    const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');

    return {
      ordinal: idx,
      headingPath: sec.headingPath,
      blockIds: sec.blockIds,
      text,
      tokenCount,
      contentHash,
    };
  });
}

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

    const rawChunks = chunkPageBlocks(
      ver.title,
      (ver.blocks as any[]) ?? [],
      ver.markdown ?? ''
    );

    // Resolve embeddings using embedding_cache first
    const existingCacheRows = await tx
      .select()
      .from(embeddingCache)
      .where(
        and(eq(embeddingCache.tenantId, tenantId), eq(embeddingCache.model, provider.model))
      );

    const cacheByHash = new Map<string, number[]>(
      existingCacheRows.map((r) => [r.contentHash, r.embedding as unknown as number[]])
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
