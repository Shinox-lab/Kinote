import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  withTenantTx,
  captureChanges,
  captureFacts,
  captures,
  documents,
  enqueueJob,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  AppError,
  canonicalFieldJson,
  fieldValueFits,
  MoveChangeRequestSchema,
  MoveDocumentRequestSchema,
  PlaceDocumentRequestSchema,
  PlaceFactRequestSchema,
  type CaptureSummary,
  type NeedsHomeDocument,
  type UndoChangesResponse,
} from '@kinote/contracts';
import {
  assertValidUuid,
  blockMarkdown,
  fieldIdOf,
  isTenantAdmin,
  markdownBlocks,
  readLiveBlocks,
  recordRoutingExample,
  requireDocumentRole,
  requireSpaceRole,
  returnCaptureFile,
  rowCollectionOf,
  takePageSnapshot,
  type Actor,
  type EmbeddingProvider,
} from '@kinote/core';
import { blockFullText, documentName, type BlockLike, type CollabClient } from '@kinote/shared';
import { changeField, enqueueCaptureRoute, summaries, visibleCapture } from './captures.js';
import { archivePageTx, lockPage, movePage } from './pages.js';

type ChangeRow = typeof captureChanges.$inferSelect;
type CaptureRow = typeof captures.$inferSelect;
type FactRow = typeof captureFacts.$inferSelect;

function isSender(actor: Actor, capture: Pick<CaptureRow, 'senderType' | 'senderId'>): boolean {
  return capture.senderType === actor.principalType && capture.senderId === actor.principalId;
}

async function captureOf(tx: DbTransaction, tenantId: string, id: string): Promise<CaptureRow> {
  const [row] = await tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, id)));
  if (!row) throw new AppError('capture_not_found');
  return row;
}

async function documentOf(tx: DbTransaction, tenantId: string, id: string) {
  const [doc] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, id)));
  return doc ?? null;
}

/**
 * Whether `actor` may undo `change`: an editor of the page's space now. The
 * capture's sender too only while they can still edit there (an undo is
 * their own edit of the page).
 */
async function mayUndo(tx: DbTransaction, actor: Actor, _capture: CaptureRow, change: ChangeRow): Promise<boolean> {
  const doc = await documentOf(tx, actor.tenantId, change.documentId);
  if (!doc) return false;
  try {
    await requireDocumentRole(tx, actor, doc, 'editor');
    return true;
  } catch (err) {
    if (err instanceof AppError && (err.code === 'forbidden' || err.code.endsWith('_not_found') || err.code === 'space_archived')) {
      return false;
    }
    throw err;
  }
}

/**
 * Restores each change's block to what it said before, as a new edit by
 * `actor` (rule 6: history is never rewritten). A block whose content no
 * longer equals the engine's result was changed by someone since: it is left
 * alone and reported. Inserted blocks are removed. A field goes back to its
 * value before (cleared when it was empty) only while it still holds the
 * engine's value and the page still has the field and both values' choices.
 */
