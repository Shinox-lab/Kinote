import { and, eq, ne } from 'drizzle-orm';
import {
  documents,
  sources,
  enqueueJob,
  lockDocument,
  spaces,
  versions,
  withTenantTx,
  writeAuditEvent,
} from '@kinote/db';
import { AppError, ExtractedDocumentSchema, type ExtractedDocument } from '@kinote/contracts';
import type { ObjectStorage } from '@kinote/shared';
import { DETECT_HEAD_BYTES, detectFileTypeOf, listZipEntriesAsync, type DetectedFile } from './detect.js';
import type { Extractor } from './extractor.js';
import { readTextNative, type TextNativeType } from './textNative.js';
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

/**
 * Reads a stored file's text without holding the file whole when the extractor reads it: detection
 * fetches the first 8 KiB (and, for a zip, its directory) by range, and the file is streamed from
 * storage to the extractor. Only TXT, MD, CSV and code, which the worker parses itself, are loaded.
 */
async function readDocument(
  tenantId: string,
  objectKey: string,
  sizeBytes: number,
  fileName: string,
  deps: ExtractDeps
): Promise<ExtractedDocument> {
  const file = await detectStored(tenantId, objectKey, sizeBytes, fileName, deps.storage);
  let document: ExtractedDocument;
  if (file.handling === 'text') {
    const { bytes } = await deps.storage.get(tenantId, objectKey);
    document = readTextNative(file.type as TextNativeType, bytes);
  } else {
    const { stream } = await deps.storage.getStream(tenantId, objectKey);
    try {
      document = await deps.extractor.extract({ body: stream, fileName, file });
    } finally {
      stream.destroy();
    }
  }
  const chars = document.sections.reduce((n, s) => n + s.text.length, 0);
  if (chars > deps.maxChars) throw new AppError('file_text_too_large');
  return withoutNul(ExtractedDocumentSchema.parse(document));
}

/** The stored size, for a version recorded without one: opening the object reports it; nothing is read. */
async function storedSize(tenantId: string, objectKey: string, storage: ObjectStorage): Promise<number> {
  const { stream, sizeBytes } = await storage.getStream(tenantId, objectKey);
  stream.destroy();
  return sizeBytes;
}

async function detectStored(
  tenantId: string,
  objectKey: string,
  sizeBytes: number,
  fileName: string,
  storage: ObjectStorage
): Promise<DetectedFile> {
  if (sizeBytes <= 0) throw new AppError('file_unreadable');
  const range = (offset: number, length: number) =>
    length <= 0 ? Promise.resolve(new Uint8Array()) : storage.getRange(tenantId, objectKey, offset, offset + length - 1);
  const head = await range(0, Math.min(sizeBytes, DETECT_HEAD_BYTES));
  // Only a file that starts like a zip can be Word, Excel or PowerPoint: the others skip the directory reads.
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const entries = isZip ? await listZipEntriesAsync(range, sizeBytes) : null;
  const detected = detectFileTypeOf(fileName, { sizeBytes, head, zipEntries: () => entries });
  if (!detected.ok) throw new AppError('file_unreadable');
  return detected.file;
}

/** Postgres text cannot hold a NUL character; an extractor (or a file) that yields one must not fail indexing later. */
function withoutNul(document: ExtractedDocument): ExtractedDocument {
  const clean = (s: string) => s.replaceAll('\u0000', '');
  return {
    ...document,
    sections: document.sections.map((s) => ({ ...s, headingPath: s.headingPath.map(clean), text: clean(s.text) })),
  };
}

/**
 * Reads a file version's text and decides what happens next, in three phases
 * so no transaction is held while the file is read:
 *
 * A. (transaction) load the version; skip unless it is `extracting`;
 * B. (no transaction) read the file (the worker for TXT, MD and CSV; the
 *    extractor for the rest, streamed from storage) and store `extracted.json`;
 * C. (transaction, document locked) re-check the version is still `extracting`
 *    and the document live; then no text means `stored`; a space with review
 *    on, an agent author or a connector whose source is not trusted means
 *    `pending_review` (and supersedes any other waiting version); anything else
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

  const sizeBytes = ver.sizeBytes ?? (await storedSize(tenantId, ver.objectKey, deps.storage));
  const extracted = await readDocument(tenantId, ver.objectKey, sizeBytes, ver.fileName, deps);
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

    // A connector's version is held unless its source is trusted (a source that cannot be found is
    // not); an agent's never skips review; either way a review-required space holds it.
    let trusted = false;
    if (ver.createdByType === 'connector') {
      const [source] = await tx
        .select({ trusted: sources.trusted })
        .from(sources)
        .where(and(eq(sources.tenantId, tenantId), eq(sources.id, ver.createdBy)));
      trusted = source?.trusted === true;
    }
    const needsReview =
      space.reviewRequired || (ver.createdByType === 'connector' && !trusted);
    const status = !hasText ? 'stored' : needsReview ? 'pending_review' : 'indexing';

    await tx
      .update(versions)
      .set({ status, extractedKey, error: status === 'stored' ? NO_TEXT : null })
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, ver.id)));
    if (status === 'pending_review') {
      // A reviewer reviews the newest state: another version still waiting (one a move into a
      // review space sent back) gives way to this one.
      await tx
        .update(versions)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(versions.tenantId, tenantId),
            eq(versions.documentId, doc.id),
            eq(versions.status, 'pending_review'),
            ne(versions.id, ver.id)
          )
        );
    }
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
