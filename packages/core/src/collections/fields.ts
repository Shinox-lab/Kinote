import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { collectionFields, collections, documents, memberships, users, type DbTransaction } from '@living-wiki/db';
import { FieldOptionsSchema, fieldEntries, type FieldDef, type FieldNames } from '@living-wiki/contracts';

type FieldRow = typeof collectionFields.$inferSelect;

/** A stored field as its contract shape; options that no longer parse read as none. */
export function fieldDefOf(row: FieldRow): FieldDef {
  const options = FieldOptionsSchema.safeParse(row.options);
  return { id: row.id, name: row.name, type: row.type, options: options.success ? options.data : {}, position: row.position };
}

/** A collection's fields, in their order. */
export async function collectionFieldDefs(tx: DbTransaction, tenantId: string, collectionId: string): Promise<FieldDef[]> {
  const rows = await tx
    .select()
    .from(collectionFields)
    .where(and(eq(collectionFields.tenantId, tenantId), eq(collectionFields.collectionId, collectionId)))
    .orderBy(asc(collectionFields.position), asc(collectionFields.createdAt));
  return rows.map(fieldDefOf);
}

/** Whether the document is a collection (an unarchived page marked as one). */
export async function isCollection(tx: DbTransaction, tenantId: string, documentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: collections.documentId })
    .from(collections)
    .innerJoin(documents, and(eq(documents.tenantId, collections.tenantId), eq(documents.id, collections.documentId)))
    .where(and(eq(collections.tenantId, tenantId), eq(collections.documentId, documentId), isNull(documents.archivedAt)));
  return row !== undefined;
}

/**
 * The collection a page is a row of: a page whose parent is a live
 * collection. Files, grandchildren and pages under an archived collection
 * are not rows.
 */
export async function rowCollectionOf(
  tx: DbTransaction,
  tenantId: string,
  pageId: string
): Promise<{ collectionId: string; fields: FieldDef[] } | null> {
  const [doc] = await tx
    .select({ kind: documents.kind, parentId: documents.parentId })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));
  if (!doc || doc.kind !== 'page' || !doc.parentId) return null;
  if (!(await isCollection(tx, tenantId, doc.parentId))) return null;
  return { collectionId: doc.parentId, fields: await collectionFieldDefs(tx, tenantId, doc.parentId) };
}

/**
 * Names for the person and page values in `raw`: members of the tenant by
 * user id, live pages by id. Anyone or anything else is left out, so it
 * prints as nothing.
 */
export async function fieldNames(
  tx: DbTransaction,
  tenantId: string,
  defs: FieldDef[],
  raw: Record<string, unknown>
): Promise<FieldNames> {
  const ids = (type: FieldDef['type']) =>
    [
      ...new Set(
        defs
          .filter((d) => d.type === type)
          .flatMap((d) => (Array.isArray(raw[d.id]) ? (raw[d.id] as unknown[]) : []))
          .filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v))
      ),
    ];
  const userIds = ids('person');
  const pageIds = ids('page');
  const people =
    userIds.length === 0
      ? []
      : await tx
          .select({ id: users.id, name: users.name })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(eq(memberships.tenantId, tenantId), inArray(memberships.userId, userIds)));
  const titles =
    pageIds.length === 0
      ? []
      : await tx
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, pageIds), isNull(documents.archivedAt)));
  return {
    users: new Map(people.map((p) => [p.id, p.name])),
    pages: new Map(titles.map((p) => [p.id, p.title])),
  };
}

/**
 * The `Field: value` lines of a page's field values (a version's `fields`, or
 * the live map), with the field each is for: nothing when the page isn't a
 * row now. Read against the collection's current fields, so a removed field
 * or choice is left out.
 */
export async function pageFieldEntries(
  tx: DbTransaction,
  tenantId: string,
  documentId: string,
  fields: unknown
): Promise<Array<{ fieldId: string; text: string }>> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) return [];
  const row = await rowCollectionOf(tx, tenantId, documentId);
  if (!row) return [];
  const raw = fields as Record<string, unknown>;
  return fieldEntries(row.fields, raw, await fieldNames(tx, tenantId, row.fields, raw));
}
