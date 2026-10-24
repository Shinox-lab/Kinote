import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  timestamp,
  jsonb,
  customType,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants, spaces } from './foundations.js';
import { sources } from './sources.js';

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Wire format of pgvector `halfvec` values: the text literal `[a,b,...]`.
 * Exported so the codec can be unit tested without building a table.
 */
export const halfvecCodec = {
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  /** node-postgres and PGlite both return the text form; also accept a parsed array. */
  fromDriver(value: string | number[]): number[] {
    if (Array.isArray(value)) return value;
    const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => Number(part.trim()));
  },
};

export const halfvec = (dimensions: number) =>
  customType<{ data: number[]; driverData: string | number[] }>({
    dataType() {
      return `halfvec(${dimensions})`;
    },
    toDriver: halfvecCodec.toDriver,
    fromDriver: halfvecCodec.fromDriver,
  });

// Full-text search vector. Only ever populated by the generated column below.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id),
  parentId: uuid('parent_id'),
  position: text('position').notNull().default('a0'),
  kind: text('kind', { enum: ['page', 'file'] }).notNull(),
  title: text('title').notNull(),
  icon: text('icon'),
  sourceId: uuid('source_id').references(() => sources.id),
  externalId: text('external_id'),
  placement: text('placement', { enum: ['pinned', 'synced'] }).notNull().default('pinned'),
  latestVersionId: uuid('latest_version_id'),
  indexedVersionId: uuid('indexed_version_id'),
  sourceDeletedAt: timestamp('source_deleted_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdByType: text('created_by_type', { enum: ['user', 'agent', 'connector'] }).notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pages = pgTable(
  'pages',
  {
    documentId: uuid('document_id')
      .primaryKey()
      .references(() => documents.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    slug: text('slug').notNull(),
    /**
     * Who the slug is unique for inside the space: '' in a normal space (one
     * slug per space), the creator key "{createdByType}:{createdBy}" in the
     * Inbox, so members' private items never collide (a collision would
     * reveal another member's item). See `pageSlugScope` in @living-wiki/core.
     */
    slugScope: text('slug_scope').notNull().default(''),
    ydocState: bytea('ydoc_state').notNull(),
    liveUpdatedAt: timestamp('live_updated_at', { withTimezone: true }).notNull().defaultNow(),
    liveChangedSinceSnapshot: boolean('live_changed_since_snapshot').notNull().default(false),
    agentChangedAt: timestamp('agent_changed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('pages_space_slug_idx').on(t.tenantId, t.spaceId, t.slugScope, t.slug)]
);

export const versions = pgTable(
  'versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    status: text('status', {
      enum: [
        'extracting',
        'pending_review',
        'indexing',
        'indexed',
        'superseded',
        'rejected',
        'withdrawn',
        'failed',
        'stored',
      ],
    }).notNull(),
    contentHash: text('content_hash').notNull(),
    reason: text('reason', {
      enum: ['quiet', 'submit', 'agent', 'restore', 'upload', 'source', 'transcript'],
    }).notNull(),
    createdByType: text('created_by_type', { enum: ['user', 'agent', 'connector'] }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    error: text('error'),
    markdown: text('markdown'),
    blocks: jsonb('blocks'),
    ydocSnapshot: bytea('ydoc_snapshot'),
    // File versions only (page versions leave these null).
    objectKey: text('object_key'),
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sourceRevision: text('source_revision'),
    extractedKey: text('extracted_key'),
  },
  (t) => [
    uniqueIndex('versions_doc_number_idx').on(t.tenantId, t.documentId, t.number),
    index('versions_tenant_hash_idx').on(t.tenantId, t.contentHash),
  ]
);

export const versionContributors = pgTable(
  'version_contributors',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'agent'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
  },
  (t) => [
    uniqueIndex('version_contributors_unique_idx').on(
      t.tenantId,
      t.versionId,
      t.principalType,
      t.principalId
    ),
  ]
);

export const blockActivity = pgTable(
  'block_activity',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    pageId: uuid('page_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
    actorId: uuid('actor_id').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('block_activity_page_block_idx').on(t.tenantId, t.pageId, t.blockId)]
);

/**
 * Who changed a page since its last snapshot, one row per principal: written
 * by collab for every attributed live change, read into the next snapshot's
 * `version_contributors` and cleared by it (in the snapshot transaction).
 */
export const pagePendingContributors = pgTable(
  'page_pending_contributors',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    pageId: uuid('page_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'agent'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
  },
  (t) => [
    uniqueIndex('page_pending_contributors_unique_idx').on(
      t.tenantId,
      t.pageId,
      t.principalType,
      t.principalId
    ),
  ]
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    headingPath: text('heading_path').array().notNull(),
    blockIds: text('block_ids').array().notNull(),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: halfvec(1536)('embedding').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    /**
     * `"{createdByType}:{createdBy}"` of the document while its space is the
     * Inbox, else null: the Inbox's per-item visibility, kept on the chunk row so
     * search filters `chunks` alone (and the HNSW index stays usable). Set by
     * indexVersion, recomputed by movePage.
     */
    inboxOwner: text('inbox_owner'),
    tsv:tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple', text)`),
  },
  (t) => [
    index('chunks_tenant_space_idx').on(t.tenantId, t.spaceId),
    index('chunks_tsv_gin_idx').using('gin', t.tsv),
    index('chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('halfvec_cosine_ops')),
  ]
);

export const embeddingCache = pgTable(
  'embedding_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: halfvec(1536)('embedding').notNull(),
  },
  (t) => [uniqueIndex('embedding_cache_lookup_idx').on(t.tenantId, t.model, t.contentHash)]
);

export const links = pgTable('links', {
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  fromPageId: uuid('from_page_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  fromBlockId: text('from_block_id').notNull(),
  toDocumentId: uuid('to_document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['link', 'mention', 'embed'] }).notNull().default('link'),
});
