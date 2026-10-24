import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  spaces,
  versions,
  versionContributors,
  users,
  agents,
  type DbTransaction,
} from '@living-wiki/db';
import {
  ReviewQuerySchema,
  AppError,
  type ReviewItem,
} from '@living-wiki/contracts';
import { requireSpaceRole, assertValidUuid, isTenantAdmin, type Actor } from '@living-wiki/core';
import { canApprove, type SpaceRow } from '../pages/approval.js';
import { resolveActorNames } from '../people.js';
import { versionSummaryColumns, toVersionSummary } from './pages.js';

/**
 * The space when the actor holds `reviewer` or above in it, else null. An
 * unreadable space (other tenant, unknown, no grant, archived for a
 * non-admin) is 404 `space_not_found` from the gate; a readable one below
 * reviewer, or an archived one (nothing in it can be approved: approve is 409
 * `space_archived`), is null.
 */
async function reviewableSpace(
  tx: DbTransaction,
  actor: Actor,
  spaceId: string
): Promise<SpaceRow | null> {
  try {
    const { space } = await requireSpaceRole(tx, actor, spaceId, 'reviewer', {
      allowArchived: true,
    });
    return space.archivedAt ? null : space;
  } catch (err) {
    if (err instanceof AppError && err.code === 'forbidden') return null;
    throw err;
  }
}

/**
 * GET /api/v1/reviews: the `pending_review` versions the actor could review,
 * oldest first. Spaces where the actor holds reviewer or above (tenant owners
 * and admins: every non-archived space, the Inbox included); anyone else,
 * agents included, gets `[]` (never 403). With `space_id`, a space the actor
 * cannot read is the same 404 `space_not_found` as an unknown one, a readable
 * space below reviewer is `[]`. Summaries only: never markdown, blocks or Yjs
 * bytes. `canApprove` is the rule `approveVersion` enforces.
 */
export async function listReviewQueue(actor: Actor, query: unknown): Promise<ReviewItem[]> {
  const { space_id: spaceId } = ReviewQuerySchema.parse(query ?? {});
  if (spaceId !== undefined) assertValidUuid(spaceId, 'space_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const reviewable = new Map<string, SpaceRow>();
    if (spaceId !== undefined) {
      const space = await reviewableSpace(tx, actor, spaceId);
      if (space) reviewable.set(space.id, space);
    } else {
      const candidates = await tx
        .select()
        .from(spaces)
        .where(and(eq(spaces.tenantId, actor.tenantId), isNull(spaces.archivedAt)));
      for (const candidate of candidates) {
        try {
          const space = await reviewableSpace(tx, actor, candidate.id);
          if (space) reviewable.set(space.id, space);
        } catch (err) {
          if (err instanceof AppError && err.code === 'space_not_found') continue;
          throw err;
        }
      }
    }
    if (reviewable.size === 0) return [];

    const rows = await tx
      .select({
        ...versionSummaryColumns,
        documentId: documents.id,
        title: documents.title,
        icon: documents.icon,
        kind: documents.kind,
        spaceId: documents.spaceId,
        fileName: versions.fileName,
        mimeType: versions.mimeType,
        sizeBytes: versions.sizeBytes,
        docCreatedByType: documents.createdByType,
        docCreatedBy: documents.createdBy,
      })
      .from(versions)
      .innerJoin(
        documents,
        and(eq(documents.tenantId, versions.tenantId), eq(documents.id, versions.documentId))
      )
      .where(
        and(
          eq(versions.tenantId, actor.tenantId),
          eq(documents.tenantId, actor.tenantId),
          eq(versions.status, 'pending_review'),
          isNull(documents.archivedAt),
          inArray(documents.spaceId, [...reviewable.keys()])
        )
      )
      .orderBy(asc(versions.createdAt), asc(versions.id));

    // The Inbox's per-item rule (as requireDocumentRole): a document there is
    // visible only to its creator and to tenant owners and admins.
    const visible = rows.filter((r) => {
      const space = reviewable.get(r.spaceId)!;
      if (space.kind !== 'inbox' || isTenantAdmin(actor)) return true;
      return r.docCreatedByType === actor.principalType && r.docCreatedBy === actor.principalId;
    });
    if (visible.length === 0) return [];

    const contributorRows = await tx
      .select({
        versionId: versionContributors.versionId,
        type: versionContributors.principalType,
        id: versionContributors.principalId,
        userName: users.name,
        agentName: agents.name,
      })
      .from(versionContributors)
      .leftJoin(users, eq(users.id, versionContributors.principalId))
      .leftJoin(
        agents,
        and(eq(agents.id, versionContributors.principalId), eq(agents.tenantId, actor.tenantId))
      )
      .where(
        and(
          eq(versionContributors.tenantId, actor.tenantId),
          inArray(
            versionContributors.versionId,
            visible.map((r) => r.id)
          )
        )
      );
    const byVersion = new Map<string, typeof contributorRows>();
    for (const c of contributorRows) {
      const list = byVersion.get(c.versionId) ?? [];
      list.push(c);
      byVersion.set(c.versionId, list);
    }

    const creators = await resolveActorNames(
      tx,
      actor.tenantId,
      visible.map((r) => ({ type: r.createdByType, id: r.createdBy }))
    );
    const items = visible.map((r) => {
      const space = reviewable.get(r.spaceId)!;
      const contributors = byVersion.get(r.id) ?? [];
      return {
        version: {
          ...toVersionSummary(r),
          createdByName: creators.get(`${r.createdByType}:${r.createdBy}`) ?? 'Former member',
        },
        document: {
          id: r.documentId,
          title: r.title,
          icon: r.icon,
          kind: r.kind,
          spaceId: r.spaceId,
          spaceName: space.name,
        },
        file:
          r.kind === 'file'
            ? {
                fileName: r.fileName ?? r.title,
                mimeType: r.mimeType ?? 'application/octet-stream',
                sizeBytes: r.sizeBytes ?? 0,
              }
            : null,
        contributors: contributors
          .map((c) => ({
            type: c.type,
            id: c.id,
            name: (c.type === 'agent' ? c.agentName : c.userName) ?? c.id,
            isAgent: c.type === 'agent',
          }))
          .sort(
            (a, b) =>
              a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
          ),
        canApprove: canApprove(
          actor,
          { createdByType: r.createdByType, createdBy: r.createdBy },
          contributors.map((c) => ({ principalType: c.type, principalId: c.id })),
          space
        ),
      };
    });
    return items;
  });
}
