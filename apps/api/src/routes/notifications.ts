import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { documents, notifications, spaces, withTenantTx, type DbTransaction } from '@kinote/db';
import { MarkNotificationsReadRequestSchema, type NotificationList } from '@kinote/contracts';
import type { Actor } from '@kinote/core';
import { resolveActorNames } from '../people.js';
import { spaceOfDocument, visibleDocuments } from './connections.js';

const LIST_SIZE = 50;

/**
 * The caller's notifications they may still see: one about a document only
 * while they can read it (moved, archived or access lost hides it).
 */
async function mine(tx: DbTransaction, actor: Actor): Promise<SQL> {
  const visible = await visibleDocuments(tx, actor);
  return and(
    eq(notifications.tenantId, actor.tenantId),
    eq(notifications.recipientId, actor.principalId),
    visible ? or(isNull(notifications.documentId), visible) : isNull(notifications.documentId)
  )!;
}

async function unreadCount(tx: DbTransaction, actor: Actor): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .leftJoin(documents, and(eq(documents.tenantId, notifications.tenantId), eq(documents.id, notifications.documentId)))
    .leftJoin(spaces, spaceOfDocument)
    .where(and(await mine(tx, actor), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** GET /api/v1/notifications: the newest 50, and how many are unread. */
export async function listNotifications(actor: Actor): Promise<NotificationList> {
  if (actor.principalType !== 'user') return { unread: 0, items: [] };
  return withTenantTx(actor.tenantId, async (tx) => {
    const rows = await tx
      .select({
        n: notifications,
        documentKind: documents.kind,
        documentTitle: documents.title,
      })
      .from(notifications)
      .leftJoin(documents, and(eq(documents.tenantId, notifications.tenantId), eq(documents.id, notifications.documentId)))
      .leftJoin(spaces, spaceOfDocument)
      .where(await mine(tx, actor))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(LIST_SIZE);
    const names = await resolveActorNames(
      tx,
      actor.tenantId,
      rows.map((r) => ({ type: r.n.actorType, id: r.n.actorId }))
    );
    return {
      unread: await unreadCount(tx, actor),
      items: rows.map(({ n, documentKind, documentTitle }) => ({
        id: n.id,
        kind: n.kind,
        actorName: names.get(`${n.actorType}:${n.actorId}`)!,
        documentId: n.documentId,
        documentKind: documentKind ?? null,
        documentTitle: documentTitle ?? null,
        blockId: n.blockId,
        threadId: n.threadId,
        captureId: n.captureId,
        excerpt: n.excerpt,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
    };
  });
}

/** POST /api/v1/notifications/read: marks some (or all) read; answers the new unread count. */
export async function markNotificationsRead(actor: Actor, input: unknown): Promise<{ unread: number }> {
  const { ids } = MarkNotificationsReadRequestSchema.parse(input);
  if (actor.principalType !== 'user') return { unread: 0 };
  return withTenantTx(actor.tenantId, async (tx) => {
    await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.tenantId, actor.tenantId),
          eq(notifications.recipientId, actor.principalId),
          isNull(notifications.readAt),
          ids ? inArray(notifications.id, ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']) : undefined
        )
      );
    return { unread: await unreadCount(tx, actor) };
  });
}
