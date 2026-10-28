import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './foundations.js';
import { documents } from './pages_and_index.js';

/**
 * A page that is a collection: its direct sub-pages are its rows and share
 * its fields. The page itself is unchanged; this row only marks it.
 */
export const collections = pgTable('collections', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => documents.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One typed field of a collection. Structural, like a rename: applied at once, audited, not versioned. */
export const collectionFields = pgTable(
  'collection_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.documentId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', {
      enum: ['text', 'number', 'date', 'select', 'multi_select', 'person', 'checkbox', 'page'],
    }).notNull(),
    /** `{ format?, code?, choices? }` (see FieldOptionsSchema). */
    options: jsonb('options').notNull().default({}),
    position: text('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('collection_fields_name_idx').on(t.tenantId, t.collectionId, sql`lower(${t.name})`)]
);

/**
 * The live field values of every page, as collab last stored them: a raw
 * mirror of each page document's `fields` map (one row per key), read by
 * collection views. Never validated here and never read by Search or Ask,
 * which read indexed versions. `field_id` has no foreign key: values of a
 * removed field stay, ignored, as they do in the document.
 */
export const pageFieldValues = pgTable(
  'page_field_values',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    pageId: uuid('page_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('page_field_values_page_field_idx').on(t.tenantId, t.pageId, t.fieldId),
    index('page_field_values_field_idx').on(t.tenantId, t.fieldId),
  ]
);