async function undoChanges(
  actor: Actor,
  changes: ChangeRow[],
  collab: CollabClient,
  finalStatus: 'undone' | 'moved'
): Promise<UndoChangesResponse> {
  const result: UndoChangesResponse = { undone: [], changedSince: [] };
  const byPage = new Map<string, ChangeRow[]>();
  for (const c of changes) byPage.set(c.documentId, [...(byPage.get(c.documentId) ?? []), c]);

  for (const [pageId, list] of byPage) {
    // A document's own page goes as a whole (its field changes with it); a field change alone is undone like any other.
    const blockRows = list.filter((c) => c.op !== 'set_field');
    if (
      blockRows.length > 0 &&
      blockRows.every((c) => c.factId === null) &&
      (await isDocumentPage(actor.tenantId, list[0]!.captureId, pageId))
    ) {
      await undoDocumentPage(actor, pageId, list, collab, result);
      continue;
    }
    await collab.flush(documentName(actor.tenantId, pageId));
    const { live, defs } = await withTenantTx(actor.tenantId, async (tx) => ({
      live: await readLiveBlocks(tx, actor.tenantId, pageId),
      defs: list.some((c) => c.op === 'set_field') ? ((await rowCollectionOf(tx, actor.tenantId, pageId))?.fields ?? []) : [],
    }));
    const blocks = new Map((live?.blocks ?? []).map((b) => [b.id, b]));
    type Op = Parameters<CollabClient['applyBlockOps']>[0]['ops'][number];
    const planned: Array<{ change: ChangeRow; op: Op }> = [];
    for (const change of list) {
      const fieldId = change.op === 'set_field' ? fieldIdOf(change.blockId) : null;
      if (fieldId !== null) {
        const current = canonicalFieldJson(live?.fields[fieldId] ?? null);
        const def = defs.find((d) => d.id === fieldId);
        const value = change.beforeMarkdown === null ? null : JSON.parse(change.beforeMarkdown);
        // A removed field or choice (on either side) is left as it is and reported: never written back unfit.
        const fits = (json: string | null) => json === null || (def !== undefined && fieldValueFits(def, JSON.parse(json)));
        if (!def || current !== change.afterMarkdown || !fits(change.beforeMarkdown) || !fits(change.afterMarkdown)) {
          result.changedSince.push(change.id);
          continue;
        }
        planned.push({ change, op: { op: 'set_field', fieldId, value, expected: change.afterMarkdown } });
        continue;
      }
      const block = blocks.get(change.blockId);
      if (!block || (await blockMarkdown(block)) !== change.afterMarkdown) {
        result.changedSince.push(change.id);
        continue;
      }
      // Collab refuses the op if the block changes between this read and the call.
      const expectedText = blockFullText(block);
      if (change.op === 'replace' && change.beforeMarkdown !== null) {
        const before: BlockLike[] = (await markdownBlocks(change.beforeMarkdown)).map((b) => ({ ...b, id: randomUUID() }));
        if (before.length === 0) {
          planned.push({ change, op: { op: 'remove', blockId: change.blockId, expectedText } });
        } else {
          before[0] = { ...before[0]!, id: change.blockId };
          planned.push({
            change,
            op: { op: 'replace', blockId: change.blockId, blocks: before as unknown as Record<string, unknown>[], expectedText },
          });
        }
      } else {
        planned.push({ change, op: { op: 'remove', blockId: change.blockId, expectedText } });
      }
    }
    const as = {
      tenantId: actor.tenantId,
      pageId,
      actor: { type: actor.principalType, id: actor.principalId },
      source: actor.principalType === 'agent' ? ('agent' as const) : ('human' as const),
    };
    const undone: ChangeRow[] = [];
    if (planned.length > 0) {
      try {
        await collab.applyBlockOps({ ...as, ops: planned.map((p) => p.op) });
        undone.push(...planned.map((p) => p.change));
      } catch (err) {
        if (!(err instanceof AppError && (err.code === 'block_changed' || err.code === 'block_not_found'))) throw err;
        // A block changed just now: undo the others one by one, report that one.
        for (const p of planned) {
          try {
            await collab.applyBlockOps({ ...as, ops: [p.op] });
            undone.push(p.change);
          } catch (inner) {
            if (!(inner instanceof AppError && (inner.code === 'block_changed' || inner.code === 'block_not_found'))) throw inner;
            result.changedSince.push(p.change.id);
          }
        }
      }
    }
    if (undone.length > 0) {
      await collab.flush(documentName(actor.tenantId, pageId));
      await takePageSnapshot({
        tenantId: actor.tenantId,
        pageId,
        reason: actor.principalType === 'agent' ? 'agent' : 'quiet',
        actorType: actor.principalType,
        actorId: actor.principalId,
        manual: false,
      });
    }
    if (undone.length === 0) continue;
    await withTenantTx(actor.tenantId, async (tx) => {
      await tx
        .update(captureChanges)
        .set({ status: finalStatus })
        .where(and(eq(captureChanges.tenantId, actor.tenantId), inArray(captureChanges.id, undone.map((c) => c.id))));
      for (const factId of new Set(undone.map((c) => c.factId).filter((id): id is string => id !== null))) {
        const [still] = await tx
          .select({ id: captureChanges.id })
          .from(captureChanges)
          .where(
            and(
              eq(captureChanges.tenantId, actor.tenantId),
              eq(captureChanges.factId, factId),
              eq(captureChanges.status, 'applied')
            )
          )
          .limit(1);
        if (!still && finalStatus === 'undone') {
          await tx
            .update(captureFacts)
            .set({ outcome: 'undone' })
            .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, factId)));
        }
      }
      for (const change of undone) {
        await writeAuditEvent(tx, {
          tenantId: actor.tenantId,
          type: 'capture.change_undone',
          actorType: actor.principalType,
          actorId: actor.principalId,
          subjectType: 'capture_change',
          subjectId: change.id,
          payload: { captureId: change.captureId, documentId: change.documentId, op: change.op },
        });
      }
    });
    result.undone.push(...undone.map((c) => c.id));
  }
  return result;
}

