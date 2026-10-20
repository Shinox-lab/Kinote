import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, spaces } from './foundations.js';

/**
 * A system that feeds files into a space (only `upload_api` so far). A source
 * is paused, never deleted: audit rows and documents keep pointing at it.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: ['upload_api'] }).notNull(),
    name: text('name').notNull(),
    targetSpaceId: uuid('target_space_id')
      .notNull()
      .references(() => spaces.id),
    trusted: boolean('trusted').notNull().default(false),
    status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sources_tenant_name_idx').on(t.tenantId, sql`lower(${t.name})`)]
);

export type SourceRow = typeof sources.$inferSelect;

/**
 * One row per external id a source has sent: the document it became, the bytes
 * it last sent (what "unchanged" compares against) and when it was removed.
 * `document_id` is a plain uuid (no foreign key, as `documents.source_id` is the
 * only direction that needs one) so this table never blocks a document change.
 */
export const sourceItems = pgTable(
  'source_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    externalId: text('external_id').notNull(),
    documentId: uuid('document_id').notNull(),
    contentHash: text('content_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sourceId, t.externalId] }),
    uniqueIndex('source_items_document_idx').on(t.documentId),
  ]
);

/** A bearer token for exactly one source. Only the hash is stored; the secret is shown once. */
export const sourceTokens = pgTable('source_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
