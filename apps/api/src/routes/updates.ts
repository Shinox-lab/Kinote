import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { withTenantTx, documents, spaces, versions, type DbTransaction } from '@kinote/db';
import { UpdatesQuerySchema, AppError, type UpdateItem } from '@kinote/contracts';
import { requireSpaceRole, isTenantAdmin, type Actor } from '@kinote/core';
import { resolveActorNames } from '../people.js';

/** The statuses worth announcing; superseded, extracting, indexing and stored rows are plumbing. */
const SHOWN_STATUSES = ['pending_review', 'indexed', 'rejected', 'withdrawn', 'failed'] as const;

export type ReadableSpace = { id: string; name: string; kind: string; reviewRequired: boolean };

/** The non-archived spaces the actor can read (the same gate every read route uses); unreadable ones are skipped. */
export async function readableSpaces(tx: DbTransaction, actor: Actor): Promise<ReadableSpace[]> {
  const candidates = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.tenantId, actor.tenantId), isNull(spaces.archivedAt)));
  const readable: ReadableSpace[] = [];
  for (const { id } of candidates) {
    try {
      const { space } = await requireSpaceRole(tx, actor, id, 'viewer');
      readable.push({ id: space.id, name: space.name, kind: space.kind, reviewRequired: space.reviewRequired });
    } catch (err) {
      if (err instanceof AppError && (err.code === 'space_not_found' || err.code === 'forbidden')) continue;
      throw err;
    }
  }
  return readable;
}

/**
 * GET /api/v1/updates?limit=: the newest versions of pages and files across
 * the spaces the actor can read, for the sidebar's Updates section. Archived
 * documents and archived spaces never appear (not even for admins); the
 * Inbox's per-item rule applies in the query itself (a document there is
 * visible to its creator and to tenant owners and admins), so hidden rows never
 * shorten the page of results. The actor is the version's creator: a member or
 * agent by name, a connector as "System", a user who left as "Former member".
 */
export async function listUpdates(actor: Actor, query: unknown): Promise<UpdateItem[]> {
  const { limit } = UpdatesQuerySchema.parse(query ?? {});

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
          : and(
              inArray(documents.spaceId, inbox),
              eq(documents.createdByType, actor.principalType),
              eq(documents.createdBy, actor.principalId)
            )!
      );
    }

    const rows = await tx
      .select({
        versionId: versions.id,
        number: versions.number,
        status: versions.status,
        reason: versions.reason,
        createdAt: versions.createdAt,
        actorType: versions.createdByType,
        actorId: versions.createdBy,
        documentId: documents.id,
        title: documents.title,
        kind: documents.kind,
        spaceId: documents.spaceId,
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
          isNull(documents.archivedAt),
          inArray(versions.status, [...SHOWN_STATUSES]),
          or(...scopes)
        )
      )
      .orderBy(desc(versions.createdAt), desc(versions.id))
      .limit(limit);

    const names = await resolveActorNames(
      tx,
      actor.tenantId,
      rows.map((r) => ({ type: r.actorType, id: r.actorId }))
    );

    return rows.map((r) => ({
      versionId: r.versionId,
      number: r.number,
      status: r.status as UpdateItem['status'],
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      document: {
        id: r.documentId,
        title: r.title,
        kind: r.kind,
        spaceId: r.spaceId,
        spaceName: byId.get(r.spaceId)!.name,
      },
      actor:
        r.actorType === 'connector'
          ? { type: 'system' as const, id: null, name: names.get(`connector:${r.actorId}`)! }
          : {
              type: r.actorType,
              id: r.actorId,
              name: names.get(`${r.actorType}:${r.actorId}`)!,
            },
    }));
  });
}