/** Whether `pageId` is the page capture `captureId` (a document) became. */
async function isDocumentPage(tenantId: string, captureId: string, pageId: string): Promise<boolean> {
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx
      .select({ pageId: captures.documentPageId })
      .from(captures)
      .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)))
  );
  return row?.pageId === pageId;
}

/**
 * Undoes a document capture's own page as one unit: archived only while it
 * is exactly as the engine wrote it (the same blocks, unchanged, the same
 * title, no other capture's changes, no live child pages); otherwise left
 * alone and all its changes reported as changed since.
 * Undoing any of its changes undoes the page.
 */
async function undoDocumentPage(
  actor: Actor,
  pageId: string,
  list: ChangeRow[],
  collab: CollabClient,
  result: UndoChangesResponse
) {
  const all = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .select()
      .from(captureChanges)
      .where(
        and(
          eq(captureChanges.tenantId, actor.tenantId),
          eq(captureChanges.documentId, pageId),
          eq(captureChanges.captureId, list[0]!.captureId),
          eq(captureChanges.status, 'applied')
        )
      )
  );
  await collab.flush(documentName(actor.tenantId, pageId));
  const archived = await withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);
    if (doc.archivedAt) return true;
    // Only the page exactly as the engine wrote it is archived: its blocks
    // and nothing else, its title, no other capture's changes, no child pages
    // (the capture's own file aside).
    const live = await readLiveBlocks(tx, actor.tenantId, pageId);
    const [capture] = await tx
      .select()
      .from(captures)
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, list[0]!.captureId)));
    const liveBlocks = live?.blocks ?? [];
    // Field changes don't count: the page's fields go with it.
    const blockRows = all.filter((c) => c.op !== 'set_field');
    if (!live || doc.title !== capture?.documentTitle || live.title !== doc.title) return false;
    if (liveBlocks.length !== blockRows.length || !liveBlocks.every((b) => blockRows.some((c) => c.blockId === b.id))) return false;
    for (const block of liveBlocks) {
      const change = blockRows.find((c) => c.blockId === block.id)!;
      if ((await blockMarkdown(block)) !== change.afterMarkdown) return false;
    }
    const [other] = await tx
      .select({ id: captureChanges.id })
      .from(captureChanges)
      .where(
        and(
          eq(captureChanges.tenantId, actor.tenantId),
          eq(captureChanges.documentId, pageId),
          ne(captureChanges.captureId, list[0]!.captureId),
          eq(captureChanges.status, 'applied')
        )
      )
      .limit(1);
    if (other) return false;
    // The file the capture came with doesn't count: it goes back to the sender's Inbox, only once nothing else stops the archive.
    const [child] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, actor.tenantId),
          eq(documents.parentId, pageId),
          isNull(documents.archivedAt),
          capture!.fileId ? ne(documents.id, capture!.fileId) : undefined
        )
      )
      .limit(1);
    if (child) return false;
    await returnCaptureFile(tx, actor.tenantId, capture!, pageId);
    await archivePageTx(tx, actor, doc);
    await tx
      .update(captureChanges)
      .set({ status: 'undone' })
      .where(and(eq(captureChanges.tenantId, actor.tenantId), inArray(captureChanges.id, all.map((c) => c.id))));
    for (const change of all) {
      await writeAuditEvent(tx, {
        tenantId: actor.tenantId,
        type: 'capture.change_undone',
        actorType: actor.principalType,
        actorId: actor.principalId,
        subjectType: 'capture_change',
        subjectId: change.id,
        payload: { captureId: change.captureId, documentId: change.documentId, op: change.op },
      });
    }
    return true;
  });
  if (archived) result.undone.push(...all.map((c) => c.id));
  else result.changedSince.push(...all.map((c) => c.id));
}

