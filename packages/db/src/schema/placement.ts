import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants, spaces, users } from './foundations.js';
import { documents, versions, chunks, halfvec } from './pages_and_index.js';

export const ENTITY_KINDS = ['person', 'team', 'system', 'organisation', 'project', 'place', 'other'] as const;
export const EDGE_TYPES = ['owns', 'uses', 'part_of', 'depends_on', 'member_of', 'related_to'] as const;

/** The form entity names are matched in: trimmed, lower-cased, single spaces, no leading `@`. */
export function normalizeEntityName(name: string): string {
  return name.trim().replace(/^@+/, '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One per indexed page (never a file, never in the Inbox): what the page is
 * for, used to place a new fact where nothing similar is written yet. Derived
 * from the indexed version; follows moves and leaves with a withdrawal.
 */
export const pageCards = pgTable(
  'page_cards',
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
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    outline: text('outline').array().notNull(),
    embedding: halfvec(2560)('embedding').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('page_cards_tenant_space_idx').on(t.tenantId, t.spaceId),
    index('page_cards_embedding_hnsw_idx').using('hnsw', t.embedding.op('halfvec_cosine_ops')),
  ]
);

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: ENTITY_KINDS }).notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    /** Other spellings seen, normalized. */
    aliases: text('aliases').array().notNull().default([]),
    nameEmbedding: halfvec(2560)('name_embedding').notNull(),
    userId: uuid('user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entities_tenant_kind_name_idx').on(t.tenantId, t.kind, t.normalizedName),
    index('entities_name_trgm_idx').using('gin', t.normalizedName.op('gin_trgm_ops')),
  ]
);

/**
 * Where an entity is mentioned. `chunk_id` is set null when the chunk is
 * swapped out by a re-index, so the entities job can still tell which
 * entities the document used to mention; entity rows are never cascaded away
 * (an orphan is deleted explicitly, see the placement derived-index helpers).
 */
export const entityMentions = pgTable(
  'entity_mentions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'set null' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    blockIds: text('block_ids').array().notNull(),
  },
  (t) => [
    index('entity_mentions_entity_idx').on(t.tenantId, t.entityId),
    index('entity_mentions_document_idx').on(t.tenantId, t.documentId),
  ]
);

export const entityEdges = pgTable(
  'entity_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fromEntityId: uuid('from_entity_id')
      .notNull()
      .references(() => entities.id),
    toEntityId: uuid('to_entity_id')
      .notNull()
      .references(() => entities.id),
    type: text('type', { enum: EDGE_TYPES }).notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'set null' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
  },
  (t) => [
    index('entity_edges_from_idx').on(t.tenantId, t.fromEntityId),
    index('entity_edges_to_idx').on(t.tenantId, t.toEntityId),
    index('entity_edges_document_idx').on(t.tenantId, t.documentId),
  ]
);

/** Model output per chunk text, so an unchanged chunk is never extracted twice. */
export const entityExtractionCache = pgTable(
  'entity_extraction_cache',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    result: jsonb('result').notNull(),
  },
  (t) => [uniqueIndex('entity_extraction_cache_lookup_idx').on(t.tenantId, t.model, t.contentHash)]
);
