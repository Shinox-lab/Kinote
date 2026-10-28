import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  commentThreads,
  comments,
  documents,
  memberships,
  userMentions,
  users,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import {
  AppError,
  CommentRequestSchema,
  CreateThreadRequestSchema,
  MentionableQuerySchema,
  type CommentThread,
  type Mentionable,
} from '@living-wiki/contracts';
import {
  assertValidUuid,
  canOpen,
  excerptOf,
  isTenantAdmin,
  memberActors,
  memberNames,
  notify,
  requireDocumentRole,
  textMentions,
  type Actor,
  type NotificationInput,
} from '@living-wiki/core';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';
import { resolveActorNames } from '../people.js';

/** The most text one comment may hold (`comment_too_long`). */
const COMMENT_MAX_CHARS = 5_000;

type ThreadRow = typeof commentThreads.$inferSelect;
type CommentRow = typeof comments.$inferSelect;

/** A comment body's plain text, refusing one over the limit. */
function commentText(body: unknown[]): string {
  const text = flattenBlocks(body as BlockLike[])
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (text.length > COMMENT_MAX_CHARS) throw new AppError('comment_too_long');
  return text;
}

function requireUser(actor: Actor) {
  // Comments are people talking; an agent's word goes through captures.
  if (actor.principalType !== 'user') throw new AppError('forbidden');
}

async function pageFor(tx: DbTransaction, actor: Actor, pageId: string, role: 'viewer' | 'editor') {
  assertValidUuid(pageId, 'page_not_found');
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
  if (!doc || doc.kind !== 'page') throw new AppError('page_not_found');
  // Reading needs read access (404 otherwise); writing needs edit rights (403) on a live page.
  const access = await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'page_not_found' });
  if (role === 'editor') {
    await requireDocumentRole(tx, actor, doc, 'editor');
    if (doc.archivedAt) throw new AppError('page_archived');
  }
  return { doc, access };
}

/** The thread (not deleted) and its page, checked the same way as the page. */
async function threadFor(tx: DbTransaction, actor: Actor, threadId: string, role: 'viewer' | 'editor') {
  assertValidUuid(threadId, 'thread_not_found');
  const [thread] = await tx
    .select()
    .from(commentThreads)
    .where(and(eq(commentThreads.tenantId, actor.tenantId), eq(commentThreads.id, threadId), isNull(commentThreads.deletedAt)));
  if (!thread) throw new AppError('thread_not_found');
  try {
    return { thread, ...(await pageFor(tx, actor, thread.documentId, role)) };
  } catch (err) {
    // A thread on a page the caller can't read does not exist for them.
    if (err instanceof AppError && err.code === 'page_not_found') throw new AppError('thread_not_found');
    throw err;
  }
}

async function commentFor(tx: DbTransaction, actor: Actor, commentId: string) {
  assertValidUuid(commentId, 'comment_not_found');
  const [comment] = await tx
    .select()
    .from(comments)
    .where(and(eq(comments.tenantId, actor.tenantId), eq(comments.id, commentId), isNull(comments.deletedAt)));
  if (!comment) throw new AppError('comment_not_found');
  try {
    return { comment, ...(await threadFor(tx, actor, comment.threadId, 'viewer')) };
  } catch (err) {
    if (err instanceof AppError && err.code === 'thread_not_found') throw new AppError('comment_not_found');
    throw err;
  }
}

async function toThreads(tx: DbTransaction, tenantId: string, threads: ThreadRow[]): Promise<CommentThread[]> {
  if (threads.length === 0) return [];
  const rows = await tx
    .select()
    .from(comments)
    .where(and(eq(comments.tenantId, tenantId), inArray(comments.threadId, threads.map((t) => t.id))))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const names = await resolveActorNames(
    tx,
    tenantId,
    rows.map((c) => ({ type: 'user' as const, id: c.authorId }))
  );
  return threads.map((t) => ({
    id: t.id,
    documentId: t.documentId,
    blockId: t.blockId,
    quote: t.quote,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    resolved: t.resolvedAt !== null,
    resolvedBy: t.resolvedBy,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    comments: rows
      .filter((c) => c.threadId === t.id)
      .map((c) => ({
        id: c.id,
        authorId: c.authorId,
        authorName: names.get(`user:${c.authorId}`)!,
        body: c.deletedAt ? null : (c.body as Array<Record<string, unknown>>),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        deletedAt: c.deletedAt?.toISOString() ?? null,
      })),
  }));
}

async function oneThread(tx: DbTransaction, tenantId: string, threadId: string): Promise<CommentThread> {
  const [thread] = await tx
    .select()
    .from(commentThreads)
    .where(and(eq(commentThreads.tenantId, tenantId), eq(commentThreads.id, threadId)));
  return (await toThreads(tx, tenantId, [thread!]))[0]!;
}

