import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  documents,
  lockDocument,
  sourceItems,
  sources,
  spaces,
  versions,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import { AppError, ExternalIdSchema, type SourceDeleteResponse, type SourcePutResponse } from '@living-wiki/contracts';
import { cleanFileName, insertFileVersion, type VersionRow } from '@living-wiki/core';
import { withdrawLiveVersions } from '../documents/lifecycle.js';
import type { SourceActor } from '../auth/actor.js';
import { detect, fileArchived, sha256, toFileVersion, withStoredBytes, type FileDeps, type UploadedFile } from './files.js';
import { toDocumentSummary } from './pages.js';

export interface SourcePutOutcome {
  /** 201 when a document or a version was created, 200 when the bytes were what the source last sent. */
  status: 200 | 201;
  response: SourcePutResponse;
}

type ItemRow = typeof sourceItems.$inferSelect;

const MAX_ATTEMPTS = 3;

const findItem = async (tx: DbTransaction, source: SourceActor, externalId: string): Promise<ItemRow | null> =>
  (
    await tx
      .select()
      .from(sourceItems)
      .where(
        and(
          eq(sourceItems.tenantId, source.tenantId),
          eq(sourceItems.sourceId, source.sourceId),
          eq(sourceItems.externalId, externalId)
        )
      )
  )[0] ?? null;

async function requireLiveSpace(tx: DbTransaction, tenantId: string, spaceId: string): Promise<void> {
  const [space] = await tx
    .select({ archivedAt: spaces.archivedAt })
    .from(spaces)
    .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, spaceId)));
  if (!space) throw new AppError('space_not_found');
  if (space.archivedAt) throw new AppError('space_archived');
}

/** Records that the source was heard from: its last sync, and this item's last-seen time. */
async function touch(tx: DbTransaction, source: SourceActor, externalId: string | null): Promise<void> {
  const now = new Date();
  await tx
    .update(sources)
    .set({ lastSyncAt: now })
    .where(and(eq(sources.tenantId, source.tenantId), eq(sources.id, source.sourceId)));
  if (externalId !== null) {
    await tx
      .update(sourceItems)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(sourceItems.tenantId, source.tenantId),
          eq(sourceItems.sourceId, source.sourceId),
          eq(sourceItems.externalId, externalId)
        )
      );
  }
}

type Decision =
  | { kind: 'new' }
  | { kind: 'write'; doc: DocumentRow; /** The source removed this file earlier and is sending it again. */ revive: boolean }
  | { kind: 'unchanged'; doc: DocumentRow; ver: VersionRow };

/**
 * What a PUT of these bytes means for the item the source already has (or does not have), in the
 * order that matters: a file a person archived on purpose is not touched (409), an archived space
 * refuses (409), and bytes equal to what this source last sent change nothing, whatever a person
 * has done to the file since. A file the source removed is revived by any PUT (an archive on it
 * was a response to the removal, so it is lifted too). `doc` is locked by the caller when it is
 * passed in.
 */
async function decide(
  tx: DbTransaction,
  source: SourceActor,
  item: ItemRow | null,
  doc: DocumentRow | null,
  contentHash: string
): Promise<Decision> {
  if (!item || !doc) {
    await requireLiveSpace(tx, source.tenantId, source.targetSpaceId);
    return { kind: 'new' };
  }
  if (doc.archivedAt && item.deletedAt === null) throw fileArchived();
  await requireLiveSpace(tx, source.tenantId, doc.spaceId);
  if (item.deletedAt === null && item.contentHash === contentHash && doc.latestVersionId) {
    const [ver] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, source.tenantId), eq(versions.id, doc.latestVersionId)));
    if (ver) return { kind: 'unchanged', doc, ver };
  }
  return { kind: 'write', doc, revive: item.deletedAt !== null };
}

/**
 * Brings a removed file back: the removal mark and any archive go, and a parent that is no
 * longer a live page of the file's space is dropped (the file returns at the top of the space),
 * as a restore does.
 */
async function revive(tx: DbTransaction, source: SourceActor, doc: DocumentRow): Promise<void> {
  let parentId = doc.parentId;
  if (parentId) {
    const [parent] = await tx
      .select({ kind: documents.kind, spaceId: documents.spaceId, archivedAt: documents.archivedAt })
      .from(documents)
      .where(and(eq(documents.tenantId, source.tenantId), eq(documents.id, parentId)));
    if (!parent || parent.kind !== 'page' || parent.spaceId !== doc.spaceId || parent.archivedAt) parentId = null;
  }
  await tx
    .update(documents)
    .set({ sourceDeletedAt: null, archivedAt: null, parentId })
    .where(and(eq(documents.tenantId, source.tenantId), eq(documents.id, doc.id)));
}

const unchangedOutcome = (doc: DocumentRow, ver: VersionRow): SourcePutOutcome => ({
  status: 200,
  response: { document: toDocumentSummary(doc), version: toFileVersion(ver), unchanged: true, created: false },
});

/**
 * PUT /api/v1/source/files/:externalId: the source creates a file or replaces the one it made under
 * this id. It shares type detection, the size limit, storage and `insertFileVersion` with a
 * person's upload; it differs in who (the source, as a connector), where (the document's own
 * space, or the source's target space for a new file) and in how a repeat is recognised (the
 * bytes this source last sent). Order: refuse what must be refused before any byte is stored;
 * store the bytes; then one transaction under the document lock (for a new id, under an
 * advisory lock on the id) re-checks and writes. If the item appears between the check and the
 * write, the stored bytes are dropped and the whole thing runs again against the document that won.
 */
