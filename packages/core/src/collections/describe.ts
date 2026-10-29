import { and, eq } from 'drizzle-orm';
import { documents, type DbTransaction } from '@kinote/db';
import { FIELD_BLOCK_PREFIX, formatFieldValue, type FieldChange } from '@kinote/contracts';
import { fieldNames, rowCollectionOf } from './fields.js';

/** The field id of a `field:<id>` block id; null for a block. */
export function fieldIdOf(blockId: string | null): string | null {
  return blockId?.startsWith(FIELD_BLOCK_PREFIX) ? blockId.slice(FIELD_BLOCK_PREFIX.length) : null;
}

function parsed(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * A routed field change as the console shows it: the field's current name
 * and each side (stored as canonical JSON) printed with `formatFieldValue`,
 * read against the row's current fields. `name` is null when the field is
 * gone (or the page is no longer a row); an empty or unprintable side is null.
 */
export async function describeFieldChange(
  tx: DbTransaction,
  tenantId: string,
  documentId: string,
  fieldId: string,
  beforeJson: string | null,
  afterJson: string | null
): Promise<FieldChange> {
  const row = await rowCollectionOf(tx, tenantId, documentId);
  const def = row?.fields.find((d) => d.id === fieldId);
  if (!def) return { fieldId, name: null, before: null, after: null };
  const before = parsed(beforeJson);
  const after = parsed(afterJson);
  const [doc] = await tx.select({ spaceId: documents.spaceId }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)));
  const shown = async (value: unknown) =>
    value === null ? null : formatFieldValue(def, value, await fieldNames(tx, tenantId, [def], { [def.id]: value }, doc!.spaceId));
  return { fieldId, name: def.name, before: await shown(before), after: await shown(after) };
}
