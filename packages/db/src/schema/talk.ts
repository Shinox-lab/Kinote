import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, users } from './foundations.js';
import { documents } from './pages_and_index.js';
import { captures } from './routing.js';

/**
 * A comment thread on a page. Its place in the text is a comment mark in the
 * page's Yjs document (carrying only the thread id); `block_id` and `quote`
 * keep where it was, for when the mark is gone (the text was removed or rewritten).
 */
export const commentThreads = pgTable(
  'comment_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id'),
    /** The text the thread was started on, up to 200 characters. */
    quote: text('quote'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('comment_threads_document_idx').on(t.tenantId, t.documentId)]
);

/** One comment of a thread. Its body is a BlockNote document (the comment editor's blocks). */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: jsonb('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('comments_thread_idx').on(t.tenantId, t.threadId)]
);

/**
 * Every (person, place) a mention has ever been seen at: a page block or a
 * comment. Rows are only added, so a mention that is removed and put back,
 * or comes back with a restored version, is never notified twice.
 */
export const userMentions = pgTable(
  'user_mentions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** The block of a page mention; '' for a comment mention. */
    blockId: text('block_id').notNull().default(''),
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_mentions_block_idx')
      .on(t.tenantId, t.userId, t.documentId, t.blockId)
      .where(sql`${t.commentId} IS NULL`),
    uniqueIndex('user_mentions_comment_idx')
      .on(t.tenantId, t.userId, t.commentId)
      .where(sql`${t.commentId} IS NOT NULL`),
  ]
);

export const NOTIFICATION_KINDS = [
  'mention',
  'comment_reply',
  'review_requested',
  'review_approved',
  'review_rejected',
  'capture_waiting',
] as const;

/** Something a person should hear about, in the app's bell. Read access is checked when it is listed. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    actorType: text('actor_type', { enum: ['user', 'agent', 'connector'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id'),
    threadId: uuid('thread_id').references(() => commentThreads.id, { onDelete: 'cascade' }),
    /** The comment it is about, so deleting the comment takes the notification (and its excerpt) with it. */
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    captureId: uuid('capture_id').references(() => captures.id, { onDelete: 'cascade' }),
    /** A short plain-text line: the comment or the mentioning sentence. */
    excerpt: text('excerpt'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notifications_recipient_idx').on(t.tenantId, t.recipientId, t.createdAt)]
);
