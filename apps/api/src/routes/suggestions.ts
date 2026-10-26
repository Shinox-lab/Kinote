import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  captures,
  citations,
  documents,
  suggestions,
  versions,
  writeAuditEvent,
  type DbTransaction,
} from '@living-wiki/db';
import { AppError, type SuggestionSummary } from '@living-wiki/contracts';
import {
  assertValidUuid,
  ensureRouterAgent,
  markdownBlocks,
  requireDocumentRole,
  takePageSnapshot,
  type Actor,
} from '@living-wiki/core';
import { documentName, type BlockLike, type CollabClient } from '@living-wiki/shared';
import { conflictNames, toSuggestionSummary } from './captures.js';
import { approveVersion } from './pages.js';

type SuggestionRow = typeof suggestions.$inferSelect;

/** GET /api/v1/pages/:id/suggestions: the page's open suggestions, for anyone who can read it. */
export async function listPageSuggestions(actor: Actor, pageId: string): Promise<SuggestionSummary[]> {
  assertValidUuid(pageId, 'page_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
    if (!doc || doc.kind !== 'page') throw new AppError('page_not_found');
    await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'page_not_found' });
    const rows = await tx
      .select()
      .from(suggestions)
      .where(and(eq(suggestions.tenantId, actor.tenantId), eq(suggestions.documentId, pageId), eq(suggestions.status, 'open')))
      .orderBy(suggestions.createdAt);
    const names = await conflictNames(tx, actor.tenantId, rows);
    return rows.map((r) => toSuggestionSummary(r, r.conflictCitationId ? names.get(r.conflictCitationId) ?? null : null));
  });
}

/**
 * Loads a suggestion and checks who may decide it: in a space with review off
 * any editor; with review on a reviewer who is not the capture's sender
 * (unless the space allows self-approval).
 */
async function decidable(tx: DbTransaction, actor: Actor, id: string) {
  assertValidUuid(id, 'suggestion_not_found');
  const [row] = await tx
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.tenantId, actor.tenantId), eq(suggestions.id, id)));
  if (!row) throw new AppError('suggestion_not_found');
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, row.documentId)));
  if (!doc) throw new AppError('suggestion_not_found');
  const { space } = await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'suggestion_not_found' });
  await requireDocumentRole(tx, actor, doc, space.reviewRequired ? 'reviewer' : 'editor', {
    notFound: 'suggestion_not_found',
  });
  if (space.reviewRequired && !space.allowSelfApproval && row.captureId) {
    const [capture] = await tx
      .select()
      .from(captures)
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, row.captureId)));
    if (capture && capture.senderType === actor.principalType && capture.senderId === actor.principalId) {
      throw new AppError('self_approval', 'You sent the capture this came from, so someone else decides it.');
    }
  }
  return { row, doc, space };
}

/** Sets the status only while the suggestion is still open; 409 `suggestion_not_open` otherwise. */
async function close(tx: DbTransaction, actor: Actor, id: string, status: 'accepted' | 'declined'): Promise<SuggestionRow> {
  const [row] = await tx
    .update(suggestions)
    .set({ status, resolvedBy: actor.principalId, resolvedAt: new Date() })
    .where(and(eq(suggestions.tenantId, actor.tenantId), eq(suggestions.id, id), eq(suggestions.status, 'open')))
    .returning();
  if (!row) throw new AppError('suggestion_not_open');
  return row;
}

async function setStatus(tenantId: string, id: string, status: 'open' | 'stale') {
  await withTenantTx(tenantId, (tx) =>
    tx
      .update(suggestions)
      .set(status === 'open' ? { status, resolvedBy: null, resolvedAt: null } : { status })
      .where(and(eq(suggestions.tenantId, tenantId), eq(suggestions.id, id)))
  );
}

