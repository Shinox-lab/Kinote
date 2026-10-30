import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { withTenantTx, documents, pages, versions } from '@kinote/db';
import type { AttentionItem, AttentionReason } from '@kinote/contracts';
import { isTenantAdmin, type Actor } from '@kinote/core';
import { computeFileBadge, computePageBadge, isAwaitingApproval } from '../pages/badge.js';
import { readableSpaces } from './updates.js';

const ORDER: Record<AttentionReason, number> = { failed: 0, review: 1, unindexed: 2 };
const LIMIT = 50;

/**
 * GET /api/v1/attention: the live pages and files that need someone, across the spaces the actor can read: indexing
 * failed, a version waits for a reviewer, or a page has edits that aren't indexed yet. Failed first, then review,
 * then unindexed; newest first within each. The Inbox's per-item rule applies as everywhere else.
 */
export async function listAttention(actor: Actor): Promise<AttentionItem[]> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const readable = await readableSpaces(tx, actor);
    if (readable.length === 0) return [];
    const byId = new Map(readable.map((s) => [s.id, s]));
    const inbox = readable.filter((s) => s.kind === 'inbox').map((s) => s.id);
    const others = readable.filter((s) => s.kind !== 'inbox').map((s) => s.id);
    const scopes: SQL[] = [];
    if (others.length > 0) scopes.push(inArray(documents.spaceId, others));
    if (inbox.length > 0) {
      scopes.push(
        isTenantAdmin(actor)
          ? inArray(documents.spaceId, inbox)
          : and(inArray(documents.spaceId, inbox), eq(documents.createdByType, actor.principalType), eq(documents.createdBy, actor.principalId))!,
      );
    }

    // Each document's latest version (highest number, as its badge reads it) and indexed version, in one query.
    const latest = alias(versions, 'latest_version');
    const indexed = alias(versions, 'indexed_version');
    const rows = await tx
      .select({
        id: documents.id,
        kind: documents.kind,
        title: documents.title,
        spaceId: documents.spaceId,
        placement: documents.placement,
        sourceDeletedAt: documents.sourceDeletedAt,
        liveChangedSinceSnapshot: pages.liveChangedSinceSnapshot,
        liveUpdatedAt: pages.liveUpdatedAt,
        agentChangedAt: pages.agentChangedAt,
        latestNumber: latest.number,
        latestStatus: latest.status,
        latestExtractedKey: latest.extractedKey,
        latestCreatedAt: latest.createdAt,
        indexedNumber: indexed.number,
      })
      .from(documents)
      .leftJoin(pages, and(eq(pages.tenantId, documents.tenantId), eq(pages.documentId, documents.id)))
      .leftJoin(
        latest,
        and(
          eq(latest.tenantId, documents.tenantId),
          eq(latest.documentId, documents.id),
          sql`${latest.number} = (select max(v.number) from ${versions} v where v.tenant_id = ${documents.tenantId} and v.document_id = ${documents.id})`,
        ),
      )
      .leftJoin(indexed, and(eq(indexed.tenantId, documents.tenantId), eq(indexed.id, documents.indexedVersionId)))
      .where(and(eq(documents.tenantId, actor.tenantId), isNull(documents.archivedAt), scopes.length === 1 ? scopes[0] : sql`(${sql.join(scopes, sql` or `)})`));

    const out: AttentionItem[] = [];
    for (const r of rows) {
      const space = byId.get(r.spaceId)!;
      const latestVersion = r.latestNumber !== null && r.latestStatus !== null ? { number: r.latestNumber, status: r.latestStatus } : null;
      const indexedVersion = r.indexedNumber !== null ? { number: r.indexedNumber } : null;
      let reason: AttentionReason | null = null;
      let badge: string;
      let changedAt: Date | null;
      if (r.kind === 'page') {
        const input = {
          liveChangedSinceSnapshot: r.liveChangedSinceSnapshot ?? false,
          agentChangedAt: r.agentChangedAt,
          spaceReviewRequired: space.reviewRequired,
          latestVersion,
          indexedVersion,
        };
        badge = computePageBadge(input);
        if (latestVersion?.status === 'failed') reason = 'failed';
        else if (isAwaitingApproval(input)) reason = 'review';
        else if (badge.startsWith('Saved') || badge === 'Indexing…' || (input.liveChangedSinceSnapshot && badge.startsWith('Indexed'))) reason = 'unindexed';
        changedAt = r.liveUpdatedAt ?? r.latestCreatedAt;
      } else {
        badge = computeFileBadge({
          latestVersion: latestVersion ? { ...latestVersion, hasText: r.latestExtractedKey !== null && latestVersion.status !== 'stored' } : null,
          indexedVersion,
          sourceDeleted: r.sourceDeletedAt !== null,
          placement: r.placement,
        });
        if (latestVersion?.status === 'failed') reason = 'failed';
        else if (latestVersion?.status === 'pending_review') reason = 'review';
        changedAt = r.latestCreatedAt;
      }
      if (!reason || !changedAt) continue;
      out.push({
        reason,
        badge,
        changedAt: changedAt.toISOString(),
        document: { id: r.id, title: r.title, kind: r.kind, spaceId: r.spaceId, spaceName: space.name },
      });
    }
    return out
      .sort((a, b) => ORDER[a.reason] - ORDER[b.reason] || b.changedAt.localeCompare(a.changedAt))
      .slice(0, LIMIT);
  });
}
