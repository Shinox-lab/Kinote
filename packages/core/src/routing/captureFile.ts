import { and, eq } from 'drizzle-orm';
import { captureFacts, captures, documents, spaces, versions, withTenantTx, type DbTransaction } from '@kinote/db';
import { ExtractedDocumentSchema } from '@kinote/contracts';
import type { ObjectStorage } from '@kinote/shared';
import { requireSpaceRole } from '../permissions.js';
import { senderActor } from './access.js';
import { relocateFile } from '../files/relocate.js';
import type { EmbeddingProvider } from '../embedding.js';
import type { FileDecision, RoutingModel } from '../placement/model.js';
import { planDocument } from './document.js';
import { ROUTING } from './plan.js';

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
 * Moves a capture's file under `parentId` (or to the top of `spaceId`), when the file is still in its sender's
 * Inbox and the sender may edit there (a review space they can't approve in takes it to review). Returns whether
 * it moved; it never fails the capture.
 */
async function moveCaptureFile(
  tx: DbTransaction,
  tenantId: string,
  capture: CaptureRow,
  to: { spaceId: string; parentId: string | null }
): Promise<boolean> {
  if (!capture.fileId) return false;
  const [file] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId)))
    .for('update');
  if (!file || !(await stillInSendersInbox(tx, tenantId, capture, file))) return false;
  const [space] = await tx.select().from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, to.spaceId)));
  if (!space || space.kind !== 'normal' || space.archivedAt) return false;
  let role: string;
  try {
    const actor = await senderActor(tx, { tenantId, type: capture.senderType, id: capture.senderId });
    role = (await requireSpaceRole(tx, actor, to.spaceId, 'editor')).effectiveRole;
  } catch {
    // Placed (by an admin) where the sender can't edit: the file stays in their Inbox.
    return false;
  }
  await relocateFile(tx, tenantId, file, {
    spaceId: to.spaceId,
    spaceKind: space.kind,
    reviewRequired: space.reviewRequired,
    moverReviews: role === 'reviewer' || role === 'admin',
    parentId: to.parentId,
  });
  return true;
}

/**
 * Puts a capture's file under the page made for it, unless the sender asked to leave it in the Inbox, and records
 * what became of it. The file stays where it is when it can't move: never a reason to fail the page.
 */
export async function attachCaptureFile(tx: DbTransaction, tenantId: string, capture: CaptureRow, pageId: string) {
  if (!capture.fileId) return;
  if (decideKeepFile(capture.fileMode, 'document', capture.fileDecision as FileDecision | null) === 'inbox') {
    await recordFileOutcome(tx, tenantId, capture.id, 'inbox', CAPTURE_FILE_REASONS.asked);
    return;
  }
  const [page] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));
  const moved = page ? await moveCaptureFile(tx, tenantId, capture, { spaceId: page.spaceId, parentId: page.id }) : false;
  await recordFileOutcome(
    tx,
    tenantId,
    capture.id,
    moved ? 'with_document' : 'inbox',
    moved ? CAPTURE_FILE_REASONS.withDocument : CAPTURE_FILE_REASONS.noPlace
  );
}

/** What the receipt says about the attached file. */
export const CAPTURE_FILE_REASONS = {
  withDocument: 'Filed with its page.',
  onlyFacts: 'Kept in your Inbox: the file only carried facts.',
  asked: 'Kept in your Inbox, as asked.',
  noPlace: 'Kept in your Inbox: no clear place for it.',
} as const;

/**
 * What happens to an attached file. A document's file goes with its page (`with_document`) unless the sender said
 * not to keep it; an updates capture's file is kept (`keep`, placed on its own) when the sender asked, or when
 * the split judged it a record with enough confidence; otherwise it stays in the Inbox.
 */
export function decideKeepFile(
  mode: 'auto' | 'keep' | 'inbox',
  shape: 'document' | 'updates',
  decision: FileDecision | null
): 'with_document' | 'keep' | 'inbox' {
  if (mode === 'inbox') return 'inbox';
  if (shape === 'document') return mode === 'auto' && decision?.keep === false && decision.confidence >= 1 ? 'inbox' : 'with_document';
  if (mode === 'keep') return 'keep';
  return decision?.keep && decision.confidence >= ROUTING.document ? 'keep' : 'inbox';
}

/** Where an updates capture's file would go (a dry run): placed like a document page, or left in the Inbox. */
export interface CaptureFilePlan {
  outcome: 'placed' | 'inbox';
  spaceId: string | null;
  parentId: string | null;
  reason: string;
}

/** Plans what becomes of an updates capture's file, without moving it. */
export async function planCaptureFile(
  tenantId: string,
  capture: CaptureRow,
  deps: { model: RoutingModel; embedder: EmbeddingProvider }
): Promise<CaptureFilePlan> {
  const inbox = (reason: string): CaptureFilePlan => ({ outcome: 'inbox', spaceId: null, parentId: null, reason });
  const decided = decideKeepFile(capture.fileMode, 'updates', capture.fileDecision as FileDecision | null);
  if (decided === 'inbox') return inbox(capture.fileMode === 'inbox' ? CAPTURE_FILE_REASONS.asked : CAPTURE_FILE_REASONS.onlyFacts);
  const { name, names } = await withTenantTx(tenantId, async (tx) => {
    const [doc] = await tx.select({ title: documents.title }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, capture.fileId!)));
    const facts = await tx
      .select({ names: captureFacts.names })
      .from(captureFacts)
      .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, capture.id)));
    return { name: doc?.title ?? '', names: [...new Set(facts.flatMap((f) => f.names))] };
  });
  if (!name) return inbox(CAPTURE_FILE_MESSAGES.gone);
  const plan = await planDocument(
    { tenantId, captureId: capture.id, title: fileTitle(name), subject: capture.subject, names, hint: capture.filingHint },
    deps
  );
  if (plan.status !== 'place') return inbox(CAPTURE_FILE_REASONS.noPlace);
  const where = await withTenantTx(tenantId, async (tx) => {
    if (plan.parentId) {
      const [parent] = await tx.select({ title: documents.title }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, plan.parentId)));
      return `Filed under "${parent?.title ?? ''}".`;
    }
    const [space] = await tx.select({ name: spaces.name }).from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, plan.spaceId)));
    return `Filed at the top of ${space?.name ?? 'the space'}.`;
  });
  return { outcome: 'placed', spaceId: plan.spaceId, parentId: plan.parentId, reason: where };
}

/** Carries out a file plan and records the outcome; a place the file can no longer go leaves it in the Inbox. */
export async function applyCaptureFilePlan(tenantId: string, captureId: string, plan: CaptureFilePlan) {
  await withTenantTx(tenantId, async (tx) => {
    const [capture] = await tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
    if (!capture?.fileId || capture.fileOutcome !== null) return;
    if (plan.outcome === 'inbox' || !plan.spaceId) {
      await recordFileOutcome(tx, tenantId, captureId, 'inbox', plan.reason);
      return;
    }
    const moved = await moveCaptureFile(tx, tenantId, capture, { spaceId: plan.spaceId, parentId: plan.parentId });
    await recordFileOutcome(tx, tenantId, captureId, moved ? 'placed' : 'inbox', moved ? plan.reason : CAPTURE_FILE_REASONS.noPlace);
  });
}

async function recordFileOutcome(
  tx: DbTransaction,
  tenantId: string,
  captureId: string,
  outcome: 'with_document' | 'placed' | 'inbox',
  reason: string
) {
  await tx
    .update(captures)
    .set({ fileOutcome: outcome, fileReason: reason })
    .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
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
