import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  withTenantTx,
  captureChanges,
  captures,
  suggestions,
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
import { requireSpaceRole, assertValidUuid, isTenantAdmin, senderAccess, type Actor } from '@living-wiki/core';
import { canApprove, type SpaceRow } from '../pages/approval.js';
import { resolveActorNames } from '../people.js';
import { versionSummaryColumns, toVersionSummary } from './pages.js';
import { conflictNames, toSuggestionSummary } from './captures.js';

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
    const bundles = await captureBundles(tx, actor, visible.map((r) => r.id));
    const suggestionRows = await tx
      .select()
      .from(suggestions)
      .where(
        and(
          eq(suggestions.tenantId, actor.tenantId),
          eq(suggestions.status, 'open'),
          inArray(suggestions.documentId, [...new Set(visible.map((r) => r.documentId))])
        )
      )
      .orderBy(asc(suggestions.createdAt));
    const openSuggestions = new Map<string, typeof suggestionRows>();
    for (const row of suggestionRows) openSuggestions.set(row.documentId, [...(openSuggestions.get(row.documentId) ?? []), row]);
    const names = await conflictNames(tx, actor.tenantId, suggestionRows);

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
        capture: bundles.get(r.id) ?? null,
        suggestions: (openSuggestions.get(r.documentId) ?? []).map((row) =>
          toSuggestionSummary(row, row.conflictCitationId ? names.get(row.conflictCitationId) ?? null : null)
        ),
      };
    });
    return groupByCapture(items);
  });
}

/**
 * Keeps the queue's order but moves every item of a capture up next to that
 * capture's first item, so a reviewer sees one capture's pages together.
 */
function groupByCapture<T extends { capture: { id: string } | null }>(items: T[]): T[] {
  const out: T[] = [];
  const placed = new Set<T>();
  for (const item of items) {
    if (placed.has(item)) continue;
    const group = item.capture ? items.filter((i) => i.capture?.id === item.capture!.id) : [item];
    for (const g of group) {
      out.push(g);
      placed.add(g);
    }
  }
  return out;
}

/** Per waiting version: the capture its routed changes came from, as the reviewer may see it. */
async function captureBundles(tx: DbTransaction, actor: Actor, versionIds: string[]) {
  const bundles = new Map<string, ReviewItem['capture']>();
  if (versionIds.length === 0) return bundles;
  const links = await tx
    .selectDistinct({ versionId: captureChanges.versionId, captureId: captureChanges.captureId, documentId: captureChanges.documentId })
    .from(captureChanges)
    .where(and(eq(captureChanges.tenantId, actor.tenantId), inArray(captureChanges.versionId, versionIds)));
  if (links.length === 0) return bundles;
  const captureIds = [...new Set(links.map((l) => l.captureId))];
  const rows = await tx
    .select()
    .from(captures)
    .where(and(eq(captures.tenantId, actor.tenantId), inArray(captures.id, captureIds)));
  const senders = await resolveActorNames(
    tx,
    actor.tenantId,
    rows.map((c) => ({ type: c.senderType, id: c.senderId }))
  );
  const { readable } = await senderAccess(tx, actor);
  const touched = await tx
    .selectDistinct({ captureId: captureChanges.captureId, documentId: captureChanges.documentId, title: documents.title })
    .from(captureChanges)
    .innerJoin(documents, and(eq(documents.tenantId, captureChanges.tenantId), eq(documents.id, captureChanges.documentId)))
    .where(
      and(
        eq(captureChanges.tenantId, actor.tenantId),
        inArray(captureChanges.captureId, captureIds),
        inArray(captureChanges.spaceId, readable.length > 0 ? readable : ['00000000-0000-0000-0000-000000000000']),
        ne(captureChanges.status, 'undone')
      )
    );
  for (const link of links) {
    const capture = rows.find((c) => c.id === link.captureId);
    if (!capture || !link.versionId) continue;
    bundles.set(link.versionId, {
      id: capture.id,
      senderName: senders.get(`${capture.senderType}:${capture.senderId}`) ?? 'Former member',
      excerpt: capture.text.slice(0, 280),
      alsoApplied: touched
        .filter((t) => t.captureId === capture.id && t.documentId !== link.documentId)
        .map((t) => ({ pageId: t.documentId, title: t.title })),
    });
  }
  return bundles;
}
