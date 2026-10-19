import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  spaces,
  versions,
  writeAuditEvent,
  lockDocument,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import {
  AppError,
  UploadFileFieldsSchema,
  type FileVersion,
  type UploadFileResponse,
} from '@living-wiki/contracts';
import {
  requireSpaceRole,
  requireDocumentRole,
  assertValidUuid,
  cleanFileName,
  detectFileType,
  fileObjectPath,
  insertFileVersion,
  type Actor,
  type DetectedFile,
  type VersionRow,
} from '@living-wiki/core';
import type { ObjectStorage } from '@living-wiki/shared';
import { requireVisibleParent } from '../documents/lifecycle.js';
import { toDocumentSummary, toVersionSummary } from './pages.js';

/** What the file routes need besides the database. */
export interface FileDeps {
  storage: ObjectStorage;
  /** Test seam: runs after the bytes were stored and before the database transaction. */
  afterStore?: () => Promise<void>;
}

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

export interface UploadOutcome {
  /** `unchanged`: the same bytes were already there, nothing was written. */
  status: 'created' | 'unchanged';
  response: UploadFileResponse;
}

/** A version row as the published FileVersion: the 12 summary keys plus the file facts. */
export function toFileVersion(row: VersionRow): FileVersion {
  return {
    ...toVersionSummary(row),
    fileName: row.fileName ?? row.title,
    mimeType: row.mimeType ?? 'application/octet-stream',
    sizeBytes: row.sizeBytes ?? 0,
    hasText: row.extractedKey !== null,
  };
}

function detect(file: UploadedFile): DetectedFile {
  const result = detectFileType(file.name, file.bytes);
  if (!result.ok) {
    throw new AppError(result.reason === 'empty' ? 'empty_file' : 'unsupported_file_type');
  }
  return result.file;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function unchanged(doc: DocumentRow, ver: VersionRow): UploadOutcome {
  return {
    status: 'unchanged',
    response: { document: toDocumentSummary(doc), version: toFileVersion(ver), unchanged: true },
  };
}

type SpaceRow = typeof spaces.$inferSelect;

/** The space an upload lands in: the one named, or the tenant's Inbox. Editor or higher in it. */
async function targetSpace(
  tx: DbTransaction,
  actor: Actor,
  spaceId: string | undefined,
  lock?: 'share'
): Promise<SpaceRow> {
  let id = spaceId;
  if (!id) {
    const [inbox] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.kind, 'inbox')));
    if (!inbox) throw new AppError('space_not_found');
    id = inbox.id;
  }
  const { space } = await requireSpaceRole(tx, actor, id, 'editor', lock ? { lock } : {});
  return space;
}

/**
 * A live file in `space` whose latest version has these bytes and is not
 * withdrawn. In the Inbox only the actor's own files count: another member's
 * file must look exactly like no file at all.
 */
async function findDuplicate(
  tx: DbTransaction,
  actor: Actor,
  space: Pick<SpaceRow, 'id' | 'kind'>,
  contentHash: string
): Promise<{ doc: DocumentRow; ver: VersionRow } | null> {
  const [found] = await tx
    .select({ doc: documents, ver: versions })
    .from(documents)
    .innerJoin(
      versions,
      and(eq(versions.tenantId, documents.tenantId), eq(versions.id, documents.latestVersionId))
    )
    .where(
      and(
        eq(documents.tenantId, actor.tenantId),
        eq(documents.spaceId, space.id),
        eq(documents.kind, 'file'),
        isNull(documents.archivedAt),
        isNull(documents.sourceDeletedAt),
        eq(versions.tenantId, actor.tenantId),
        eq(versions.contentHash, contentHash),
        ne(versions.status, 'withdrawn'),
        space.kind === 'inbox'
          ? and(
              eq(documents.createdByType, actor.principalType),
              eq(documents.createdBy, actor.principalId)
            )
          : undefined
      )
    )
    .limit(1);
  return found ?? null;
}

