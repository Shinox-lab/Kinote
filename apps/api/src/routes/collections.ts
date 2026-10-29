import * as Y from 'yjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  collectionFields,
  collections,
  documents,
  pageFieldValues,
  pages,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import {
  AppError,
  CreateFieldRequestSchema,
  FIELDS_MAP,
  MAX_FIELDS,
  SetFieldsRequestSchema,
  UpdateFieldRequestSchema,
  fieldValueFits,
  validFields,
  type Collection,
  type FieldDef,
  type FieldOptions,
  type FieldType,
} from '@living-wiki/contracts';
import {
  assertValidUuid,
  collectionFieldDefs,
  enqueueReindex,
  fieldDefOf,
  indexedChildPages,
  isCollection,
  requireDocumentRole,
  rowCollectionOf,
  type Actor,
} from '@living-wiki/core';
import type { CollabClient } from '@living-wiki/shared';

/**
 * Collections (spec C1, C2, C11): a page whose direct sub-pages share typed
 * fields. Turning a page into one, and its fields, are structural changes
 * like a rename: applied at once and audited. Values are page content and go
 * through collab (`PATCH /pages/:id/fields`).
 */

async function livePage(tx: DbTransaction, actor: Actor, pageId: string, role: 'viewer' | 'editor') {
  assertValidUuid(pageId, 'page_not_found');
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
  if (!doc || doc.kind !== 'page') throw new AppError('page_not_found');
  const access = await requireDocumentRole(tx, actor, doc, role, { notFound: 'page_not_found' });
  if (role === 'editor' && doc.archivedAt) throw new AppError('page_archived');
  return { doc, access };
}

/** The collection page, checked for `role`; a page that isn't a (live) collection is `collection_not_found`. */
async function collectionPage(tx: DbTransaction, actor: Actor, collectionId: string, role: 'viewer' | 'editor') {
  assertValidUuid(collectionId, 'collection_not_found');
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, collectionId)));
  if (!doc || doc.kind !== 'page' || !(await isCollection(tx, actor.tenantId, collectionId))) {
    throw new AppError('collection_not_found');
  }
  await requireDocumentRole(tx, actor, doc, role, { notFound: 'collection_not_found' });
  return doc;
}

async function collectionOf(tx: DbTransaction, tenantId: string, doc: DocumentRow): Promise<Collection> {
  return { id: doc.id, title: doc.title, fields: await collectionFieldDefs(tx, tenantId, doc.id) };
}

/** A collection for page details: the page itself (when it is one) and the one it is a row of. */
export async function pageCollectionInfo(tx: DbTransaction, tenantId: string, doc: DocumentRow) {
  const collection = (await isCollection(tx, tenantId, doc.id)) ? await collectionOf(tx, tenantId, doc) : null;
  const row = await rowCollectionOf(tx, tenantId, doc.id);
  let rowOf: Collection | null = null;
  if (row) {
    const [parent] = await tx
      .select({ title: documents.title })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, row.collectionId)));
    rowOf = { id: row.collectionId, title: parent?.title ?? '', fields: row.fields };
  }
  return { collection, rowOf };
}

const audit = (tx: DbTransaction, actor: Actor, type: Parameters<typeof writeAuditEvent>[1]['type'], collectionId: string, payload: Record<string, unknown> = {}) =>
  writeAuditEvent(tx, {
    tenantId: actor.tenantId,
    type,
    actorType: actor.principalType,
    actorId: actor.principalId,
    subjectType: 'page',
    subjectId: collectionId,
    payload,
  });

/** POST /api/v1/pages/:id/collection: an editor turns a page into a collection (never in the Inbox). */
export async function createCollection(actor: Actor, pageId: string): Promise<Collection> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { doc, access } = await livePage(tx, actor, pageId, 'editor');
    if (access.space.kind === 'inbox') throw new AppError('collection_in_inbox');
    if (await isCollection(tx, actor.tenantId, pageId)) throw new AppError('collection_exists');
    await tx.insert(collections).values({ tenantId: actor.tenantId, documentId: pageId, createdBy: actor.principalId });
    await audit(tx, actor, 'collection.created', pageId);
    return collectionOf(tx, actor.tenantId, doc);
  });
}

/** DELETE /api/v1/pages/:id/collection: back to a plain page. Rows keep their values (hidden) and are re-indexed. */
export async function removeCollection(actor: Actor, pageId: string): Promise<void> {
  await withTenantTx(actor.tenantId, async (tx) => {
    await livePage(tx, actor, pageId, 'editor');
    const removed = await tx
      .delete(collections)
      .where(and(eq(collections.tenantId, actor.tenantId), eq(collections.documentId, pageId)))
      .returning();
    if (removed.length === 0) throw new AppError('collection_not_found');
    await enqueueReindex(tx, actor.tenantId, await indexedChildPages(tx, actor.tenantId, pageId));
    await audit(tx, actor, 'collection.removed', pageId);
  });
}

