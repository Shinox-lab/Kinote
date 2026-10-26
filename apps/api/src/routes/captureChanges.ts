import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  withTenantTx,
  captureChanges,
  captureFacts,
  captures,
  documents,
  enqueueJob,
  writeAuditEvent,
  type DbTransaction,
} from '@living-wiki/db';
import {
  AppError,
  MoveChangeRequestSchema,
  PlaceFactRequestSchema,
  type UndoChangesResponse,
} from '@living-wiki/contracts';
import {
  assertValidUuid,
  blockMarkdown,
  isTenantAdmin,
  markdownBlocks,
  readLiveBlocks,
  recordRoutingExample,
  requireDocumentRole,
  takePageSnapshot,
  type Actor,
  type EmbeddingProvider,
} from '@living-wiki/core';
import { documentName, type BlockLike, type CollabClient } from '@living-wiki/shared';

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

/** Whether `actor` may undo `change`: the capture's sender, or an editor of the page's space. */
async function mayUndo(tx: DbTransaction, actor: Actor, capture: CaptureRow, change: ChangeRow): Promise<boolean> {
  if (isSender(actor, capture)) return true;
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
 * alone and reported. Inserted blocks are removed.
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
    await collab.flush(documentName(actor.tenantId, pageId));
    const live = await withTenantTx(actor.tenantId, (tx) => readLiveBlocks(tx, actor.tenantId, pageId));
    const blocks = new Map((live?.blocks ?? []).map((b) => [b.id, b]));
    const ops: Parameters<CollabClient['applyBlockOps']>[0]['ops'] = [];
    const undone: ChangeRow[] = [];
    for (const change of list) {
      const block = blocks.get(change.blockId);
      if (!block || (await blockMarkdown(block)) !== change.afterMarkdown) {
        result.changedSince.push(change.id);
        continue;
      }
      if (change.op === 'replace' && change.beforeMarkdown !== null) {
        const before: BlockLike[] = (await markdownBlocks(change.beforeMarkdown)).map((b) => ({ ...b, id: randomUUID() }));
        if (before.length === 0) {
          ops.push({ op: 'remove', blockId: change.blockId });
        } else {
          before[0] = { ...before[0]!, id: change.blockId };
          ops.push({ op: 'replace', blockId: change.blockId, blocks: before as unknown as Record<string, unknown>[] });
        }
      } else {
        ops.push({ op: 'remove', blockId: change.blockId });
      }
      undone.push(change);
    }
    if (ops.length > 0) {
      await collab.applyBlockOps({
        tenantId: actor.tenantId,
        pageId,
        actor: { type: actor.principalType, id: actor.principalId },
        source: actor.principalType === 'agent' ? 'agent' : 'human',
        ops,
      });
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
      for (const factId of new Set(undone.map((c) => c.factId))) {
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
  const { change, fact } = await withTenantTx(actor.tenantId, async (tx) => {
    const { change } = await changeFor(tx, actor, id);
    const doc = await documentOf(tx, actor.tenantId, change.documentId);
    if (!doc) throw new AppError('capture_not_found');
    await requireDocumentRole(tx, actor, doc, 'editor');
    if (!parsed.success) throw new AppError('validation_failed');
    if (change.status !== 'applied') throw new AppError('change_already_undone');
    if (parsed.data.target_page_id === change.documentId) throw new AppError('validation_failed', 'Pick another page.');
    await targetPage(tx, actor, parsed.data.target_page_id, 'editor');
    const [fact] = await tx
      .select()
      .from(captureFacts)
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.id, change.factId)));
    return { change, fact: fact! };
  });
  const target = parsed.success ? parsed.data.target_page_id : '';

  const undone = await undoChanges(actor, [change], deps.collab, 'moved');
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
      .innerJoin(captureFacts, and(eq(captureFacts.tenantId, captureChanges.tenantId), eq(captureFacts.id, captureChanges.factId)))
      .where(
        and(
          eq(captureChanges.tenantId, actor.tenantId),
          eq(captureChanges.documentId, pageId),
          eq(captureChanges.captureId, captureId)
        )
      )
      .orderBy(captureChanges.createdAt);
    return rows.map(({ change, reason }) => ({
      id: change.id,
      factId: change.factId,
      documentId: change.documentId,
      op: change.op,
      blockId: change.blockId,
      beforeMarkdown: change.beforeMarkdown,
      afterMarkdown: change.afterMarkdown,
      status: change.status,
      reason,
    }));
  });
}