/** Stores the original bytes; on any failure after this the bytes are deleted again (best effort). */
async function withStoredBytes<T>(
  deps: FileDeps,
  tenantId: string,
  documentId: string,
  versionId: string,
  file: UploadedFile,
  detected: DetectedFile,
  run: (objectKey: string) => Promise<{ result: T; keep: boolean }>
): Promise<T> {
  const { objectKey } = await deps.storage.put(
    tenantId,
    fileObjectPath(documentId, versionId, 'original'),
    file.bytes,
    detected.mimeType
  );
  try {
    await deps.afterStore?.();
    const { result, keep } = await run(objectKey);
    if (!keep) await deps.storage.delete(tenantId, objectKey).catch(() => undefined);
    return result;
  } catch (err) {
    await deps.storage.delete(tenantId, objectKey).catch(() => undefined);
    throw err;
  }
}

/**
 * Uploads a new file (editor or higher in the target space; Inbox when none is
 * named). Order: permission and duplicate check first, so a refused upload
 * stores nothing; then the bytes; then, in one transaction under a lock on
 * (space, bytes), the duplicate check again, the document, its first version
 * and the `file.extract` job. The same bytes already in the space (in the
 * Inbox: among the actor's own files) answer `unchanged`.
 */
export async function uploadFile(
  actor: Actor,
  input: { fields: unknown; file: UploadedFile },
  deps: FileDeps
): Promise<UploadOutcome> {
  const fields = UploadFileFieldsSchema.parse(input.fields);
  const detected = detect(input.file);
  const name = cleanFileName(input.file.name);
  const contentHash = sha256(input.file.bytes);

  const gate = await withTenantTx(actor.tenantId, async (tx) => {
    const space = await targetSpace(tx, actor, fields.space_id);
    if (fields.parent_id) await requireVisibleParent(tx, actor, fields.parent_id, space.id);
    return { space, duplicate: await findDuplicate(tx, actor, space, contentHash) };
  });
  if (gate.duplicate) return unchanged(gate.duplicate.doc, gate.duplicate.ver);

  const documentId = randomUUID();
  const versionId = randomUUID();
  return withStoredBytes(deps, actor.tenantId, documentId, versionId, input.file, detected, (objectKey) =>
    withTenantTx(actor.tenantId, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:${gate.space.id}:${contentHash}`}, 0))`
      );
      const space = await targetSpace(tx, actor, gate.space.id, 'share');
      if (fields.parent_id) await requireVisibleParent(tx, actor, fields.parent_id, space.id);

      const duplicate = await findDuplicate(tx, actor, space, contentHash);
      if (duplicate) return { result: unchanged(duplicate.doc, duplicate.ver), keep: false };

      const [doc] = await tx
        .insert(documents)
        .values({
          id: documentId,
          tenantId: actor.tenantId,
          spaceId: space.id,
          parentId: fields.parent_id ?? null,
          kind: 'file',
          title: name,
          placement: 'pinned',
          createdByType: actor.principalType,
          createdBy: actor.principalId,
        })
        .returning();
      const version = await insertFileVersion(tx, {
        tenantId: actor.tenantId,
        doc: doc!,
        versionId,
        file: {
          name,
          mimeType: detected.mimeType,
          sizeBytes: input.file.bytes.byteLength,
          contentHash,
          objectKey,
          handling: detected.handling,
        },
        actor: { type: actor.principalType, id: actor.principalId },
        reason: 'upload',
      });
      await writeAuditEvent(tx, {
        tenantId: actor.tenantId,
        type: 'file.uploaded',
        actorType: actor.principalType,
        actorId: actor.principalId,
        subjectType: 'file',
        subjectId: doc!.id,
        payload: { spaceId: space.id, fileName: name, sizeBytes: input.file.bytes.byteLength },
      });
      return {
        result: {
          status: 'created' as const,
          response: { document: toDocumentSummary(doc!), version: toFileVersion(version), unchanged: false },
        },
        keep: true,
      };
    })
  );
}