export async function putSourceFile(
  source: SourceActor,
  rawExternalId: string,
  file: UploadedFile,
  deps: FileDeps
): Promise<SourcePutOutcome> {
  const externalId = ExternalIdSchema.parse(rawExternalId);
  const detected = detect(file);
  const name = cleanFileName(file.name);
  const contentHash = sha256(file.bytes);
  const { tenantId } = source;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const gate = await withTenantTx(tenantId, async (tx) => {
      const item = await findItem(tx, source, externalId);
      const doc = item
        ? ((await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, item.documentId))))[0] ?? null)
        : null;
      const decision = await decide(tx, source, item, doc, contentHash);
      if (decision.kind === 'unchanged') await touch(tx, source, externalId);
      return { item, decision };
    });
    if (gate.decision.kind === 'unchanged') return unchangedOutcome(gate.decision.doc, gate.decision.ver);

    const documentId = gate.item?.documentId ?? randomUUID();
    const versionId = randomUUID();
    const outcome = await withStoredBytes<SourcePutOutcome | 'retry'>(deps, tenantId, documentId, versionId, file, detected, (objectKey) =>
      withTenantTx(tenantId, async (tx) => {
        if (!gate.item) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`src:${tenantId}:${source.sourceId}:${externalId}`}, 0))`
          );
        }
        let item = await findItem(tx, source, externalId);
        if (item && item.documentId !== documentId) {
          // Another request made the document first: forget our bytes and decide again against it.
          return { result: 'retry' as const, keep: false };
        }
        const locked = item ? await lockDocument(tx, tenantId, item.documentId) : null;
        // Read the item again under the document lock: a DELETE that committed while this request
        // waited for the lock must be seen, or the file would be revived without its removal mark cleared.
        if (locked) item = await findItem(tx, source, externalId);
        const decision = await decide(tx, source, item, locked, contentHash);
        if (decision.kind === 'unchanged') {
          await touch(tx, source, externalId);
          return { result: unchangedOutcome(decision.doc, decision.ver), keep: false };
        }

        let doc: DocumentRow;
        if (decision.kind === 'write') {
          doc = decision.doc;
          if (decision.revive) await revive(tx, source, doc);
        } else {
          [doc] = await tx
            .insert(documents)
            .values({
              id: documentId,
              tenantId,
              spaceId: source.targetSpaceId,
              parentId: null,
              kind: 'file',
              title: name,
              sourceId: source.sourceId,
              externalId,
              placement: 'synced',
              createdByType: 'connector',
              createdBy: source.sourceId,
            })
            .returning();
          await writeAuditEvent(tx, {
            tenantId,
            type: 'file.uploaded',
            actorType: 'connector',
            actorId: source.sourceId,
            subjectType: 'file',
            subjectId: documentId,
            payload: { spaceId: source.targetSpaceId, fileName: name, sizeBytes: file.bytes.byteLength, externalId },
          });
        }
        const version = await insertFileVersion(tx, {
          tenantId,
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
          actor: { type: 'connector', id: source.sourceId },
          reason: 'source',
        });
        await tx
          .insert(sourceItems)
          .values({ tenantId, sourceId: source.sourceId, externalId, documentId: doc.id, contentHash })
          .onConflictDoUpdate({
            target: [sourceItems.tenantId, sourceItems.sourceId, sourceItems.externalId],
            set: { contentHash, lastSeenAt: new Date(), deletedAt: null },
          });
        await touch(tx, source, null);
        const [fresh] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.id)));
        const result: SourcePutOutcome = {
          status: 201,
          response: {
            document: toDocumentSummary(fresh!),
            version: toFileVersion(version),
            unchanged: false,
            created: decision.kind === 'new',
          },
        };
        return { result, keep: true };
      })
    );
    if (outcome !== 'retry') return outcome;
  }
  throw new AppError('internal_error');
}

/**
 * DELETE /api/v1/source/files/:externalId: the source says the file is gone. In one transaction,
 * the document locked first, the file is marked removed and every live version is withdrawn with
 * the document's chunks, so search stops returning it at once and a job that was already queued
 * finds nothing to publish. An id this source never sent is 404; an id already removed answers
 * the same success with nothing written (a script may retry). Allowed whatever the state of the
 * space: removing is always allowed.
 */
export async function deleteSourceFile(source: SourceActor, rawExternalId: string): Promise<SourceDeleteResponse> {
  const externalId = ExternalIdSchema.parse(rawExternalId);
  const { tenantId } = source;
  return withTenantTx(tenantId, async (tx) => {
    const found = await findItem(tx, source, externalId);
    if (!found) throw new AppError('document_not_found');
    await lockDocument(tx, tenantId, found.documentId);
    const [item] = await tx
      .select()
      .from(sourceItems)
      .where(
        and(
          eq(sourceItems.tenantId, tenantId),
          eq(sourceItems.sourceId, source.sourceId),
          eq(sourceItems.externalId, externalId)
        )
      )
      .for('update');
    if (!item) throw new AppError('document_not_found');
    if (item.deletedAt) return { removed: true as const };

    const now = new Date();
    await tx
      .update(sourceItems)
      .set({ deletedAt: now })
      .where(
        and(
          eq(sourceItems.tenantId, tenantId),
          eq(sourceItems.sourceId, source.sourceId),
          eq(sourceItems.externalId, externalId)
        )
      );
    await withdrawLiveVersions(tx, tenantId, item.documentId);
    await tx
      .update(documents)
      .set({ sourceDeletedAt: now, indexedVersionId: null })
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, item.documentId)));
    await touch(tx, source, null);
    await writeAuditEvent(tx, {
      tenantId,
      type: 'source.item_deleted',
      actorType: 'connector',
      actorId: source.sourceId,
      subjectType: 'file',
      subjectId: item.documentId,
      payload: { documentId: item.documentId, externalId },
    });
    return { removed: true as const };
  });
}
