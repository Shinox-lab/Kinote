import { createHash, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  spaces,
  versions,
  chunks,
  writeAuditEvent,
  lockDocument,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import {
  AppError,
  MoveFileRequestSchema,
  UploadFileFieldsSchema,
  type ChunkInspector,
  type DocumentSummary,
  type FileDetails,
  type FileVersion,
  type FileVersionList,
  type UploadFileResponse,
} from '@living-wiki/contracts';
import {
  requireSpaceRole,
  requireDocumentRole,
  assertValidUuid,
  chunkInboxOwner,
  cleanFileName,
  detectFileType,
  isTenantAdmin,
  fileObjectPath,
  insertFileVersion,
  loadFileChunks,
  type Actor,
  type DetectedFile,
  type VersionRow,
} from '@living-wiki/core';
import type { ObjectStorage } from '@living-wiki/shared';
import {
  requireVisibleParent,
  returnToReview,
  withdrawLiveVersions,
  wouldCreateCycle,
} from '../documents/lifecycle.js';
import { computeFileBadge } from '../pages/badge.js';
import { resolveActorNames } from '../people.js';
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

export function detect(file: UploadedFile): DetectedFile {
  const result = detectFileType(file.name, file.bytes);
  if (!result.ok) {
    throw new AppError(result.reason === 'empty' ? 'empty_file' : 'unsupported_file_type');
  }
  return result.file;
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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
export async function withStoredBytes<T>(
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

export const fileArchived = () =>
  new AppError('page_archived', 'This file is archived. Restore it before making changes.');

/**
 * Locks a file's document row (the first statement of every writer that
 * changes what a file publishes). Unknown, other-tenant and non-file
 * documents answer 404 `document_not_found`.
 */
async function lockFile(tx: DbTransaction, tenantId: string, fileId: string): Promise<DocumentRow> {
  const doc = await lockDocument(tx, tenantId, fileId);
  if (doc.kind !== 'file') throw new AppError('document_not_found');
  return doc;
}

/**
 * Moves a file (editor on both the source and the target space) the way
 * `movePage` moves a page, without slugs. A move pins the file. A cross-space
 * move into a review space by someone who does not review there sends the
 * indexed version back to review; any other cross-space move updates
 * `chunks.space_id` and `chunks.inbox_owner` in place. The target parent must
 * be a live page of the target space the actor can see (404 `parent_not_found`);
 * only the creator or a tenant admin may move a file into the Inbox.
 */
export async function moveFile(actor: Actor, fileId: string, input: unknown): Promise<DocumentSummary> {
  assertValidUuid(fileId, 'document_not_found');
  const parsed = MoveFileRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockFile(tx, actor.tenantId, fileId);
    await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'document_not_found' });
    if (doc.archivedAt) throw fileArchived();
    const { space: targetSpace, effectiveRole: targetRole } = await requireSpaceRole(
      tx,
      actor,
      parsed.target_space_id,
      'editor',
      { lock: 'share' }
    );
    if (
      targetSpace.kind === 'inbox' &&
      !isTenantAdmin(actor) &&
      !(doc.createdByType === actor.principalType && doc.createdBy === actor.principalId)
    ) {
      throw new AppError('forbidden', 'Only the creator of a file can move it into the Inbox.');
    }
    if (parsed.target_parent_id) {
      await requireVisibleParent(tx, actor, parsed.target_parent_id, parsed.target_space_id);
      if (await wouldCreateCycle(tx, actor.tenantId, fileId, parsed.target_parent_id)) {
        throw new AppError('parent_cycle');
      }
    }

    const crossSpace = doc.spaceId !== parsed.target_space_id;
    const isTargetReviewer = targetRole === 'reviewer' || targetRole === 'admin';
    let nextIndexedVersionId = doc.indexedVersionId;
    if (crossSpace) {
      if (targetSpace.reviewRequired && !isTargetReviewer) {
        await returnToReview(tx, actor.tenantId, doc);
        nextIndexedVersionId = null;
      } else {
        await tx
          .update(chunks)
          .set({
            spaceId: parsed.target_space_id,
            inboxOwner: chunkInboxOwner(targetSpace.kind, doc),
          })
          .where(and(eq(chunks.tenantId, actor.tenantId), eq(chunks.documentId, fileId)));
      }
    }

    const [updated] = await tx
      .update(documents)
      .set({
        spaceId: parsed.target_space_id,
        parentId: parsed.target_parent_id,
        position: parsed.position,
        placement: 'pinned',
        indexedVersionId: nextIndexedVersionId,
      })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)))
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'file.moved',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'file',
      subjectId: fileId,
      payload: {
        fromSpaceId: doc.spaceId,
        toSpaceId: parsed.target_space_id,
        parentId: parsed.target_parent_id,
      },
    });
    return toDocumentSummary(updated!);
  });
}