/**
 * Who a new or edited comment tells: people it mentions by `@Full Name` for
 * the first time (one row per comment), and on a reply, everyone already in
 * the thread. Only people who can read the page are told.
 */
async function tellAboutComment(
  tx: DbTransaction,
  actor: Actor,
  doc: DocumentRow,
  thread: ThreadRow,
  comment: CommentRow,
  text: string,
  isReply: boolean
) {
  const tenantId = actor.tenantId;
  const items: NotificationInput[] = [];
  const base = {
    actorType: 'user' as const,
    actorId: actor.principalId,
    documentId: doc.id,
    blockId: thread.blockId,
    threadId: thread.id,
    excerpt: excerptOf(text),
  };
  const mentioned = textMentions(text, await memberNames(tx, tenantId)).filter((id) => id !== actor.principalId);
  if (mentioned.length > 0) {
    const fresh = await tx
      .insert(userMentions)
      .values(mentioned.map((userId) => ({ tenantId, userId, documentId: doc.id, commentId: comment.id })))
      .onConflictDoNothing()
      .returning({ userId: userMentions.userId });
    for (const f of fresh) items.push({ ...base, recipientId: f.userId, kind: 'mention' });
  }
  if (isReply) {
    const earlier = await tx
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(and(eq(comments.tenantId, tenantId), eq(comments.threadId, thread.id), isNull(comments.deletedAt)));
    const inThread = new Set([thread.createdBy, ...earlier.map((c) => c.authorId)]);
    // Someone mentioned here hears about it once, as a mention.
    for (const id of inThread) if (!items.some((i) => i.recipientId === id)) items.push({ ...base, recipientId: id, kind: 'comment_reply' });
  }
  const readers = await memberActors(tx, tenantId, [...new Set(items.map((i) => i.recipientId))]);
  const allowed = new Set<string>();
  for (const reader of readers) if (await canOpen(tx, reader, doc)) allowed.add(reader.principalId);
  await notify(tx, tenantId, items.filter((i) => allowed.has(i.recipientId)));
}

/** GET /api/v1/pages/:id/threads: the page's threads (deleted ones left out), oldest first. */
export async function listThreads(actor: Actor, pageId: string): Promise<CommentThread[]> {
  return withTenantTx(actor.tenantId, async (tx) => {
    await pageFor(tx, actor, pageId, 'viewer');
    const threads = await tx
      .select()
      .from(commentThreads)
      .where(and(eq(commentThreads.tenantId, actor.tenantId), eq(commentThreads.documentId, pageId), isNull(commentThreads.deletedAt)))
      .orderBy(asc(commentThreads.createdAt), asc(commentThreads.id));
    return toThreads(tx, actor.tenantId, threads);
  });
}

/** POST /api/v1/pages/:id/threads: a thread with its first comment. */
export async function createThread(actor: Actor, pageId: string, input: unknown): Promise<CommentThread> {
  requireUser(actor);
  const req = CreateThreadRequestSchema.parse(input);
  const text = commentText(req.body);
  return withTenantTx(actor.tenantId, async (tx) => {
    const { doc } = await pageFor(tx, actor, pageId, 'editor');
    const [thread] = await tx
      .insert(commentThreads)
      .values({ tenantId: actor.tenantId, documentId: doc.id, blockId: req.block_id, quote: req.quote, createdBy: actor.principalId })
      .returning();
    const [comment] = await tx
      .insert(comments)
      .values({ tenantId: actor.tenantId, threadId: thread!.id, authorId: actor.principalId, body: req.body })
      .returning();
    await tellAboutComment(tx, actor, doc, thread!, comment!, text, false);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'comment.created',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'comment',
      subjectId: comment!.id,
      payload: { documentId: doc.id, threadId: thread!.id },
    });
    return oneThread(tx, actor.tenantId, thread!.id);
  });
}

/** POST /api/v1/threads/:id/comments: a reply. */
export async function addComment(actor: Actor, threadId: string, input: unknown): Promise<CommentThread> {
  requireUser(actor);
  const req = CommentRequestSchema.parse(input);
  const text = commentText(req.body);
  return withTenantTx(actor.tenantId, async (tx) => {
    const { thread, doc } = await threadFor(tx, actor, threadId, 'editor');
    const [comment] = await tx
      .insert(comments)
      .values({ tenantId: actor.tenantId, threadId: thread.id, authorId: actor.principalId, body: req.body })
      .returning();
    await tx.update(commentThreads).set({ updatedAt: new Date() }).where(eq(commentThreads.id, thread.id));
    await tellAboutComment(tx, actor, doc, thread, comment!, text, true);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'comment.created',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'comment',
      subjectId: comment!.id,
      payload: { documentId: doc.id, threadId: thread.id },
    });
    return oneThread(tx, actor.tenantId, thread.id);
  });
}

