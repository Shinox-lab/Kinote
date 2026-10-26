import { pgTable, uuid, text, timestamp, jsonb, integer, real, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants, spaces } from './foundations.js';
import { documents, versions, chunks, halfvec } from './pages_and_index.js';

/**
 * Anything a person (or, after the MCP rework, an agent) sends to be filed
 * into the wiki. Never indexed: what it adds is cited back to it instead.
 */
export const captures = pgTable(
  'captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    senderType: text('sender_type', { enum: ['user', 'agent'] }).notNull(),
    senderId: uuid('sender_id').notNull(),
    channel: text('channel', { enum: ['console', 'mcp'] }).notNull(),
    text: text('text').notNull(),
    sourceRef: text('source_ref'),
    scopeSpaceId: uuid('scope_space_id').references(() => spaces.id, { onDelete: 'set null' }),
    scopePageId: uuid('scope_page_id').references(() => documents.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['queued', 'routing', 'waiting_for_answer', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('captures_sender_idx').on(t.tenantId, t.senderType, t.senderId, t.createdAt)]
);

/** The thread under a capture: the engine's questions and the sender's answers. */
export const captureMessages = pgTable(
  'capture_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    author: text('author', { enum: ['engine', 'sender'] }).notNull(),
    body: text('body').notNull(),
    /** The choices an engine question offers: `[{ entityId, label }]`. */
    options: jsonb('options'),
    /** On a sender's answer: the question it answers and the option chosen. */
    answersMessageId: uuid('answers_message_id'),
    choice: text('choice'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('capture_messages_capture_idx').on(t.tenantId, t.captureId, t.createdAt)]
);

export const FACT_OUTCOMES = [
  'pending',
  'applied',
  'waiting_review',
  'suggested',
  'needs_home',
  'already_known',
  'dismissed',
  'undone',
] as const;

/** One statement a capture was split into, and what became of it. */
export const captureFacts = pgTable(
  'capture_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    statement: text('statement').notNull(),
    kind: text('kind', { enum: ['new', 'change', 'removal'] }).notNull(),
    names: text('names').array().notNull().default([]),
    date: text('date'),
    outcome: text('outcome', { enum: FACT_OUTCOMES }).notNull().default('pending'),
    confidence: real('confidence'),
    reason: text('reason'),
    /** The engine question this fact waits on, while it waits. */
    waitingQuestionId: uuid('waiting_question_id').references(() => captureMessages.id, { onDelete: 'set null' }),
    /** Entity ids the sender picked in answers, pinned for the next run. */
    pinnedEntityIds: uuid('pinned_entity_ids').array().notNull().default([]),
    placedBy: uuid('placed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('capture_facts_ordinal_idx').on(t.tenantId, t.captureId, t.ordinal),
    index('capture_facts_outcome_idx').on(t.tenantId, t.outcome),
  ]
);

/** One block the engine inserted or replaced, with what it said before and after. */
export const captureChanges = pgTable(
  'capture_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    captureId: uuid('capture_id')
      .notNull()
      .references(() => captures.id, { onDelete: 'cascade' }),
    factId: uuid('fact_id')
      .notNull()
      .references(() => captureFacts.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    blockId: text('block_id').notNull(),
    op: text('op', { enum: ['insert', 'replace', 'create_page'] }).notNull(),
    /** Null for an insert: there was nothing before. */
    beforeMarkdown: text('before_markdown'),
    afterMarkdown: text('after_markdown').notNull(),
    /** The snapshot the change landed in. */
    versionId: uuid('version_id').references(() => versions.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['applied', 'undone', 'moved'] }).notNull().default('applied'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('capture_changes_capture_idx').on(t.tenantId, t.captureId),
    index('capture_changes_document_idx').on(t.tenantId, t.documentId),
  ]
);

/** A change the engine was not allowed to apply, waiting for a person. */
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    /** The block a remove or replace addresses; null for an insert. */
    blockId: text('block_id'),
    /** Where an insert goes; null inserts at the start. */
    afterBlockId: text('after_block_id'),
    kind: text('kind', { enum: ['remove', 'replace', 'insert'] }).notNull(),
    proposedMarkdown: text('proposed_markdown'),
    proposedBlocks: jsonb('proposed_blocks'),
    reason: text('reason').notNull(),
    blockedBy: text('blocked_by', { enum: ['removal', 'protection', 'conflict', 'no_edit_access'] }).notNull(),
    conflictCitationId: uuid('conflict_citation_id'),
    captureId: uuid('capture_id').references(() => captures.id, { onDelete: 'cascade' }),
    factId: uuid('fact_id').references(() => captureFacts.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['open', 'accepted', 'declined', 'stale'] }).notNull().default('open'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('suggestions_document_idx').on(t.tenantId, t.documentId, t.status)]
);

/**
 * Where a block's content came from: a source version (a file or page) or a
 * capture. Only capture citations are written so far (R15).
 */
export const citations = pgTable(
  'citations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    pageId: uuid('page_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    sourceKind: text('source_kind', { enum: ['version', 'capture'] }).notNull(),
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, { onDelete: 'set null' }),
    sourceVersionId: uuid('source_version_id').references(() => versions.id, { onDelete: 'set null' }),
    chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'set null' }),
    captureId: uuid('capture_id').references(() => captures.id, { onDelete: 'set null' }),
    factId: uuid('fact_id').references(() => captureFacts.id, { onDelete: 'set null' }),
    quote: text('quote').notNull(),
    state: text('state', { enum: ['ok', 'source_changed', 'source_removed'] }).notNull().default('ok'),
    createdByType: text('created_by_type', { enum: ['user', 'agent'] }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('citations_block_idx').on(t.tenantId, t.pageId, t.blockId)]
);

/** A person's correction of where a fact belongs; the planner sees similar ones (R11). */
export const routingExamples = pgTable(
  'routing_examples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id),
    statement: text('statement').notNull(),
    statementEmbedding: halfvec(2560)('statement_embedding').notNull(),
    chosenDocumentId: uuid('chosen_document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    wrongDocumentId: uuid('wrong_document_id').references(() => documents.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('routing_examples_space_idx').on(t.tenantId, t.spaceId),
    index('routing_examples_embedding_hnsw_idx').using('hnsw', t.statementEmbedding.op('halfvec_cosine_ops')),
  ]
);

/** Who is routing for a tenant right now: one capture at a time (R13). */
export const routingLeases = pgTable('routing_leases', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  holder: text('holder').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