/**
 * Takes a file out of the index (reviewer; no approval needed): every extracting,
 * indexed, indexing, failed or waiting version becomes `withdrawn`, the chunks
 * are deleted and `indexed_version_id` cleared, in one transaction under the
 * document lock, so search stops returning it at once.
 */
export async function withdrawFile(actor: Actor, fileId: string): Promise<DocumentSummary> {
  assertValidUuid(fileId, 'document_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockFile(tx, actor.tenantId, fileId);
    await requireDocumentRole(tx, actor, doc, 'reviewer', { notFound: 'document_not_found' });
    await withdrawLiveVersions(tx, actor.tenantId, fileId);
    const [updated] = await tx
      .update(documents)
      .set({ indexedVersionId: null })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'file.withdrawn',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'file',
      subjectId: fileId,
    });
    return toDocumentSummary(updated!);
  });
}

/** Archives a file (space admin): withdrawn from the index, chunks deleted, `archived_at` set. */
export async function archiveFile(actor: Actor, fileId: string): Promise<DocumentSummary> {
  assertValidUuid(fileId, 'document_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockFile(tx, actor.tenantId, fileId);
    await requireDocumentRole(tx, actor, doc, 'admin', { notFound: 'document_not_found' });
    const [liveChild] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, actor.tenantId),
          eq(documents.parentId, fileId),
          isNull(documents.archivedAt)
        )
      )
      .limit(1);
    if (liveChild) throw new AppError('has_children', 'Cannot archive a file while active child documents exist.');
    await withdrawLiveVersions(tx, actor.tenantId, fileId);
    const [updated] = await tx
      .update(documents)
      .set({ archivedAt: new Date(), indexedVersionId: null })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'file.archived',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'file',
      subjectId: fileId,
    });
    return toDocumentSummary(updated!);
  });
}

/**
 * Restores an archived file (space admin). The file comes back withdrawn (its
 * versions stay `withdrawn`; uploading it again goes through review and
 * indexing). A parent that is archived or no longer a page of the same space
 * is dropped: the file returns at the top of the space.
 */
export async function restoreFile(actor: Actor, fileId: string): Promise<DocumentSummary> {
  assertValidUuid(fileId, 'document_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockFile(tx, actor.tenantId, fileId);
    await requireDocumentRole(tx, actor, doc, 'admin', {
      notFound: 'document_not_found',
      lock: 'share',
    });
    if (!doc.archivedAt) return toDocumentSummary(doc);

    let parentId = doc.parentId;
    if (parentId) {
      const [parent] = await tx
        .select({ spaceId: documents.spaceId, kind: documents.kind, archivedAt: documents.archivedAt })
        .from(documents)
        .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, parentId)));
      if (!parent || parent.archivedAt !== null || parent.kind !== 'page' || parent.spaceId !== doc.spaceId) {
        parentId = null;
      }
    }
    const [updated] = await tx
      .update(documents)
      .set({ archivedAt: null, parentId })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'file.restored',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'file',
      subjectId: fileId,
      payload: { parentId },
    });
    return toDocumentSummary(updated!);
  });
}

/** The file document, readable by the actor (404 `document_not_found` otherwise, a page included). */
async function readableFile(tx: DbTransaction, actor: Actor, fileId: string): Promise<DocumentRow> {
  assertValidUuid(fileId, 'document_not_found');
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)));
  if (!doc || doc.kind !== 'file') throw new AppError('document_not_found');
  await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'document_not_found' });
  return doc;
}

const fileVersionsOf = (tx: DbTransaction, tenantId: string, fileId: string) =>
  tx
    .select()
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, fileId)))
    .orderBy(desc(versions.number));

/** GET /api/v1/files/:id: the file, its server-computed badge and its latest and indexed versions (viewer). */
export async function getFileDetails(actor: Actor, fileId: string): Promise<FileDetails> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await readableFile(tx, actor, fileId);
    const all = await fileVersionsOf(tx, actor.tenantId, fileId);
    const latest = all[0] ?? null;
    const indexed = doc.indexedVersionId ? (all.find((v) => v.id === doc.indexedVersionId) ?? null) : null;
    return {
      id: doc.id,
      spaceId: doc.spaceId,
      parentId: doc.parentId,
      title: doc.title,
      archivedAt: doc.archivedAt?.toISOString() ?? null,
      placement: doc.placement,
      sourceDeletedAt: doc.sourceDeletedAt?.toISOString() ?? null,
      badge: computeFileBadge({
        latestVersion: latest
          ? { number: latest.number, status: latest.status, hasText: latest.extractedKey !== null }
          : null,
        indexedVersion: indexed ? { number: indexed.number } : null,
        sourceDeleted: doc.sourceDeletedAt !== null,
        placement: doc.placement,
      }),
      latestVersion: latest ? toFileVersion(latest) : null,
      indexedVersion: indexed ? toFileVersion(indexed) : null,
    };
  });
}