async function changeFor(tx: DbTransaction, actor: Actor, id: string) {
  assertValidUuid(id, 'capture_not_found');
  const [change] = await tx
    .select()
    .from(captureChanges)
    .where(and(eq(captureChanges.tenantId, actor.tenantId), eq(captureChanges.id, id)));
  if (!change) throw new AppError('capture_not_found');
  const capture = await captureOf(tx, actor.tenantId, change.captureId);
  if (!(await mayUndo(tx, actor, capture, change))) throw new AppError('capture_not_found');
  return { change, capture };
}

/** POST /api/v1/capture-changes/:id/undo. */
export async function undoCaptureChange(actor: Actor, id: string, collab?: CollabClient): Promise<UndoChangesResponse> {
  if (!collab) throw new AppError('internal_error');
  const { change } = await withTenantTx(actor.tenantId, (tx) => changeFor(tx, actor, id));
  if (change.status !== 'applied') throw new AppError('change_already_undone');
  return undoChanges(actor, [change], collab, 'undone');
}

/** POST /api/v1/captures/:id/undo: every applied change of the capture the actor may undo. */
export async function undoCapture(actor: Actor, id: string, collab?: CollabClient): Promise<UndoChangesResponse> {
  if (!collab) throw new AppError('internal_error');
  assertValidUuid(id, 'capture_not_found');
  const changes = await withTenantTx(actor.tenantId, async (tx) => {
    const capture = await captureOf(tx, actor.tenantId, id);
    const rows = await tx
      .select()
      .from(captureChanges)
      .where(
        and(eq(captureChanges.tenantId, actor.tenantId), eq(captureChanges.captureId, id), eq(captureChanges.status, 'applied'))
      )
      .orderBy(captureChanges.createdAt);
    const allowed: ChangeRow[] = [];
    for (const row of rows) if (await mayUndo(tx, actor, capture, row)) allowed.push(row);
    if (!isSender(actor, capture) && !isTenantAdmin(actor) && allowed.length === 0) throw new AppError('capture_not_found');
    return allowed;
  });
  return undoChanges(actor, changes, collab, 'undone');
}

/** A page the engine may file into for `actor`: live, a page, outside the Inbox, at `role` or above. */
async function targetPage(tx: DbTransaction, actor: Actor, pageId: string, role: 'viewer' | 'editor') {
  assertValidUuid(pageId, 'page_not_found');
  const doc = await documentOf(tx, actor.tenantId, pageId);
  if (!doc || doc.kind !== 'page' || doc.archivedAt) throw new AppError('page_not_found');
  const { space } = await requireDocumentRole(tx, actor, doc, role, { notFound: 'page_not_found' });
  if (space.kind === 'inbox') throw new AppError('page_not_found');
  return doc;
}

async function enqueuePlace(tx: DbTransaction, tenantId: string, factId: string, documentId: string) {
  await enqueueJob(tx, {
    tenantId,
    queue: 'capture.place',
    idempotencyKey: `place:${factId}`,
    payload: { factId, documentId },
  });
}

/**
 * POST /api/v1/capture-changes/:id/move: "wrong page". Undoes the change
 * here, files the fact on the chosen page instead and saves the correction
 * as a routing example (R11). An editor of both spaces only. A block someone
 * changed since is not moved (409 `block_recently_edited`).
 */