async function opsFor(row: SuggestionRow): Promise<{ ops: Parameters<CollabClient['applyBlockOps']>[0]['ops']; added: BlockLike[] }> {
  const expected = row.expectedText !== null ? { expectedText: row.expectedText } : {};
  if (row.kind === 'remove') return { ops: [{ op: 'remove', blockId: row.blockId!, ...expected }], added: [] };
  const blocks: BlockLike[] = (await markdownBlocks(row.proposedMarkdown ?? '')).map((b) => ({ ...b, id: randomUUID() }));
  if (blocks.length === 0) throw new AppError('suggestion_not_open');
  const raw = blocks as unknown as Record<string, unknown>[];
  if (row.kind === 'replace') {
    blocks[0] = { ...blocks[0]!, id: row.blockId! };
    return {
      ops: [{ op: 'replace', blockId: row.blockId!, blocks: blocks as unknown as Record<string, unknown>[], ...expected }],
      added: blocks,
    };
  }
  return { ops: [{ op: 'insert_after', after: row.afterBlockId, blocks: raw }], added: blocks };
}

/**
 * POST /api/v1/suggestions/:id/accept: applies the proposed change as the
 * Routing engine, accepted by the actor, and snapshots the page. In a review
 * space the acceptance approves that snapshot when nothing else was waiting
 * on the page; otherwise the change joins the waiting snapshot. A block that
 * has gone, or changed since the suggestion was made, makes it `stale` (409
 * `suggestion_not_open`).
 */
export async function acceptSuggestion(actor: Actor, id: string, collab?: CollabClient): Promise<SuggestionSummary> {
  if (!collab) throw new AppError('internal_error');
  const { row, space, routerId, hadWaiting } = await withTenantTx(actor.tenantId, async (tx) => {
    const { doc, space } = await decidable(tx, actor, id);
    const claimed = await close(tx, actor, id, 'accepted');
    const [waiting] = await tx
      .select({ id: versions.id })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.documentId, doc.id), eq(versions.status, 'pending_review')))
      .limit(1);
    return { row: claimed, space, routerId: await ensureRouterAgent(tx, actor.tenantId), hadWaiting: !!waiting };
  });

  let added: BlockLike[];
  try {
    const built = await opsFor(row);
    added = built.added;
    await collab.applyBlockOps({
      tenantId: actor.tenantId,
      pageId: row.documentId,
      actor: { type: 'agent', id: routerId },
      source: 'agent',
      ops: built.ops,
    });
  } catch (err) {
    const gone =
      err instanceof AppError &&
      (err.code === 'block_not_found' || err.code === 'block_changed' || err.code === 'suggestion_not_open');
    await setStatus(actor.tenantId, id, gone ? 'stale' : 'open');
    if (gone) throw new AppError('suggestion_not_open', 'The block this suggestion was for has changed or gone.');
    throw err;
  }

  await collab.flush(documentName(actor.tenantId, row.documentId));
  const version = await takePageSnapshot({
    tenantId: actor.tenantId,
    pageId: row.documentId,
    reason: 'capture',
    actorType: 'agent',
    actorId: routerId,
    manual: false,
  });
  if (version && version.status === 'pending_review' && space.reviewRequired && !hadWaiting) {
    try {
      await approveVersion(actor, version.id);
    } catch (err) {
      // The accepter also wrote part of this snapshot: it waits for another reviewer.
      if (!(err instanceof AppError && err.code === 'self_approval')) throw err;
    }
  }

  return withTenantTx(actor.tenantId, async (tx) => {
    if (row.captureId) {
      for (const block of added) {
        await tx.insert(citations).values({
          tenantId: actor.tenantId,
          pageId: row.documentId,
          blockId: block.id,
          sourceKind: 'capture',
          captureId: row.captureId,
          factId: row.factId,
          quote: row.proposedMarkdown ?? '',
          createdByType: 'agent',
          createdBy: routerId,
        });
      }
    }
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'suggestion.accepted',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'suggestion',
      subjectId: id,
      payload: { documentId: row.documentId, kind: row.kind, captureId: row.captureId, versionId: version?.id ?? null },
    });
    return toSuggestionSummary(row, null);
  });
}

/** POST /api/v1/suggestions/:id/decline: keeps the text; records who declined. */
export async function declineSuggestion(actor: Actor, id: string): Promise<SuggestionSummary> {
  return withTenantTx(actor.tenantId, async (tx) => {
    await decidable(tx, actor, id);
    const row = await close(tx, actor, id, 'declined');
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'suggestion.declined',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'suggestion',
      subjectId: id,
      payload: { documentId: row.documentId, kind: row.kind, captureId: row.captureId },
    });
    return toSuggestionSummary(row, null);
  });
}