/** GET /api/v1/collections/:id */
export async function getCollection(actor: Actor, collectionId: string): Promise<Collection> {
  return withTenantTx(actor.tenantId, async (tx) => collectionOf(tx, actor.tenantId, await collectionPage(tx, actor, collectionId, 'viewer')));
}

/** Options a field of `type` may have: choices for select fields, a number format for numbers, nothing else. */
function checkOptions(type: FieldType, options: FieldOptions | undefined): FieldOptions {
  const o = options ?? {};
  const choiceType = type === 'select' || type === 'multi_select';
  if (!choiceType && o.choices !== undefined) throw new AppError('validation_failed', 'Only choice fields have choices.');
  if (type !== 'number' && (o.format !== undefined || o.code !== undefined)) {
    throw new AppError('validation_failed', 'Only number fields have a format.');
  }
  if (o.choices) {
    const ids = new Set(o.choices.map((c) => c.id));
    const names = new Set(o.choices.map((c) => c.name.toLowerCase()));
    if (ids.size !== o.choices.length || names.size !== o.choices.length) {
      throw new AppError('validation_failed', 'Each choice needs its own id and name.');
    }
  }
  if (o.code !== undefined && o.format !== 'currency') throw new AppError('validation_failed', 'A currency code needs the currency format.');
  return choiceType ? { choices: o.choices ?? [] } : o;
}

async function nameTaken(tx: DbTransaction, tenantId: string, collectionId: string, name: string, except?: string) {
  const rows = await tx
    .select({ id: collectionFields.id })
    .from(collectionFields)
    .where(
      and(
        eq(collectionFields.tenantId, tenantId),
        eq(collectionFields.collectionId, collectionId),
        sql`lower(${collectionFields.name}) = lower(${name})`
      )
    );
  return rows.some((r) => r.id !== except);
}

const positionAt = (i: number) => `p${String(i).padStart(4, '0')}`;

/** POST /api/v1/collections/:id/fields */
export async function addField(actor: Actor, collectionId: string, input: unknown): Promise<FieldDef> {
  const body = CreateFieldRequestSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    await collectionPage(tx, actor, collectionId, 'editor');
    // Lock the collection's fields so concurrent adds count and number them in turn.
    await tx.select().from(collections).where(and(eq(collections.tenantId, actor.tenantId), eq(collections.documentId, collectionId))).for('update');
    const existing = await collectionFieldDefs(tx, actor.tenantId, collectionId);
    if (existing.length >= MAX_FIELDS) throw new AppError('field_limit');
    if (await nameTaken(tx, actor.tenantId, collectionId, body.name)) throw new AppError('field_name_taken');
    const last = existing.at(-1);
    const next = last ? Number.parseInt(last.position.slice(1), 10) + 1 : 0;
    const [row] = await tx
      .insert(collectionFields)
      .values({
        tenantId: actor.tenantId,
        collectionId,
        name: body.name,
        type: body.type,
        options: checkOptions(body.type, body.options),
        position: positionAt(Number.isFinite(next) ? next : existing.length),
      })
      .returning();
    await audit(tx, actor, 'collection.field_added', collectionId, { fieldId: row!.id, name: row!.name, type: row!.type });
    return fieldDefOf(row!);
  });
}

async function fieldRow(tx: DbTransaction, tenantId: string, collectionId: string, fieldId: string) {
  assertValidUuid(fieldId, 'field_not_found');
  const [row] = await tx
    .select()
    .from(collectionFields)
    .where(and(eq(collectionFields.tenantId, tenantId), eq(collectionFields.collectionId, collectionId), eq(collectionFields.id, fieldId)));
  if (!row) throw new AppError('field_not_found');
  return row;
}

/** PATCH /api/v1/collections/:id/fields/:fieldId: rename, change options (never the type), or move after another field. */
export async function updateField(actor: Actor, collectionId: string, fieldId: string, input: unknown): Promise<FieldDef> {
  const body = UpdateFieldRequestSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    await collectionPage(tx, actor, collectionId, 'editor');
    const row = await fieldRow(tx, actor.tenantId, collectionId, fieldId);
    const def = fieldDefOf(row);
    const changes: Partial<typeof collectionFields.$inferInsert> = {};
    if (body.name !== undefined && body.name !== row.name) {
      if (await nameTaken(tx, actor.tenantId, collectionId, body.name, fieldId)) throw new AppError('field_name_taken');
      changes.name = body.name;
    }
    let choicesRemoved = false;
    if (body.options !== undefined) {
      const options = checkOptions(def.type, body.options);
      const kept = new Set((options.choices ?? []).map((c) => c.id));
      choicesRemoved = (def.options.choices ?? []).some((c) => !kept.has(c.id));
      changes.options = options;
    }
    if (Object.keys(changes).length > 0) {
      await tx.update(collectionFields).set(changes).where(and(eq(collectionFields.tenantId, actor.tenantId), eq(collectionFields.id, fieldId)));
    }
    if (body.after !== undefined) {
      const order = (await collectionFieldDefs(tx, actor.tenantId, collectionId)).filter((f) => f.id !== fieldId);
      const at = body.after === null ? 0 : order.findIndex((f) => f.id === body.after) + 1;
      if (body.after !== null && at === 0) throw new AppError('field_not_found');
      order.splice(at, 0, def);
      for (const [i, f] of order.entries()) {
        await tx
          .update(collectionFields)
          .set({ position: positionAt(i) })
          .where(and(eq(collectionFields.tenantId, actor.tenantId), eq(collectionFields.id, f.id)));
      }
    }
    // A removed choice leaves the rows (their values are ignored now): their index drops it.
    if (choicesRemoved) await enqueueReindex(tx, actor.tenantId, await indexedChildPages(tx, actor.tenantId, collectionId));
    await audit(tx, actor, 'collection.field_changed', collectionId, { fieldId, ...body });
    return fieldDefOf(await fieldRow(tx, actor.tenantId, collectionId, fieldId));
  });
}