/** GET /api/v1/files/:id/versions: every version, newest first, with who made it (viewer). A script shows as "System". */
export async function listFileVersions(actor: Actor, fileId: string): Promise<FileVersionList> {
  return withTenantTx(actor.tenantId, async (tx) => {
    await readableFile(tx, actor, fileId);
    const all = await fileVersionsOf(tx, actor.tenantId, fileId);
    const names = await resolveActorNames(
      tx,
      actor.tenantId,
      all.flatMap((v) => (v.createdByType === 'connector' ? [] : [{ type: v.createdByType, id: v.createdBy }]))
    );
    return all.map((v) => ({
      ...toFileVersion(v),
      createdByName:
        v.createdByType === 'connector' ? 'System' : (names.get(`${v.createdByType}:${v.createdBy}`) ?? 'Former member'),
    }));
  });
}

/**
 * A file version and its document, readable by the actor. A version that is
 * unknown, of a page, or of a hidden file is the same 404 `version_not_found`.
 */
async function readableFileVersion(
  tx: DbTransaction,
  actor: Actor,
  versionId: string,
  minimumRole: 'viewer' | 'editor'
): Promise<{ ver: VersionRow; doc: DocumentRow }> {
  assertValidUuid(versionId, 'version_not_found');
  const [ver] = await tx
    .select()
    .from(versions)
    .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)));
  if (!ver) throw new AppError('version_not_found');
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, ver.documentId)));
  if (!doc || doc.kind !== 'file' || ver.objectKey === null) throw new AppError('version_not_found');
  await requireDocumentRole(tx, actor, doc, minimumRole, { notFound: 'version_not_found' });
  return { ver, doc };
}

const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** RFC 5987 value: everything outside the attribute characters is percent-encoded. */
const encodeHeaderName = (name: string) =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * GET /api/v1/versions/:id/file (viewer): the original bytes with headers that
 * can never make a browser run them. The Content-Type is the one the server
 * decided at upload (text types go out as plain text), `nosniff`, a sandbox
 * Content-Security-Policy and `no-store`; it is a download unless `inline` is
 * asked for and the file is an image.
 */
export async function downloadVersionFile(
  actor: Actor,
  versionId: string,
  opts: { inline: boolean },
  deps: Pick<FileDeps, 'storage'>
): Promise<{ bytes: Uint8Array; headers: Record<string, string> }> {
  const { ver } = await withTenantTx(actor.tenantId, (tx) => readableFileVersion(tx, actor, versionId, 'viewer'));
  const mime = ver.mimeType ?? 'application/octet-stream';
  const { bytes } = await deps.storage.get(actor.tenantId, ver.objectKey!);
  const inline = opts.inline && INLINE_MIME.has(mime);
  return {
    bytes,
    headers: {
      'content-type': mime.startsWith('text/') ? 'text/plain; charset=utf-8' : mime,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'no-store',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeHeaderName(ver.fileName ?? ver.title)}`,
    },
  };
}

/**
 * GET /api/v1/versions/:id/chunks (editor): the extracted text and the chunks
 * as they are, or would be, indexed. Chunks of a version that is not indexed
 * are computed with the same function indexing uses, never stored: only
 * indexed versions have rows in `chunks`.
 */
export async function getVersionChunks(
  actor: Actor,
  versionId: string,
  deps: Pick<FileDeps, 'storage'>
): Promise<ChunkInspector> {
  const { ver, doc } = await withTenantTx(actor.tenantId, (tx) => readableFileVersion(tx, actor, versionId, 'editor'));
  const indexed = doc.indexedVersionId === ver.id;
  if (ver.extractedKey === null) {
    return { versionId: ver.id, indexed, ready: false, pageCount: null, ocrUsed: false, sections: [], chunks: [] };
  }
  const { extracted, chunks: raw } = await loadFileChunks(deps.storage, actor.tenantId, ver);
  return {
    versionId: ver.id,
    indexed,
    ready: true,
    pageCount: extracted.pageCount,
    ocrUsed: extracted.ocrUsed,
    sections: extracted.sections,
    chunks: raw.map((c) => ({
      ordinal: c.ordinal,
      headingPath: c.headingPath,
      pageFrom: c.pageFrom ?? null,
      pageTo: c.pageTo ?? null,
      text: c.text,
      tokenCount: c.tokenCount,
    })),
  };
}