export async function moveCaptureChange(
  actor: Actor,
  id: string,
  body: unknown,
  deps: { collab?: CollabClient; embedder: EmbeddingProvider }
): Promise<{ moved: string; factId: string }> {
  if (!deps.collab) throw new AppError('internal_error');
  const parsed = MoveChangeRequestSchema.safeParse(body);
  const { change, fact, siblings } = await withTenantTx(actor.tenantId, async (tx) => {
    const { change } = await changeFor(tx, actor, id);
    const doc = await documentOf(tx, actor.tenantId, change.documentId);
    if (!doc) throw new AppError('capture_not_found');
    await requireDocumentRole(tx, actor, doc, 'editor');
    if (!parsed.success) throw new AppError('validation_failed');
    if (change.status !== 'applied') throw new AppError('change_already_undone');
    if (parsed.data.target_page_id === change.documentId) throw new AppError('validation_failed', 'Pick another page.');
    await targetPage(tx, actor, parsed.data.target_page_id, 'editor');
    // A document page's own blocks move with the page (POST /captures/:id/document/move), not one by one.
    const factId = change.factId;
    if (factId === null) throw new AppError('validation_failed', 'Move the whole page instead.');
    const [fact] = await tx
      .select()
      .from(captureFacts)
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, factId)));
    // Every block this fact added or changed on this page moves with it.
    const siblings = await tx
      .select()
      .from(captureChanges)
      .where(
        and(
          eq(captureChanges.tenantId, actor.tenantId),
          eq(captureChanges.factId, factId),
          eq(captureChanges.documentId, change.documentId),
          eq(captureChanges.status, 'applied')
        )
      )
      .orderBy(captureChanges.createdAt);
    return { change, fact: fact!, siblings };
  });
  const target = parsed.success ? parsed.data.target_page_id : '';

  const undone = await undoChanges(actor, siblings, deps.collab, 'moved');
  if (undone.changedSince.length > 0) {
    throw new AppError('block_recently_edited', 'Someone changed this block since; edit it by hand instead.');
  }
  await recordRoutingExample(
    actor.tenantId,
    { statement: fact.statement, chosenDocumentId: target, wrongDocumentId: change.documentId, createdBy: actor.principalId },
    deps.embedder
  );
  await withTenantTx(actor.tenantId, async (tx) => {
    await tx
      .update(captureFacts)
      .set({ outcome: 'pending', placedBy: actor.principalId })
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, fact.id)));
    await enqueuePlace(tx, actor.tenantId, fact.id, target);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.change_moved',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture_change',
      subjectId: change.id,
      payload: { captureId: change.captureId, from: change.documentId, to: target },
    });
  });
  return { moved: change.id, factId: fact.id };
}

/** GET /api/v1/needs-home: facts the engine would not place, from the actor's captures (every capture for admins). */
export async function listNeedsHome(actor: Actor) {
  return withTenantTx(actor.tenantId, async (tx) => {
    const rows = await tx
      .select({ fact: captureFacts, capture: captures })
      .from(captureFacts)
      .innerJoin(captures, and(eq(captures.tenantId, captureFacts.tenantId), eq(captures.id, captureFacts.captureId)))
      .where(
        and(
          eq(captureFacts.tenantId, actor.tenantId),
          eq(captureFacts.outcome, 'needs_home'),
          isTenantAdmin(actor)
            ? undefined
            : and(eq(captures.senderType, actor.principalType), eq(captures.senderId, actor.principalId))
        )
      )
      .orderBy(desc(captureFacts.createdAt))
      .limit(200);
    return rows.map(({ fact }) => ({
      factId: fact.id,
      captureId: fact.captureId,
      statement: fact.statement,
      reason: fact.reason,
      createdAt: fact.createdAt.toISOString(),
    }));
  });
}

async function needsHomeFact(tx: DbTransaction, actor: Actor, id: string): Promise<{ fact: FactRow; capture: CaptureRow }> {
  assertValidUuid(id, 'capture_not_found');
  const [fact] = await tx
    .select()
    .from(captureFacts)
    .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, id)));
  if (!fact) throw new AppError('capture_not_found');
  const capture = await captureOf(tx, actor.tenantId, fact.captureId);
  return { fact, capture };
}

/**
 * POST /api/v1/capture-facts/:id/place: files a Needs-a-home fact on the page
 * a person chose. The sender may pick any page they can read (where they
 * cannot edit, it becomes a suggestion); anyone else must edit the target.
 */
export async function placeCaptureFact(actor: Actor, id: string, body: unknown, deps: { embedder: EmbeddingProvider }) {
  const parsed = PlaceFactRequestSchema.safeParse(body);
  const fact = await withTenantTx(actor.tenantId, async (tx) => {
    const { fact, capture } = await needsHomeFact(tx, actor, id);
    const sender = isSender(actor, capture);
    if (!parsed.success) throw new AppError('validation_failed');
    await targetPage(tx, actor, parsed.data.document_id, sender ? 'viewer' : 'editor');
    if (fact.outcome !== 'needs_home') throw new AppError('fact_not_open');
    await tx
      .update(captureFacts)
      .set({ outcome: 'pending', placedBy: actor.principalId, reason: null })
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, fact.id)));
    await enqueuePlace(tx, actor.tenantId, fact.id, parsed.data.document_id);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.fact_placed',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture_fact',
      subjectId: fact.id,
      payload: { captureId: fact.captureId, documentId: parsed.data.document_id },
    });
    return fact;
  });
  const documentId = parsed.success ? parsed.data.document_id : '';
  await recordRoutingExample(
    actor.tenantId,
    { statement: fact.statement, chosenDocumentId: documentId, wrongDocumentId: null, createdBy: actor.principalId },
    deps.embedder
  );
  return { factId: fact.id, outcome: 'pending' as const };
}

