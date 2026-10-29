import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  documents,
  enqueueJob,
  versionContributors,
  versions,
  writeAuditEvent,
  type DbTransaction,
  type DocumentRow,
} from '@kinote/db';
import type { FileHandling } from './detect.js';

export type VersionRow = typeof versions.$inferSelect;

/** Path under the tenant prefix: `files/{document}/{version}/{name}`. The file name never appears in a key. */
export function fileObjectPath(
  documentId: string,
  versionId: string,
  name: 'original' | 'extracted.json'
): string {
  return `files/${documentId}/${versionId}/${name}`;
}

export interface InsertFileVersionParams {
  tenantId: string;
  /** The document, locked by the caller (`lockDocument`). */
  doc: DocumentRow;
  /** Generated before the bytes were stored, so it is part of the object key. */
  versionId: string;
  file: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
    objectKey: string;
    handling: FileHandling;
  };
  actor: { type: 'user' | 'agent' | 'connector'; id: string };
  reason: 'upload' | 'source';
  sourceRevision?: string | null;
}

const STORED_REASON = 'Kept for download. No text is read from audio or video.';

/**
 * Adds a version to a file document under the caller's document lock: the next
 * number; a version still `extracting` or waiting for review is superseded
 * (a reviewer always reviews the newest upload; an indexed version stays until
 * its successor is indexed); audio and video are `stored` at once, everything
 * else is `extracting` with its `file.extract` job. A person or agent is
 * recorded as a contributor. The document's title is not changed here: it
 * follows the version that gets indexed.
 */
export async function insertFileVersion(
  tx: DbTransaction,
  p: InsertFileVersionParams
): Promise<VersionRow> {
  const { tenantId, doc, file, actor } = p;

  const [latest] = await tx
    .select({ number: versions.number })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, doc.id)))
    .orderBy(desc(versions.number))
    .limit(1);

  await tx
    .update(versions)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, doc.id),
        inArray(versions.status, ['pending_review', 'extracting'])
      )
    );

  const stored = file.handling === 'stored';
  const [version] = await tx
    .insert(versions)
    .values({
      id: p.versionId,
      tenantId,
      documentId: doc.id,
      number: (latest?.number ?? 0) + 1,
      title: file.name,
      status: stored ? 'stored' : 'extracting',
      contentHash: file.contentHash,
      reason: p.reason,
      createdByType: actor.type,
      createdBy: actor.id,
      error: stored ? STORED_REASON : null,
      objectKey: file.objectKey,
      fileName: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sourceRevision: p.sourceRevision ?? null,
    })
    .returning();

  if (actor.type !== 'connector') {
    await tx.insert(versionContributors).values({
      tenantId,
      versionId: version!.id,
      principalType: actor.type,
      principalId: actor.id,
    });
  }

  await tx
    .update(documents)
    .set({ latestVersionId: version!.id })
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.id)));

  await writeAuditEvent(tx, {
    tenantId,
    type: 'version.created',
    actorType: actor.type,
    actorId: actor.id,
    subjectType: 'version',
    subjectId: version!.id,
    payload: { documentId: doc.id, number: version!.number, reason: p.reason, fileName: file.name },
  });

  if (!stored) {
    await enqueueJob(tx, {
      tenantId,
      queue: 'file.extract',
      idempotencyKey: `extract:${version!.id}`,
      payload: { versionId: version!.id },
    });
  }

  return version!;
}
