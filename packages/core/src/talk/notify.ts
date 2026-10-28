import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  blockActivity,
  memberships,
  notifications,
  userMentions,
  users,
  type DbTransaction,
  type DocumentRow,
  type NOTIFICATION_KINDS,
} from '@living-wiki/db';
import { flattenBlocks, mentionsOf, type BlockLike } from '@living-wiki/shared';
import { requireDocumentRole, requireSpaceRole, type Actor, type SpaceRole } from '../permissions.js';

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationInput {
  recipientId: string;
  kind: NotificationKind;
  actorType: 'user' | 'agent' | 'connector';
  actorId: string;
  documentId?: string | null;
  blockId?: string | null;
  threadId?: string | null;
  captureId?: string | null;
  excerpt?: string | null;
}

const EXCERPT_CHARS = 160;

/** A one-line excerpt: whitespace folded, cut at 160 characters. */
export function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/** Inserts notifications; a person is never notified of their own action, and each recipient once per call. */
export async function notify(tx: DbTransaction, tenantId: string, items: NotificationInput[]): Promise<number> {
  const seen = new Set<string>();
  const rows = items.filter((n) => {
    if (n.actorType === 'user' && n.actorId === n.recipientId) return false;
    const key = `${n.recipientId}:${n.kind}:${n.documentId ?? ''}:${n.blockId ?? ''}:${n.threadId ?? ''}:${n.captureId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (rows.length === 0) return 0;
  await tx.insert(notifications).values(
    rows.map((n) => ({
      tenantId,
      recipientId: n.recipientId,
      kind: n.kind,
      actorType: n.actorType,
      actorId: n.actorId,
      documentId: n.documentId ?? null,
      blockId: n.blockId ?? null,
      threadId: n.threadId ?? null,
      captureId: n.captureId ?? null,
      excerpt: n.excerpt ?? null,
    }))
  );
  return rows.length;
}

/** The workspace's people as actors (their tenant role included), for "may they read this?". */
export async function memberActors(tx: DbTransaction, tenantId: string, userIds?: string[]): Promise<Actor[]> {
  if (userIds && userIds.length === 0) return [];
  const rows = await tx
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), userIds ? inArray(memberships.userId, userIds) : undefined));
  return rows.map((r) => ({ tenantId, principalType: 'user' as const, principalId: r.userId, tenantRole: r.role }));
}

/** Whether `actor` may open `doc` at `role` or above. */
export async function canOpen(
  tx: DbTransaction,
  actor: Actor,
  doc: Pick<DocumentRow, 'id' | 'spaceId' | 'createdByType' | 'createdBy'>,
  role: SpaceRole = 'viewer'
): Promise<boolean> {
  try {
    await requireDocumentRole(tx, actor, doc, role);
    return true;
  } catch {
    return false;
  }
}

/** The people who hold at least `role` in a space (tenant admins included). */
export async function usersWithSpaceRole(tx: DbTransaction, tenantId: string, spaceId: string, role: SpaceRole): Promise<string[]> {
  const out: string[] = [];
  for (const actor of await memberActors(tx, tenantId)) {
    try {
      await requireSpaceRole(tx, actor, spaceId, role);
      out.push(actor.principalId);
    } catch {
      // Not enough rights in this space.
    }
  }
  return out;
}

/**
 * Records the mentions of a page's blocks and notifies people mentioned in a
 * place they were not mentioned in before. The mentioner is the block's last
 * editor when that was a person, else `fallback`. People who can't read the
 * page are recorded but not told.
 */
export async function recordPageMentions(
  tx: DbTransaction,
  doc: DocumentRow,
  blocks: BlockLike[],
  fallback: { type: 'user' | 'agent'; id: string }
): Promise<void> {
  const found = mentionsOf(blocks);
  if (found.length === 0) return;
  const tenantId = doc.tenantId;
  const known = new Set((await memberActors(tx, tenantId, [...new Set(found.map((m) => m.userId))])).map((a) => a.principalId));
  const mine = found.filter((m) => known.has(m.userId));
  if (mine.length === 0) return;
  const inserted = await tx
    .insert(userMentions)
    .values(mine.map((m) => ({ tenantId, userId: m.userId, documentId: doc.id, blockId: m.blockId })))
    .onConflictDoNothing()
    .returning({ userId: userMentions.userId, blockId: userMentions.blockId });
  if (inserted.length === 0) return;

  const texts = new Map(flattenBlocks(blocks).map((b) => [b.id, b.text]));
  const editors = new Map(
    (
      await tx
        .select({ blockId: blockActivity.blockId, actorType: blockActivity.actorType, actorId: blockActivity.actorId })
        .from(blockActivity)
        .where(
          and(
            eq(blockActivity.tenantId, tenantId),
            eq(blockActivity.pageId, doc.id),
            inArray(blockActivity.blockId, inserted.map((i) => i.blockId))
          )
        )
    ).map((r) => [r.blockId, r])
  );
  const readers = await memberActors(tx, tenantId, [...new Set(inserted.map((i) => i.userId))]);
  const allowed = new Set<string>();
  for (const actor of readers) if (await canOpen(tx, actor, doc)) allowed.add(actor.principalId);

  await notify(
    tx,
    tenantId,
    inserted
      .filter((i) => allowed.has(i.userId))
      .map((i) => {
        const by = editors.get(i.blockId);
        const actor = by && by.actorType === 'user' ? { type: 'user' as const, id: by.actorId } : fallback;
        return {
          recipientId: i.userId,
          kind: 'mention' as const,
          actorType: actor.type,
          actorId: actor.id,
          documentId: doc.id,
          blockId: i.blockId,
          excerpt: excerptOf(texts.get(i.blockId) ?? ''),
        };
      })
  );
}

/**
 * The people a comment mentions as `@Full Name`: comments are written in a
 * plain editor with no picker, so a mention is the person's name after `@`.
 * A name two members share mentions neither (it can't say which).
 */
export function textMentions(text: string, members: Array<{ id: string; name: string }>): string[] {
  const lower = text.toLowerCase();
  const byName = new Map<string, string[]>();
  for (const m of members) {
    const name = m.name.trim().toLowerCase();
    if (name) byName.set(name, [...(byName.get(name) ?? []), m.id]);
  }
  const out: string[] = [];
  // Longest names first, so "@Ann Lee" is not also read as "@Ann".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const taken: Array<[number, number]> = [];
  for (const name of names) {
    const ids = byName.get(name)!;
    let at = lower.indexOf(`@${name}`);
    while (at !== -1) {
      const end = at + name.length + 1;
      const next = lower[end];
      const boundary = next === undefined || !/[\p{L}\p{N}_]/u.test(next);
      const overlaps = taken.some(([s, e]) => at < e && end > s);
      if (boundary && !overlaps) {
        taken.push([at, end]);
        if (ids.length === 1 && !out.includes(ids[0]!)) out.push(ids[0]!);
      }
      at = lower.indexOf(`@${name}`, end);
    }
  }
  return out;
}

/** The workspace's people with their names, for comment mentions. */
export async function memberNames(tx: DbTransaction, tenantId: string): Promise<Array<{ id: string; name: string }>> {
  return tx
    .select({ id: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId));
}

/** Whether `recipient` already has an unread notification of `kind` about `captureId`. */
export async function hasUnreadAbout(tx: DbTransaction, tenantId: string, recipientId: string, kind: NotificationKind, captureId: string) {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(notifications)
    .where(
      and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.recipientId, recipientId),
        eq(notifications.kind, kind),
        eq(notifications.captureId, captureId),
        isNull(notifications.readAt)
      )
    )
    .limit(1);
  return row !== undefined;
}