/**
 * The file a person may add a version to, with its latest version. Access
 * first (a file the actor cannot see is 404 `document_not_found`, a role below
 * editor 403); then the state: archived is 409 `page_archived` (worded for a
 * file), a synced file is 409 `managed_by_source`.
 */
async function loadReplaceable(
  tx: DbTransaction,
  actor: Actor,
  fileId: string,
  lock: boolean
): Promise<{ doc: DocumentRow; latest: VersionRow | null }> {
  const doc = lock
    ? await lockDocument(tx, actor.tenantId, fileId)
    : (
        await tx
          .select()
          .from(documents)
          .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)))
      )[0];
  if (!doc || doc.kind !== 'file') throw new AppError('document_not_found');
  await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'document_not_found' });
  if (doc.archivedAt) {
    throw new AppError('page_archived', 'This file is archived. Restore it before making changes.');
  }
  if (doc.placement === 'synced') throw new AppError('managed_by_source');
  const [latest = null] = doc.latestVersionId
    ? await tx
        .select()
        .from(versions)
        .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, doc.latestVersionId)))
    : [];
  return { doc, latest };
}

const sameAsLatest = (latest: VersionRow | null, hash: string) =>
  latest !== null && latest.contentHash === hash && latest.status !== 'withdrawn';

/**
 * Adds a version to an existing file (editor or higher). The same bytes as the
 * latest version, unless it was withdrawn, answer `unchanged`.
 */
export async function replaceFile(
  actor: Actor,
  fileId: string,
  file: UploadedFile,
  deps: FileDeps
): Promise<UploadOutcome> {
  assertValidUuid(fileId, 'document_not_found');
  const detected = detect(file);
  const name = cleanFileName(file.name);
  const contentHash = sha256(file.bytes);

  const gate = await withTenantTx(actor.tenantId, (tx) => loadReplaceable(tx, actor, fileId, false));
  if (gate.latest && sameAsLatest(gate.latest, contentHash)) return unchanged(gate.doc, gate.latest);

  const versionId = randomUUID();
  return withStoredBytes(deps, actor.tenantId, fileId, versionId, file, detected, (objectKey) =>
    withTenantTx(actor.tenantId, async (tx) => {
      const { doc, latest } = await loadReplaceable(tx, actor, fileId, true);
      if (latest && sameAsLatest(latest, contentHash)) return { result: unchanged(doc, latest), keep: false };
      const version = await insertFileVersion(tx, {
        tenantId: actor.tenantId,
        doc,
        versionId,
        file: {
          name,
          mimeType: detected.mimeType,
          sizeBytes: file.bytes.byteLength,
          contentHash,
          objectKey,
          handling: detected.handling,
        },
        actor: { type: actor.principalType, id: actor.principalId },
        reason: 'upload',
      });
      return {
        result: {
          status: 'created' as const,
          response: { document: toDocumentSummary(doc), version: toFileVersion(version), unchanged: false },
        },
        keep: true,
      };
    })
  );
}

/**
 * Reads a multipart upload: exactly one file part and optional text fields
 * (an empty text field counts as absent, as browsers send them). A file over
 * the server limit is 413 `file_too_large`; a request that is not multipart,
 * has no file or has more than one is 400 `validation_failed`.
 */
export async function readMultipartUpload(
  req: FastifyRequest
): Promise<{ fields: Record<string, string>; file: UploadedFile }> {
  if (!req.isMultipart()) throw new AppError('validation_failed');
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) throw new AppError('validation_failed');
        file = { name: part.filename, bytes: await part.toBuffer() };
      } else if (typeof part.value === 'string' && part.value !== '') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const code = (err as { code?: unknown }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError('file_too_large');
    if (typeof code === 'string' && code.startsWith('FST_')) throw new AppError('validation_failed');
    throw err;
  }
  if (!file) throw new AppError('validation_failed');
  return { fields, file };
}
