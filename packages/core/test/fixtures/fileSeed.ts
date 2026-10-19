import { randomUUID } from 'node:crypto';
import { documents, lockDocument, spaces, tenants, withTenantTx, type DocumentRow } from '@living-wiki/db';
import type { ObjectStorage } from '@living-wiki/shared';
import { detectFileType, fileObjectPath, insertFileVersion } from '../../src/index.js';

export interface FileSeed {
  tenantId: string;
  spaceId: string;
  documentId: string;
  userId: string;
}

/** A tenant with one space and one (version-less) file document, written directly. */
export async function seedFileDocument(
  opts: { reviewRequired?: boolean; spaceKind?: 'normal' | 'inbox'; title?: string } = {}
): Promise<FileSeed> {
  const tenantId = randomUUID();
  const spaceId = randomUUID();
  const documentId = randomUUID();
  const userId = randomUUID();
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` });
    await tx.insert(spaces).values({
      id: spaceId,
      tenantId,
      name: 's',
      slug: 's',
      kind: opts.spaceKind ?? 'normal',
      reviewRequired: opts.reviewRequired ?? false,
      createdBy: userId,
    });
    await tx.insert(documents).values({
      id: documentId,
      tenantId,
      spaceId,
      kind: 'file',
      title: opts.title ?? 'a.pdf',
      createdByType: 'user',
      createdBy: userId,
    });
  });
  return { tenantId, spaceId, documentId, userId };
}

/** Stores the bytes and inserts the version, as an upload does (without the HTTP layer). */
export async function uploadFixtureFile(
  seed: FileSeed,
  storage: ObjectStorage,
  name: string,
  content: string | Uint8Array,
  actorType: 'user' | 'agent' | 'connector' = 'user'
) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const detected = detectFileType(name, bytes);
  if (!detected.ok) throw new Error(`fixture ${name} is not a valid file`);
  const versionId = randomUUID();
  const { objectKey } = await storage.put(
    seed.tenantId,
    fileObjectPath(seed.documentId, versionId, 'original'),
    bytes,
    detected.file.mimeType
  );
  return withTenantTx(seed.tenantId, async (tx) => {
    const doc = await lockDocument(tx, seed.tenantId, seed.documentId);
    return insertFileVersion(tx, {
      tenantId: seed.tenantId,
      doc,
      versionId,
      file: {
        name,
        mimeType: detected.file.mimeType,
        sizeBytes: bytes.length,
        contentHash: randomUUID(),
        objectKey,
        handling: detected.file.handling,
      },
      actor: { type: actorType, id: seed.userId },
      reason: actorType === 'connector' ? 'source' : 'upload',
    });
  });
}

export type { DocumentRow };
