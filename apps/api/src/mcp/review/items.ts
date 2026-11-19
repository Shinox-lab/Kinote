import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { documents, spaces, suggestions, versions, withTenantTx, writeAuditEvent } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { senderAccess, type Actor } from '@kinote/core';
import type { CollabClient } from '@kinote/shared';
import { approveVersion, rejectVersion } from '../../routes/pages.js';
import { listReviewQueue } from '../../routes/reviews.js';
import { acceptSuggestion, declineSuggestion, suggestionDecidable } from '../../routes/suggestions.js';
import { proposerNames, suggestionField, toSuggestionSummary } from '../../routes/captures.js';

/** One thing waiting for the owner in the review panel. */
export interface ReviewPanelItem {
  type: 'version' | 'suggestion';
  id: string;
  page: { id: string; title: string; space: string };
  kind: 'version' | 'remove' | 'replace' | 'insert' | 'set_field' | 'archive';
  proposer: { type: 'user' | 'agent'; name: string };
  created_at: string;
  reason: string | null;
  /** Markdown: the indexed page, or the addressed block / field value. */
  before: string | null;
  /** Markdown: the waiting version, or the proposed block / value; null for a delete request. */
  after: string | null;
  /** A delete request only: the page's live sub-pages. */
  sub_pages?: number;
  /** False: the owner may see it but someone else decides it (`why_not` says why). */
  decidable: boolean;
  why_not?: string;
}

export const MAX_ITEMS = 50;
const CLIP = 20_000;
const NOT_YOURS = 'You worked on this, so someone else approves it.';
/** A version rejected from the panel without a note (a rejection needs one). */
export const DEFAULT_REJECT_NOTE = 'Rejected in the AI client.';

function clip(text: string | null): string | null {
  if (text === null || text.length <= CLIP) return text;
  return `${text.slice(0, CLIP)}… (${text.length - CLIP} more characters)`;
}

/**
 * What `owner` can review, oldest first, at most 50: the waiting versions of the review queue and the open
 * suggestions on pages the owner can edit. `pageId` keeps one page; `agentId` keeps what that agent proposed.
 */