/** POST /api/v1/capture-facts/:id/dismiss: the sender (or an admin) drops a Needs-a-home fact. */
export async function dismissCaptureFact(actor: Actor, id: string) {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { fact, capture } = await needsHomeFact(tx, actor, id);
    if (!isSender(actor, capture) && !isTenantAdmin(actor)) throw new AppError('capture_not_found');
    if (fact.outcome !== 'needs_home') throw new AppError('fact_not_open');
    await tx
      .update(captureFacts)
      .set({ outcome: 'dismissed', placedBy: actor.principalId })
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, fact.id)));
    return { factId: fact.id, outcome: 'dismissed' as const };
  });
}

/** GET /api/v1/pages/:id/capture-changes?capture=: one capture's changes on a page, for its readers. */
export async function listPageCaptureChanges(actor: Actor, pageId: string, query: unknown) {
  assertValidUuid(pageId, 'page_not_found');
  const captureId = (query as { capture?: unknown } | null)?.capture;
  if (typeof captureId !== 'string') throw new AppError('validation_failed');
  assertValidUuid(captureId, 'capture_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await documentOf(tx, actor.tenantId, pageId);
    if (!doc || doc.kind !== 'page') throw new AppError('page_not_found');
    await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'page_not_found' });
    const rows = await tx
      .select({ change: captureChanges, reason: captureFacts.reason })
      .from(captureChanges)
      .leftJoin(captureFacts, and(eq(captureFacts.tenantId, captureChanges.tenantId), eq(captureFacts.id, captureChanges.factId)))
      .where(
        and(
          eq(captureChanges.tenantId, actor.tenantId),
          eq(captureChanges.documentId, pageId),
          eq(captureChanges.captureId, captureId)
        )
      )
      .orderBy(captureChanges.createdAt);
    const out = [];
    for (const { change, reason } of rows) {
      out.push({
        id: change.id,
        factId: change.factId,
        documentId: change.documentId,
        op: change.op,
        blockId: change.blockId,
        beforeMarkdown: change.beforeMarkdown,
        afterMarkdown: change.afterMarkdown,
        status: change.status,
        reason,
        field: await changeField(tx, actor.tenantId, change),
      });
    }
    return out;
  });
}

/** A capture's summary with its sender's name. */
async function summaryOf(tx: DbTransaction, tenantId: string, row: CaptureRow): Promise<CaptureSummary> {
  return (await summaries(tx, tenantId, [row]))[0]!;
}

/** The capture, locked, when its page waits for a place; 409 `document_not_waiting` otherwise. */
async function waitingDocument(tx: DbTransaction, actor: Actor, id: string): Promise<CaptureRow> {
  const capture = await visibleCapture(tx, actor, id, { lock: true });
  if (capture.shape !== 'document' || capture.documentOutcome !== 'needs_home') throw new AppError('document_not_waiting');
  return capture;
}

