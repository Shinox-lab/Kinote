import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  numeric,
  date,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './foundations.js';

// Plans, usage and quotas (docs/superpowers/specs/2026-11-03-plans-usage-quotas-design.md).
// Every table is tenant-scoped with RLS. Credits are stored as integer millicredits.

/** A workspace's limits, set by the control plane. No row = unlimited. Null column = that limit is unlimited. */
export const tenantLimits = pgTable('tenant_limits', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  seats: integer('seats'),
  storageBytes: bigint('storage_bytes', { mode: 'number' }),
  creditsPerMonth: integer('credits_per_month'),
  indexCreditsPerMonth: integer('index_credits_per_month'),
  gracePercent: integer('grace_percent').notNull().default(10),
  periodAnchorDay: integer('period_anchor_day').notNull().default(1),
  /** The workspace's answer model; null = the deployment's (model_settings, else ASK_MODEL). */
  askModel: text('ask_model'),
  /** Charges are multiplied by this, 0–10. */
  creditMultiplier: numeric('credit_multiplier', { precision: 6, scale: 3, mode: 'number' }).notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull().default('control_plane'),
});

/** Limits for new workspaces, pushed by the control plane. At most one row (id true); no row = no defaults. */
export const tenantDefaults = pgTable('tenant_defaults', {
  id: boolean('id').primaryKey().default(true),
  plan: text('plan').notNull(),
  seats: integer('seats'),
  storageBytes: bigint('storage_bytes', { mode: 'number' }),
  creditsPerMonth: integer('credits_per_month'),
  indexCreditsPerMonth: integer('index_credits_per_month'),
  gracePercent: integer('grace_percent').notNull().default(10),
  maxFreePerOwner: integer('max_free_per_owner'),
  askModel: text('ask_model'),
  creditMultiplier: numeric('credit_multiplier', { precision: 6, scale: 3, mode: 'number' }).notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The deployment's models and rate table, set by the control plane. At most one row (id true); no row or a
 * null column = the env value (ASK_MODEL, ROUTER_MODEL, EMBEDDING_MODEL, MODEL_CREDIT_RATES).
 */
export const modelSettings = pgTable('model_settings', {
  id: boolean('id').primaryKey().default(true),
  askModel: text('ask_model'),
  routerModel: text('router_model'),
  embeddingModel: text('embedding_model'),
  creditRates: jsonb('credit_rates').$type<{ default: { input: number; output: number }; models: Record<string, { input: number; output: number }> }>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const USAGE_KINDS = ['capture', 'ask', 'index'] as const;

/** The ledger: one row per model call. Append-only. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    period: date('period').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', { enum: USAGE_KINDS }).notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    estimated: boolean('estimated').notNull().default(false),
    millicredits: bigint('millicredits', { mode: 'number' }).notNull(),
    principalId: uuid('principal_id'),
    documentId: uuid('document_id'),
  },
  (t) => [index('usage_events_tenant_at_idx').on(t.tenantId, t.at)]
);

/** Running totals per workspace per period (`period` = the period's start date). */
export const tenantUsage = pgTable(
  'tenant_usage',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    period: date('period').notNull(),
    creditsUsedMilli: bigint('credits_used_milli', { mode: 'number' }).notNull().default(0),
    indexCreditsUsedMilli: bigint('index_credits_used_milli', { mode: 'number' }).notNull().default(0),
    creditsTopup: integer('credits_topup').notNull().default(0),
    warned80At: timestamp('warned_80_at', { withTimezone: true }),
    warned100At: timestamp('warned_100_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.period] })]
);

/** Top-ups added to one period's Capture and Ask pool. Idempotent by key per tenant. */
export const creditTopups = pgTable(
  'credit_topups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    period: date('period').notNull(),
    credits: integer('credits').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credit_topups_tenant_key_idx').on(t.tenantId, t.idempotencyKey)]
);

/** Stored file bytes per workspace, kept by the `versions_storage_count` trigger. */
export const tenantStorage = pgTable('tenant_storage', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
});