export async function reviewItems(owner: Actor, opts: { pageId?: string; agentId?: string }): Promise<ReviewPanelItem[]> {
  const queue = await listReviewQueue(owner, {});
  const out: ReviewPanelItem[] = [];

  const waiting = queue.filter(
    (q) =>
      q.document.kind === 'page' &&
      (opts.pageId === undefined || q.document.id === opts.pageId) &&
      (opts.agentId === undefined ||
        (q.version.createdByType === 'agent' && q.version.createdBy === opts.agentId) ||
        q.contributors.some((c) => c.type === 'agent' && c.id === opts.agentId))
  );

  await withTenantTx(owner.tenantId, async (tx) => {
    if (waiting.length > 0) {
      const docIds = waiting.map((q) => q.document.id);
      const indexedOf = new Map(
        (
          await tx
            .select({ id: documents.id, indexed: documents.indexedVersionId })
            .from(documents)
            .where(and(eq(documents.tenantId, owner.tenantId), inArray(documents.id, docIds)))
        ).map((d) => [d.id, d.indexed])
      );
      const versionIds = [...waiting.map((q) => q.version.id), ...[...indexedOf.values()].filter((v): v is string => v !== null)];
      const markdownOf = new Map(
        (
          await tx
            .select({ id: versions.id, markdown: versions.markdown })
            .from(versions)
            .where(and(eq(versions.tenantId, owner.tenantId), inArray(versions.id, versionIds)))
        ).map((v) => [v.id, v.markdown ?? ''])
      );
      for (const q of waiting) {
        const indexed = indexedOf.get(q.document.id) ?? null;
        out.push({
          type: 'version',
          id: q.version.id,
          page: { id: q.document.id, title: q.document.title, space: q.document.spaceName },
          kind: 'version',
          proposer: { type: q.version.createdByType === 'user' ? 'user' : 'agent', name: q.version.createdByName },
          created_at: q.version.createdAt,
          reason: null,
          before: clip(indexed ? (markdownOf.get(indexed) ?? '') : ''),
          after: clip(markdownOf.get(q.version.id) ?? ''),
          decidable: q.canApprove,
          ...(q.canApprove ? {} : { why_not: NOT_YOURS }),
        });
      }
    }

    const { editable } = await senderAccess(tx, owner);
    if (editable.length === 0) return;
    const rows = await tx
      .select({ s: suggestions, title: documents.title, spaceName: spaces.name })
      .from(suggestions)
      .innerJoin(documents, and(eq(documents.tenantId, suggestions.tenantId), eq(documents.id, suggestions.documentId)))
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .where(
        and(
          eq(suggestions.tenantId, owner.tenantId),
          eq(suggestions.status, 'open'),
          isNull(documents.archivedAt),
          inArray(documents.spaceId, editable),
          ...(opts.pageId !== undefined ? [eq(suggestions.documentId, opts.pageId)] : []),
          ...(opts.agentId !== undefined ? [eq(suggestions.proposedByType, 'agent'), eq(suggestions.proposedBy, opts.agentId)] : [])
        )
      )
      .orderBy(asc(suggestions.createdAt))
      .limit(MAX_ITEMS);
    const proposers = await proposerNames(tx, owner.tenantId, rows.map((r) => r.s));
    for (const { s: row, title, spaceName } of rows) {
      const summary = toSuggestionSummary(row, null, await suggestionField(tx, owner.tenantId, row), proposers);
      const can = await suggestionDecidable(tx, owner, row.id);
      let subPages: number | undefined;
      if (row.kind === 'archive') {
        const [c] = await tx
          .select({ n: count() })
          .from(documents)
          .where(and(eq(documents.tenantId, owner.tenantId), eq(documents.parentId, row.documentId), isNull(documents.archivedAt)));
        subPages = Number(c?.n ?? 0);
      }
      out.push({
        type: 'suggestion',
        id: row.id,
        page: { id: row.documentId, title, space: spaceName },
        kind: row.kind,
        proposer: summary.proposedBy ? { type: summary.proposedBy.type, name: summary.proposedBy.name } : { type: 'agent', name: 'the routing engine' },
        created_at: summary.createdAt,
        reason: row.reason,
        before: clip(summary.field ? summary.field.before : row.kind === 'insert' || row.kind === 'archive' ? null : row.expectedText),
        after: clip(summary.field ? summary.field.after : row.kind === 'remove' ? null : row.proposedMarkdown),
        ...(subPages !== undefined ? { sub_pages: subPages } : {}),
        decidable: can.ok,
        ...(can.ok ? {} : { why_not: can.why }),
      });
    }
  });

  return out.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, MAX_ITEMS);
}

export type ReviewDecision = { type: 'version' | 'suggestion'; id: string; decision: 'approve' | 'reject'; note?: string };
export type DecideResult = { ok: true; status: string } | { ok: false; message: string };

/**
 * Approves or rejects one item as `owner`, through the same routes as the web app. A refusal (someone else
 * decides it, it was already decided, the owner lost access) is `{ ok: false, message }`, never thrown.
 */
export async function decideReviewItem(
  owner: Actor,
  input: ReviewDecision,
  collab: CollabClient,
  audit: { agentId?: string } = {}
): Promise<DecideResult> {
  let status: string;
  try {
    if (input.type === 'version') {
      const note = input.note?.trim();
      const res =
        input.decision === 'approve'
          ? await approveVersion(owner, input.id, note ? { review_note: note } : {})
          : await rejectVersion(owner, input.id, { review_note: note || DEFAULT_REJECT_NOTE });
      status = res.status;
    } else {
      const res = input.decision === 'approve' ? await acceptSuggestion(owner, input.id, collab) : await declineSuggestion(owner, input.id);
      status = res.status;
    }
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
  await withTenantTx(owner.tenantId, (tx) =>
    writeAuditEvent(tx, {
      tenantId: owner.tenantId,
      type: 'review.decided_in_client',
      actorType: owner.principalType,
      actorId: owner.principalId,
      subjectType: input.type,
      subjectId: input.id,
      payload: { via: 'mcp_app', agentId: audit.agentId ?? null, decision: input.decision, status },
    })
  );
  return { ok: true, status };
}
