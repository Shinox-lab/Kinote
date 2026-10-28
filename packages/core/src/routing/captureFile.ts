import { and, eq } from 'drizzle-orm';
import { captures, documents, spaces, versions, withTenantTx, type DbTransaction } from '@living-wiki/db';
import { ExtractedDocumentSchema } from '@living-wiki/contracts';
import type { ObjectStorage } from '@living-wiki/shared';
import { requireSpaceRole } from '../permissions.js';
import { senderActor } from './access.js';
import { relocateFile } from '../files/relocate.js';

/** Most characters of a file's text a capture routes; a longer file is kept, not routed. */
export const CAPTURE_FILE_MAX_CHARS = 50_000;

export const CAPTURE_FILE_MESSAGES = {
  gone: 'The file is no longer there.',
  unreadable: 'This file could not be read. It was kept in your Inbox.',
  noText: 'No text could be read from this file. It was kept in your Inbox.',
  tooLong: 'Too long to route. The file was kept in your Inbox.',
} as const;

export type CaptureFileState = { state: 'ready' } | { state: 'reading' } | { state: 'failed'; message: string };


/**
 * Makes a capture's file text ready to route: once the file has been read,
 * its text is stored on the capture (once). `reading` while the file is still
 * being read; `failed` when its text can't be used. A capture with no file is
 * ready at once.
 */
export async function prepareCaptureFile(tenantId: string, captureId: string, storage: ObjectStorage): Promise<CaptureFileState> {
  const found = await withTenantTx(tenantId, async (tx) => {
    const [capture] = await tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
    if (!capture || capture.fileText !== null) return { done: true as const };
    if (!capture.fileId) {
      // A capture made with a file whose file is now gone has nothing left to route.
      return capture.text === '' ? { failed: CAPTURE_FILE_MESSAGES.gone } : { done: true as const };
    }
    const [row] = await tx
      .select({ doc: documents, ver: versions })
      .from(documents)
      .leftJoin(versions, and(eq(versions.tenantId, documents.tenantId), eq(versions.id, documents.latestVersionId)))
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)));
    if (!row || row.doc.archivedAt || !row.ver) return { failed: CAPTURE_FILE_MESSAGES.gone };
    return { ver: row.ver };
  });
  if ('done' in found) return { state: 'ready' };
  if ('failed' in found) return { state: 'failed', message: found.failed! };
  const { ver } = found;
  if (ver.status === 'extracting') return { state: 'reading' };
  // Read once its text was extracted, whatever happened after (indexing can fail on its own).
  if (!ver.extractedKey) return { state: 'failed', message: CAPTURE_FILE_MESSAGES.unreadable };

  const extracted = ExtractedDocumentSchema.parse(JSON.parse(new TextDecoder().decode((await storage.get(tenantId, ver.extractedKey)).bytes)));
  const text = extracted.sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n');
  if (text === '') return { state: 'failed', message: CAPTURE_FILE_MESSAGES.noText };
  if (text.length > CAPTURE_FILE_MAX_CHARS) return { state: 'failed', message: CAPTURE_FILE_MESSAGES.tooLong };
  await withTenantTx(tenantId, (tx) =>
    tx.update(captures).set({ fileText: text }).where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)))
  );
  return { state: 'ready' };
}

/** What a capture routes: the typed text, then the file's text. */
export function routedText(capture: { text: string; fileText: string | null }): string {
  return [capture.text, capture.fileText ?? ''].filter((t) => t.trim() !== '').join('\n\n');
}

/** A file's name without its extension: a document page's title when nothing was typed. */
export function fileTitle(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || name || 'File';
}

/** Whether the file is still where the capture left it: live, in its sender's Inbox, made by the sender. */
async function stillInSendersInbox(tx: DbTransaction, tenantId: string, capture: CaptureRow, file: typeof documents.$inferSelect) {
  if (file.archivedAt || file.createdByType !== capture.senderType || file.createdBy !== capture.senderId) return false;
  const [space] = await tx.select({ kind: spaces.kind }).from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, file.spaceId)));
  return space?.kind === 'inbox';
}

type CaptureRow = typeof captures.$inferSelect;

/**
 * Puts a capture's file under the page made for it, when the file is still
 * in its sender's Inbox and the sender may edit where the page is (a review
 * space they can't approve in takes it to review). Otherwise the file stays
 * where it is: never a reason to fail the page.
 */
export async function attachCaptureFile(tx: DbTransaction, tenantId: string, capture: CaptureRow, pageId: string) {
  if (!capture.fileId) return;
  const [page] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));
  const [file] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)))
    .for('update');
  if (!page || !file || !(await stillInSendersInbox(tx, tenantId, capture, file))) return;
  const [space] = await tx.select().from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, page.spaceId)));
  let role: string;
  try {
    const actor = await senderActor(tx, { tenantId, type: capture.senderType, id: capture.senderId });
    role = (await requireSpaceRole(tx, actor, page.spaceId, 'editor')).effectiveRole;
  } catch {
    // Placed (by an admin) where the sender can't edit: the file stays in their Inbox.
    return;
  }
  await relocateFile(tx, tenantId, file, {
    spaceId: page.spaceId,
    spaceKind: space!.kind,
    reviewRequired: space!.reviewRequired,
    moverReviews: role === 'reviewer' || role === 'admin',
    parentId: page.id,
  });
}

/**
 * Puts a capture's file back in its sender's Inbox when its page is undone,
 * if it is still under that page (moved elsewhere since, it stays there).
 */
export async function returnCaptureFile(tx: DbTransaction, tenantId: string, capture: CaptureRow, pageId: string) {
  if (!capture.fileId) return;
  const [file] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)))
    .for('update');
  const [inbox] = await tx.select().from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.kind, 'inbox')));
  if (!file || !inbox || file.archivedAt || file.parentId !== pageId) return;
  await relocateFile(tx, tenantId, file, { spaceId: inbox.id, spaceKind: 'inbox', reviewRequired: false, moverReviews: true, parentId: null });
}
