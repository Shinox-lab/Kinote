import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { chunks, documents, spaces, tenants, versions, withTenantTx } from '@kinote/db';
import { DeterministicEmbeddingProvider, indexVersion, type Actor } from '../../src/index.js';
import { blocksFromMarkdown } from './realBlocks.js';

export interface World {
  tenantId: string;
  userId: string;
  actor: Actor;
}

/** A tenant with one owner (the owner's user row is not needed by core code). */
export async function seedTenant(): Promise<World> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` })
  );
  return { tenantId, userId, actor: { tenantId, principalType: 'user', principalId: userId, tenantRole: 'owner' } };
}

export async function addSpace(w: World, kind: 'normal' | 'inbox' = 'normal'): Promise<string> {
  const id = randomUUID();
  await withTenantTx(w.tenantId, (tx) =>
    tx.insert(spaces).values({ id, tenantId: w.tenantId, name: `s-${id}`, slug: `s-${id}`, kind, createdBy: w.userId })
  );
  return id;
}

/** Adds version `number` of a page (creating the page on number 1) and indexes it for real. */
export async function indexPageVersion(
  w: World,
  spaceId: string,
  title: string,
  markdown: string,
  documentId: string = randomUUID(),
  number = 1
): Promise<{ documentId: string; versionId: string }> {
  const versionId = randomUUID();
  const blocks = await blocksFromMarkdown(markdown);
  await withTenantTx(w.tenantId, async (tx) => {
    if (number === 1) {
      await tx.insert(documents).values({
        id: documentId,
        tenantId: w.tenantId,
        spaceId,
        kind: 'page',
        title,
        createdByType: 'user',
        createdBy: w.userId,
      });
    }
    await tx.insert(versions).values({
      id: versionId,
      tenantId: w.tenantId,
      documentId,
      number,
      title,
      status: 'indexing',
      contentHash: `h-${versionId}`,
      reason: 'quiet',
      createdByType: 'user',
      createdBy: w.userId,
      markdown,
      blocks,
    });
    await tx
      .update(documents)
      .set({ latestVersionId: versionId })
      .where(and(eq(documents.tenantId, w.tenantId), eq(documents.id, documentId)));
  });
  const result = await indexVersion({ tenantId: w.tenantId, versionId }, new DeterministicEmbeddingProvider());
  if (result.outcome !== 'indexed') throw new Error(`seed page not indexed: ${JSON.stringify(result)}`);
  return { documentId, versionId };
}

/** An indexed file version with one chunk of `text` (no object storage needed). */
export async function indexedFile(
  w: World,
  spaceId: string,
  title: string,
  text: string
): Promise<{ documentId: string; versionId: string }> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const [embedding] = await new DeterministicEmbeddingProvider().embed([text]);
  await withTenantTx(w.tenantId, async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      tenantId: w.tenantId,
      spaceId,
      kind: 'file',
      title,
      createdByType: 'user',
      createdBy: w.userId,
    });
    await tx.insert(versions).values({
      id: versionId,
      tenantId: w.tenantId,
      documentId,
      number: 1,
      title,
      status: 'indexed',
      contentHash: `h-${versionId}`,
      reason: 'upload',
      createdByType: 'user',
      createdBy: w.userId,
      objectKey: `${w.tenantId}/files/${versionId}`,
      fileName: `${title}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
    await tx.insert(chunks).values({
      tenantId: w.tenantId,
      spaceId,
      documentId,
      versionId,
      ordinal: 0,
      headingPath: [],
      blockIds: [],
      text,
      tokenCount: 10,
      contentHash: `c-${versionId}`,
      embedding: embedding!,
      embeddingModel: 'deterministic',
    });
    await tx
      .update(documents)
      .set({ latestVersionId: versionId, indexedVersionId: versionId })
      .where(and(eq(documents.tenantId, w.tenantId), eq(documents.id, documentId)));
  });
  return { documentId, versionId };
}