/** GET /api/v1/needs-home/documents: document captures waiting for a place (the actor's own; every one for admins). */
export async function listNeedsHomeDocuments(actor: Actor): Promise<NeedsHomeDocument[]> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(captures)
      .where(
        and(
          eq(captures.tenantId, actor.tenantId),
          eq(captures.shape, 'document'),
          eq(captures.documentOutcome, 'needs_home'),
          isTenantAdmin(actor)
            ? undefined
            : and(eq(captures.senderType, actor.principalType), eq(captures.senderId, actor.principalId))
        )
      )
      .orderBy(desc(captures.createdAt))
      .limit(200);
    return rows.map((row) => ({
      captureId: row.id,
      title: row.documentTitle ?? '',
      subject: row.subject,
      reason: row.documentReason,
      options: Array.isArray(row.documentOptions) ? (row.documentOptions as NeedsHomeDocument['options']) : [],
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/**
 * POST /api/v1/captures/:id/document/place: a person chooses where a waiting
 * document's page goes (under a page they can edit, or at the top of a space
 * they can edit), optionally retitled; the capture routes again. A chosen
 * parent is saved as a document example (R11).
 */
export async function placeCaptureDocument(actor: Actor, id: string, body: unknown, deps: { embedder: EmbeddingProvider }) {
  const parsed = PlaceDocumentRequestSchema.safeParse(body);
  const { summary, example } = await withTenantTx(actor.tenantId, async (tx) => {
    const capture = await waitingDocument(tx, actor, id);
    if (!parsed.success) throw new AppError('validation_failed');
    const { parent_page_id, space_id, title } = parsed.data;
    if (parent_page_id) await targetPage(tx, actor, parent_page_id, 'editor');
    else {
      const { space, effectiveRole } = await requireSpaceRole(tx, actor, space_id!, 'editor');
      if (space.kind !== 'normal' || space.archivedAt || effectiveRole === 'viewer') throw new AppError('space_not_found');
    }
    const [row] = await tx
      .update(captures)
      .set({
        documentParentChoice: parent_page_id ?? null,
        documentSpaceChoice: parent_page_id ? null : space_id!,
        documentTitle: title ?? capture.documentTitle,
        documentOutcome: 'pending',
        documentReason: null,
        status: 'queued',
      })
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, capture.id)))
      .returning();
    await enqueueCaptureRoute(tx, actor.tenantId, capture.id);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.document_placed',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture',
      subjectId: capture.id,
      payload: { parentId: parent_page_id ?? null, spaceId: space_id ?? null },
    });
    const statement = `${row!.subject ?? ''} ${row!.documentTitle ?? ''}`.trim();
    return {
      summary: await summaryOf(tx, actor.tenantId, row!),
      example: parent_page_id && statement ? { statement, parent: parent_page_id } : null,
    };
  });
  if (example) {
    await recordRoutingExample(
      actor.tenantId,
      { statement: example.statement, chosenDocumentId: example.parent, wrongDocumentId: null, createdBy: actor.principalId, kind: 'document' },
      deps.embedder
    );
  }
  return summary;
}

/** POST /api/v1/captures/:id/document/as-updates: no page for this waiting document; its facts route as updates. */
export async function routeCaptureAsUpdates(actor: Actor, id: string): Promise<CaptureSummary> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const capture = await waitingDocument(tx, actor, id);
    const [row] = await tx
      .update(captures)
      .set({ shape: 'updates', documentOutcome: null, documentReason: null, documentOptions: null, status: 'queued' })
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, capture.id)))
      .returning();
    await enqueueCaptureRoute(tx, actor.tenantId, capture.id);
    return summaryOf(tx, actor.tenantId, row!);
  });
}

/**
 * POST /api/v1/captures/:id/document/move: "wrong place" for a document's
 * page. Moves it under the chosen page (an editor of both) and saves the
 * correction as a document example (R11).
 */
export async function moveCaptureDocument(actor: Actor, id: string, body: unknown, deps: { embedder: EmbeddingProvider }) {
  const parsed = MoveDocumentRequestSchema.safeParse(body);
  const { capture, parent, page } = await withTenantTx(actor.tenantId, async (tx) => {
    const capture = await visibleCapture(tx, actor, id);
    if (capture.shape !== 'document' || capture.documentOutcome !== 'created' || !capture.documentPageId) {
      throw new AppError('document_not_waiting');
    }
    if (!parsed.success) throw new AppError('validation_failed');
    const parent = await targetPage(tx, actor, parsed.data.parent_page_id, 'editor');
    const page = await documentOf(tx, actor.tenantId, capture.documentPageId);
    if (!page || page.archivedAt) throw new AppError('page_not_found');
    return { capture, parent, page };
  });
  await movePage(actor, page.id, { target_space_id: parent.spaceId, target_parent_id: parent.id });
  const statement = `${capture.subject ?? ''} ${page.title}`.trim();
  await recordRoutingExample(
    actor.tenantId,
    { statement, chosenDocumentId: parent.id, wrongDocumentId: page.parentId, createdBy: actor.principalId, kind: 'document' },
    deps.embedder
  );
  return withTenantTx(actor.tenantId, async (tx) => {
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.document_moved',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture',
      subjectId: capture.id,
      payload: { pageId: page.id, from: page.parentId, to: parent.id },
    });
    return summaryOf(tx, actor.tenantId, capture);
  });
}
