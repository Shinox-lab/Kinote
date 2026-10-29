import { and, eq } from 'drizzle-orm';
import { AppError } from '@kinote/contracts';
import { documents } from './schema/pages_and_index.js';
import type { DbTransaction } from './client.js';

/** A row of the `documents` table. */
export type DocumentRow = typeof documents.$inferSelect;

/**
 * Locks a document row (`SELECT ... FOR UPDATE`) for the rest of the
 * transaction and returns it. Every writer that changes what a document
 * publishes (indexing, archive, withdraw, move) takes this lock first, so they
 * run one after another per document. Filtered on tenant even with RLS on.
 */
export async function lockDocument(
  tx: DbTransaction,
  tenantId: string,
  documentId: string
): Promise<DocumentRow> {
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
    .for('update');
  if (!doc) throw new AppError('document_not_found');
  return doc;
}
