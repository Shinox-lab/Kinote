import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { chunks, collections, documents, spaces, versions, type DbTransaction } from '@kinote/db';
import { formatFieldValue, validFields, type SearchPassage } from '@kinote/contracts';
import type { Actor } from '../permissions.js';
import { collectionFieldDefs, fieldNames } from '../collections/fields.js';
import { citeAs } from './hybridSearch.js';

/**
 * Most collections one question gets a table of, most rows per table, most
 * characters per cell, and most characters of row text per table (so one
 * collection with long text fields can't overflow the model's context).
 */
export const ASK_TABLES = { collections: 2, rows: 200, cellChars: 200, tableChars: 20_000 } as const;

const cut = (text: string) => (text.length <= ASK_TABLES.cellChars ? text : `${text.slice(0, ASK_TABLES.cellChars - 1)}…`);

export interface CollectionTableRow {
  title: string;
  /** Field name → value as text, for fields that hold a value. */
  values: Record<string, string>;
  citeAs: string;
  documentId: string;
  versionId: string;
  versionNumber: number;
  /** The row's first chunk (it holds the field header). */
  chunkId: string;
  spaceId: string;
}

export interface CollectionTable {
  collectionId: string;
  title: string;
  /** Field names in field order. */
  fields: string[];
  rows: CollectionTableRow[];
  /** More rows than were kept (ASK_TABLES.rows, or the text budget). */
  truncated: boolean;
}

/**
 * Tables for Ask: one per collection a retrieved page passage is a row of
 * (or is), at most ASK_TABLES.collections, in the order their first passage
 * came. Rows are the collection's live sub-pages with an indexed version in
 * a readable (non-Inbox) space, by title, at most ASK_TABLES.rows; values
 * come from each row's indexed version read against the collection's
 * current fields, so a change waiting for review is not shown. A fixed
 * number of queries per collection.
 */
export async function collectionTables(
  tx: DbTransaction,
  actor: Actor,
  readableSpaceIds: string[],
  passages: SearchPassage[]
): Promise<CollectionTable[]> {
  const tenantId = actor.tenantId;
  const ids = [...new Set(passages.filter((p) => p.documentKind === 'page').map((p) => p.documentId))];
  if (ids.length === 0 || readableSpaceIds.length === 0) return [];
  const docs = await tx
    .select({ id: documents.id, parentId: documents.parentId })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, ids)));
  const wanted = [...new Set(ids.flatMap((id) => {
    const doc = docs.find((d) => d.id === id);
    return doc ? [doc.id, ...(doc.parentId ? [doc.parentId] : [])] : [];
  }))];
  const found = await tx
    .select({ id: documents.id, title: documents.title, spaceId: documents.spaceId })
    .from(collections)
    .innerJoin(documents, and(eq(documents.tenantId, collections.tenantId), eq(documents.id, collections.documentId)))
    .where(
      and(
        eq(collections.tenantId, tenantId),
        inArray(collections.documentId, wanted),
        isNull(documents.archivedAt),
        inArray(documents.spaceId, readableSpaceIds)
      )
    );
  const ordered = wanted.flatMap((id) => found.filter((c) => c.id === id)).slice(0, ASK_TABLES.collections);

  const tables: CollectionTable[] = [];
  for (const collection of ordered) {
    const defs = await collectionFieldDefs(tx, tenantId, collection.id);
    const rows = await tx
      .select({
        documentId: documents.id,
        spaceId: documents.spaceId,
        versionId: versions.id,
        number: versions.number,
        title: versions.title,
        createdAt: versions.createdAt,
        fields: versions.fields,
      })
      .from(documents)
      .innerJoin(versions, and(eq(versions.tenantId, documents.tenantId), eq(versions.id, documents.indexedVersionId)))
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .where(
        and(
          eq(documents.tenantId, tenantId),
          eq(documents.parentId, collection.id),
          eq(documents.kind, 'page'),
          isNull(documents.archivedAt),
          isNotNull(documents.indexedVersionId),
          inArray(documents.spaceId, readableSpaceIds),
          ne(spaces.kind, 'inbox')
        )
      )
      .orderBy(asc(versions.title), asc(documents.id))
      .limit(ASK_TABLES.rows + 1);
    const kept = rows.slice(0, ASK_TABLES.rows);
    const firstChunks =
      kept.length === 0
        ? []
        : await tx
            .select({ id: chunks.id, versionId: chunks.versionId })
            .from(chunks)
            .where(and(eq(chunks.tenantId, tenantId), inArray(chunks.versionId, kept.map((r) => r.versionId)), eq(chunks.ordinal, 0)));
    const raws = kept.map((r) => validFields(defs, (r.fields as Record<string, unknown> | null) ?? {}));
    // One name lookup for every row: person and page ids gathered across them.
    const merged: Record<string, unknown> = {};
    for (const def of defs) merged[def.id] = raws.flatMap((raw) => (Array.isArray(raw[def.id]) ? (raw[def.id] as unknown[]) : []));
    const names = await fieldNames(tx, tenantId, defs, merged, collection.spaceId);
    const tableRows: CollectionTableRow[] = [];
    let size = 0;
    let overBudget = false;
    kept.forEach((r, i) => {
      if (overBudget) return;
      const chunk = firstChunks.find((c) => c.versionId === r.versionId);
      if (!chunk) return;
      const values: Record<string, string> = {};
      for (const def of defs) {
        const text = def.id in raws[i]! ? formatFieldValue(def, raws[i]![def.id], names) : null;
        if (text !== null) values[def.name] = cut(text);
      }
      const rowSize = r.title.length + Object.values(values).join('').length;
      if (size + rowSize > ASK_TABLES.tableChars) {
        overBudget = true;
        return;
      }
      size += rowSize;
      tableRows.push({
        title: r.title,
        values,
        citeAs: citeAs(r.title, r.number, r.createdAt.toISOString().slice(0, 10)),
        documentId: r.documentId,
        versionId: r.versionId,
        versionNumber: r.number,
        chunkId: chunk.id,
        spaceId: r.spaceId,
      });
    });
    tables.push({
      collectionId: collection.id,
      title: collection.title,
      fields: defs.map((d) => d.name),
      rows: tableRows,
      truncated: rows.length > ASK_TABLES.rows || overBudget,
    });
  }
  return tables;
}
