import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  blockActivity,
  documents,
  spaces,
  withTenantTx,
} from '@living-wiki/db';
import { getReadableSpaceIds, isTenantAdmin, type Actor } from '@living-wiki/core';
import { RecentQuerySchema, type RecentItem } from '@living-wiki/contracts';

/**
 * The caller's Continue cards: pages they last changed (the newest block
 * activity) and files they uploaded, newest first, deduped by document. Only
 * live documents in spaces they can still read.
 */
export async function listRecent(actor: Actor, query: unknown): Promise<RecentItem[]> {
  const { limit } = RecentQuerySchema.parse(query);

  return withTenantTx(actor.tenantId, async (tx) => {
    const { readableSpaceIds } = await getReadableSpaceIds(tx, actor);
    if (readableSpaceIds.length === 0) return [];

    // Inbox documents are private to their creator (tenant admins excepted), even though the space is readable.
    const inboxRule = isTenantAdmin(actor)
      ? undefined
      : or(
          ne(spaces.kind, 'inbox'),
          and(
            eq(spaces.kind, 'inbox'),
            eq(documents.createdByType, actor.principalType),
            eq(documents.createdBy, actor.principalId)
          )
        );
    const changedAt = sql<Date>`max(${blockActivity.changedAt})`;
    const pageRows = await tx
      .select({
        id: documents.id,
        kind: documents.kind,
        title: documents.title,
        icon: documents.icon,
        spaceId: spaces.id,
        spaceName: spaces.name,
        at: changedAt,
      })
      .from(blockActivity)
      .innerJoin(
        documents,
        and(eq(documents.tenantId, blockActivity.tenantId), eq(documents.id, blockActivity.pageId))
      )
      .innerJoin(
        spaces,
        and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId))
      )
      .where(
        and(
          eq(blockActivity.tenantId, actor.tenantId),
          eq(blockActivity.actorType, actor.principalType),
          eq(blockActivity.actorId, actor.principalId),
          eq(documents.kind, 'page'),
          isNull(documents.archivedAt),
          isNull(spaces.archivedAt),
          inArray(documents.spaceId, readableSpaceIds),
          inboxRule
        )
      )
      .groupBy(documents.id, documents.kind, documents.title, documents.icon, spaces.id, spaces.name)
      .orderBy(desc(changedAt))
      .limit(limit);

    const fileRows = await tx
      .select({
        id: documents.id,
        kind: documents.kind,
        title: documents.title,
        icon: documents.icon,
        spaceId: spaces.id,
        spaceName: spaces.name,
        at: documents.createdAt,
      })
      .from(documents)
      .innerJoin(
        spaces,
        and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId))
      )
      .where(
        and(
          eq(documents.tenantId, actor.tenantId),
          eq(documents.kind, 'file'),
          eq(documents.createdByType, actor.principalType),
          eq(documents.createdBy, actor.principalId),
          isNull(documents.archivedAt),
          isNull(spaces.archivedAt),
          inArray(documents.spaceId, readableSpaceIds),
          inboxRule
        )
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit);

    const seen = new Set<string>();
    return [...pageRows, ...fileRows]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        icon: row.icon,
        spaceId: row.spaceId,
        spaceName: row.spaceName,
        at: new Date(row.at).toISOString(),
      }));
  });
}