/** DELETE /api/v1/collections/:id/fields/:fieldId: values stay in the rows, ignored; rows are re-indexed. */
export async function removeField(actor: Actor, collectionId: string, fieldId: string): Promise<void> {
  await withTenantTx(actor.tenantId, async (tx) => {
    await collectionPage(tx, actor, collectionId, 'editor');
    const row = await fieldRow(tx, actor.tenantId, collectionId, fieldId);
    await tx.delete(collectionFields).where(and(eq(collectionFields.tenantId, actor.tenantId), eq(collectionFields.id, fieldId)));
    await enqueueReindex(tx, actor.tenantId, await indexedChildPages(tx, actor.tenantId, collectionId));
    await audit(tx, actor, 'collection.field_removed', collectionId, { fieldId, name: row.name });
  });
}

/**
 * GET /api/v1/collections/:id/fields/:fieldId/usage[?choice=<id>]: how many
 * rows have a value (that fits) for the field, or that choice: the count the
 * removal confirmation names.
 */
export async function fieldUsage(actor: Actor, collectionId: string, fieldId: string, query: unknown): Promise<{ pages: number }> {
  const choice = typeof (query as { choice?: unknown })?.choice === 'string' ? (query as { choice: string }).choice : undefined;
  return withTenantTx(actor.tenantId, async (tx) => {
    await collectionPage(tx, actor, collectionId, 'viewer');
    const def = fieldDefOf(await fieldRow(tx, actor.tenantId, collectionId, fieldId));
    const rows = await tx
      .select({ value: pageFieldValues.value })
      .from(pageFieldValues)
      .innerJoin(documents, and(eq(documents.tenantId, pageFieldValues.tenantId), eq(documents.id, pageFieldValues.pageId)))
      .where(
        and(
          eq(pageFieldValues.tenantId, actor.tenantId),
          eq(pageFieldValues.fieldId, fieldId),
          eq(documents.parentId, collectionId),
          eq(documents.kind, 'page'),
          isNull(documents.archivedAt)
        )
      );
    const used = rows.filter(({ value }) => {
      if (!fieldValueFits(def, value)) return false;
      if (choice === undefined) return true;
      return Array.isArray(value) ? value.includes(choice) : value === choice;
    });
    return { pages: used.length };
  });
}

/**
 * PATCH /api/v1/pages/:id/fields: an editor sets (or, with null, clears) values
 * of a row. Each value must fit its field. The change goes through collab, so
 * it is attributed, reviewed and snapshotted like any edit of the page.
 * Returns the row's values that fit, after the change.
 */
export async function setPageFields(actor: Actor, pageId: string, input: unknown, collab?: CollabClient) {
  const body = SetFieldsRequestSchema.parse(input);
  if (!collab) throw new AppError('internal_error');
  await withTenantTx(actor.tenantId, async (tx) => {
    await livePage(tx, actor, pageId, 'editor');
    const row = await rowCollectionOf(tx, actor.tenantId, pageId);
    if (!row) throw new AppError('collection_not_found');
    for (const [fieldId, value] of Object.entries(body)) {
      const def = row.fields.find((f) => f.id === fieldId);
      if (!def) throw new AppError('field_not_found');
      if (value !== null && !fieldValueFits(def, value)) throw new AppError('field_invalid_value');
    }
  });
  if (Object.keys(body).length > 0) {
    await collab.setFields({
      tenantId: actor.tenantId,
      pageId,
      values: body,
      actor: { type: actor.principalType === 'agent' ? 'agent' : 'user', id: actor.principalId },
      source: actor.principalType === 'agent' ? 'agent' : 'human',
    });
  }
  return withTenantTx(actor.tenantId, async (tx) => {
    const [page] = await tx
      .select({ ydocState: pages.ydocState })
      .from(pages)
      .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));
    const doc = new Y.Doc();
    if (page) Y.applyUpdate(doc, new Uint8Array(page.ydocState));
    const row = await rowCollectionOf(tx, actor.tenantId, pageId);
    return { fields: row ? validFields(row.fields, doc.getMap(FIELDS_MAP).toJSON()) : {} };
  });
}
