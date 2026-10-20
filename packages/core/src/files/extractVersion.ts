import { and, eq } from 'drizzle-orm';
import {
  documents,
  enqueueJob,
  lockDocument,
  spaces,
  versions,
  withTenantTx,
  writeAuditEvent,
} from '@living-wiki/db';
import { AppError, ExtractedDocumentSchema, type ExtractedDocument } from '@living-wiki/contracts';
import type { ObjectStorage } from '@living-wiki/shared';
import { detectFileType } from './detect.js';
import type { Extractor } from './extractor.js';
import { readTextNative } from './textNative.js';
import { fileObjectPath } from './versions.js';

export type ExtractVersionResult =
  | { outcome: 'extracted'; status: 'pending_review' | 'indexing' | 'stored' }
  | { outcome: 'skipped'; reason: 'not_extracting' | 'superseded' | 'archived' | 'source_deleted' };

export interface ExtractDeps {
  storage: ObjectStorage;
  extractor: Extractor;
  /** Most characters of text a file may yield; more is `file_text_too_large`, never a cut. */
  maxChars: number;
}

const NO_TEXT = 'No text could be read from this file.';

async function readDocument(
  bytes: Uint8Array,
  fileName: string,
  deps: ExtractDeps
): Promise<ExtractedDocument> {
  const detected = detectFileType(fileName, bytes);
  if (!detected.ok) throw new AppError('file_unreadable');
  const { file } = detected;
  const document =
    file.handling === 'text'
      ? readTextNative(file.type as 'txt' | 'md' | 'csv', bytes)
      : await deps.extractor.extract({ bytes, fileName, file });
  const chars = document.sections.reduce((n, s) => n + s.text.length, 0);
  if (chars > deps.maxChars) throw new AppError('file_text_too_large');
  return ExtractedDocumentSchema.parse(document);
}

/**
 * Reads a file version's text and decides what happens next, in three phases
 * so no transaction is held while the file is read:
 *
 * A. (transaction) load the version; skip unless it is `extracting`;
 * B. (no transaction) fetch the bytes, read them (the worker for TXT, MD and
 *    CSV; the extractor for the rest) and store `extracted.json`;
 * C. (transaction, document locked) re-check the version is still `extracting`
 *    and the document live; then no text means `stored`; a space with review
 *    on, an agent author or a connector means `pending_review`; anything else
 *    `indexing` with its `version.index` job.
 *
 * Failures are thrown and the version stays `extracting`: `extractor_unavailable`
 * is retried by the queue; `file_unreadable` and `file_text_too_large` are final
 * (the worker's dead-letter step marks the version `failed`).
 */
export async function extractVersion(
  params: { tenantId: string; versionId: string },
  deps: ExtractDeps
): Promise<ExtractVersionResult> {
  const { tenantId, versionId } = params;

  const ver = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
    if (!row) throw new AppError('version_not_found');
    return row;
  });
  if (ver.status !== 'extracting') return { outcome: 'skipped', reason: 'not_extracting' };
  if (!ver.objectKey || !ver.fileName) throw new AppError('file_unreadable');

  const { bytes } = await deps.storage.get(tenantId, ver.objectKey);
  const extracted = await readDocument(bytes, ver.fileName, deps);
  const { objectKey: extractedKey } = await deps.storage.put(
    tenantId,
    fileObjectPath(ver.documentId, ver.id, 'extracted.json'),
    new TextEncoder().encode(JSON.stringify(extracted)),
    'application/json'
  );
  const hasText = extracted.sections.some((s) => s.text.trim() !== '');

  const result = await withTenantTx(tenantId, async (tx): Promise<ExtractVersionResult> => {
    const doc = await lockDocument(tx, tenantId, ver.documentId);
    const [current] = await tx
      .select({ status: versions.status })
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)))
      .for('update');
    if (!current || current.status !== 'extracting') {
      return { outcome: 'skipped', reason: 'not_extracting' };
    }
    const settle = (status: 'withdrawn' | 'superseded') =>
      tx
        .update(versions)
        .set({ status })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));
    if (doc.archivedAt) {
      await settle('withdrawn');
      return { outcome: 'skipped', reason: 'archived' };
    }
    if (doc.sourceDeletedAt) {
      // The source removed the file while it was being read: it must not come back through this job.
      await settle('withdrawn');
      return { outcome: 'skipped', reason: 'source_deleted' };
    }
    if (doc.latestVersionId !== ver.id) {
      await settle('superseded');
      return { outcome: 'skipped', reason: 'superseded' };
    }

    const [space] = await tx
      .select({ reviewRequired: spaces.reviewRequired })
      .from(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, doc.spaceId)));
    if (!space) throw new AppError('space_not_found');

    // Plan 2b replaces the connector rule with the source's `trusted` switch.
    const needsReview =
      space.reviewRequired || ver.createdByType === 'agent' || ver.createdByType === 'connector';
    const status = !hasText ? 'stored' : needsReview ? 'pending_review' : 'indexing';

    await tx
      .update(versions)
      .set({ status, extractedKey, error: status === 'stored' ? NO_TEXT : null })
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));
    if (status === 'indexing') {
      await enqueueJob(tx, {
        tenantId,
        queue: 'version.index',
        idempotencyKey: `index:${ver.id}`,
        payload: { versionId: ver.id },
      });
    }
    await writeAuditEvent(tx, {
      tenantId,
      type: 'file.extracted',
      actorType: ver.createdByType,
      actorId: ver.createdBy,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number, status, sections: extracted.sections.length },
    });
    return { outcome: 'extracted', status };
  });

  // Only a run that itself settled the version as superseded or withdrawn may drop the text it stored. A run
  // that finds the version already extracted lost a race (a second worker reclaimed the job): the key is
  // shared and now belongs to the winner.
  if (result.outcome === 'skipped' && result.reason !== 'not_extracting') {
    await deps.storage.delete(tenantId, extractedKey).catch(() => undefined);
  }
  return result;
}