/** PATCH /api/v1/comments/:id: its author rewrites it. */
export async function updateComment(actor: Actor, commentId: string, input: unknown): Promise<CommentThread> {
  requireUser(actor);
  const req = CommentRequestSchema.parse(input);
  const text = commentText(req.body);
  return withTenantTx(actor.tenantId, async (tx) => {
    const { comment, thread, doc } = await commentFor(tx, actor, commentId);
    if (comment.authorId !== actor.principalId) throw new AppError('forbidden');
    const [updated] = await tx
      .update(comments)
      .set({ body: req.body, updatedAt: new Date() })
      .where(eq(comments.id, comment.id))
      .returning();
    await tellAboutComment(tx, actor, doc, thread, updated!, text, false);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'comment.updated',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'comment',
      subjectId: comment.id,
      payload: { documentId: doc.id, threadId: thread.id },
    });
    return oneThread(tx, actor.tenantId, thread.id);
  });
}

/** Whether `actor` may remove what someone else wrote here: a space admin, or a tenant admin. */
function moderates(actor: Actor, role: string | null): boolean {
  return isTenantAdmin(actor) || role === 'admin';
}

/** DELETE /api/v1/comments/:id: its author, or a space admin. The comment keeps its place, emptied. */
export async function deleteComment(actor: Actor, commentId: string): Promise<void> {
  requireUser(actor);
  await withTenantTx(actor.tenantId, async (tx) => {
    const { comment, thread, doc, access } = await commentFor(tx, actor, commentId);
    if (comment.authorId !== actor.principalId && !moderates(actor, access.effectiveRole)) throw new AppError('forbidden');
    await tx.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment.id));
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'comment.deleted',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'comment',
      subjectId: comment.id,
      payload: { documentId: doc.id, threadId: thread.id },
    });
  });
}

/** DELETE /api/v1/threads/:id: whoever started it, or a space admin. */
export async function deleteThread(actor: Actor, threadId: string): Promise<void> {
  requireUser(actor);
  await withTenantTx(actor.tenantId, async (tx) => {
    const { thread, doc, access } = await threadFor(tx, actor, threadId, 'viewer');
    if (thread.createdBy !== actor.principalId && !moderates(actor, access.effectiveRole)) throw new AppError('forbidden');
    await tx.update(commentThreads).set({ deletedAt: new Date() }).where(eq(commentThreads.id, thread.id));
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'thread.deleted',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'thread',
      subjectId: thread.id,
      payload: { documentId: doc.id },
    });
  });
}

/** POST /api/v1/threads/:id/resolve and /unresolve: anyone who may edit the page. */
export async function setThreadResolved(actor: Actor, threadId: string, resolved: boolean): Promise<CommentThread> {
  requireUser(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const { thread, doc } = await threadFor(tx, actor, threadId, 'editor');
    await tx
      .update(commentThreads)
      .set(
        resolved
          ? { resolvedAt: new Date(), resolvedBy: actor.principalId, updatedAt: new Date() }
          : { resolvedAt: null, resolvedBy: null, updatedAt: new Date() }
      )
      .where(eq(commentThreads.id, thread.id));
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: resolved ? 'thread.resolved' : 'thread.reopened',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'thread',
      subjectId: thread.id,
      payload: { documentId: doc.id },
    });
    return oneThread(tx, actor.tenantId, thread.id);
  });
}

/** GET /api/v1/mentionable: the workspace's people by name, and whether each can read the page. */
export async function listMentionable(actor: Actor, query: unknown): Promise<Mentionable[]> {
  const { page_id, q, limit } = MentionableQuerySchema.parse(query);
  return withTenantTx(actor.tenantId, async (tx) => {
    const { doc } = await pageFor(tx, actor, page_id, 'viewer');
    const term = q.trim().toLowerCase();
    const people = (
      await tx
        .select({ id: users.id, name: users.name, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, actor.tenantId))
    )
      .filter((p) => term === '' || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(term)) || p.name.toLowerCase().startsWith(term))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
    const out: Mentionable[] = [];
    for (const p of people) {
      const reader: Actor = { tenantId: actor.tenantId, principalType: 'user', principalId: p.id, tenantRole: p.role };
      out.push({ userId: p.id, name: p.name, canRead: await canOpen(tx, reader, doc) });
    }
    return out;
  });
}
