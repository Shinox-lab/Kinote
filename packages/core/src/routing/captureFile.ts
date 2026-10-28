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

/** Version statuses after which the file's text is (or was) there to read. */
const READ = new Set(['pending_review', 'indexing', 'indexed', 'stored', 'superseded', 'withdrawn']);

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
  if (!READ.has(ver.status) || !ver.extractedKey) return { state: 'failed', message: CAPTURE_FILE_MESSAGES.unreadable };

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
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || name;
}

/**
 * Puts a capture's file under the page made for it (in that page's space, as
 * the sender: a review space they can't approve in takes it to review).
 */
export async function attachCaptureFile(tx: DbTransaction, tenantId: string, capture: typeof captures.$inferSelect, pageId: string) {
  if (!capture.fileId) return;
  const [page] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));
  const [file] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)))
    .for('update');
  if (!page || !file || file.archivedAt) return;
  const [space] = await tx.select().from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, page.spaceId)));
  const actor = await senderActor(tx, { tenantId, type: capture.senderType, id: capture.senderId });
  const { effectiveRole } = await requireSpaceRole(tx, actor, page.spaceId, 'viewer');
  await relocateFile(tx, tenantId, file, {
    spaceId: page.spaceId,
    spaceKind: space!.kind,
    reviewRequired: space!.reviewRequired,
    moverReviews: effectiveRole === 'reviewer' || effectiveRole === 'admin',
    parentId: page.id,
  });
}

/** Puts a capture's file back at the top of its sender's Inbox (its page was undone). */
export async function returnCaptureFile(tx: DbTransaction, tenantId: string, capture: typeof captures.$inferSelect) {
  if (!capture.fileId || capture.senderType !== 'user') return;
  const [file] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)))
    .for('update');
  const [inbox] = await tx.select().from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.kind, 'inbox')));
  if (!file || !inbox) return;
  await relocateFile(tx, tenantId, file, { spaceId: inbox.id, spaceKind: 'inbox', reviewRequired: false, moverReviews: true, parentId: null });
}
