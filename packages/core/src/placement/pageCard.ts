import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  versions,
  spaces,
  pageCards,
  lockDocument,
  NonRetryableError,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';
import type { EmbeddingProvider } from '../embedding.js';
import type { PlacementModel } from './model.js';
import { pageFieldEntries } from '../collections/fields.js';

export type BuildPageCardResult =
  | { outcome: 'built' }
  | { outcome: 'skipped'; reason: 'not_indexed' | 'not_a_page' | 'inbox' | 'archived' };

/** Heading texts in order, prefixed by their level ("## Owners"). */
export function pageOutline(blocks: BlockLike[]): string[] {
  return flattenBlocks(blocks)
    .filter((b) => b.type === 'heading' && b.text.trim() !== '')
    .map((b) => `${'#'.repeat(b.level ?? 1)} ${b.text.trim()}`);
}

/**
 * Writes the card of a page's indexed version, in `indexVersion`'s three
 * phases so no transaction is held across the model or embedding call:
 * read (skip unless this is still the document's indexed version of a page
 * outside the Inbox), summarise and embed, then upsert under the document lock
 * after re-checking. The card takes the document's current space.
 */
export async function buildPageCard(
  params: { tenantId: string; versionId: string },
  model: PlacementModel,
  embedder: EmbeddingProvider
): Promise<BuildPageCardResult> {
  const { tenantId, versionId } = params;

  const loaded = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select({ version: versions, document: documents, spaceKind: spaces.kind })
      .from(versions)
      .innerJoin(documents, and(eq(documents.tenantId, versions.tenantId), eq(documents.id, versions.documentId)))
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, versionId)));
    if (!row) throw new AppError('version_not_found');
    const fieldLines = (await pageFieldEntries(tx, tenantId, row.document.id, row.version.fields)).map((e) => e.text);
    return { ...row, fieldLines };
  });
  const { version, document, fieldLines } = loaded;
  if (document.kind !== 'page') return { outcome: 'skipped', reason: 'not_a_page' };
  if (document.indexedVersionId !== versionId) return { outcome: 'skipped', reason: 'not_indexed' };
  if (document.archivedAt) return { outcome: 'skipped', reason: 'archived' };
  if (loaded.spaceKind === 'inbox') return { outcome: 'skipped', reason: 'inbox' };
  if (!Array.isArray(version.blocks)) throw new NonRetryableError('version has no blocks');

  const outline = pageOutline(version.blocks as BlockLike[]);
  const { summary } = await model.summarizePage({
    title: version.title,
    outline,
    markdown: [fieldLines.join('\n'), version.markdown ?? ''].filter(Boolean).join('\n\n'),
  });
  const embedded = [version.title, ...fieldLines, summary, ...outline].join('\n');
  const [embedding] = await embedder.embed([embedded], 'document');
  if (!Array.isArray(embedding) || embedding.length !== embedder.dimensions) {
    throw new NonRetryableError(`embedding provider returned a malformed vector for a page card`);
  }

  return withTenantTx(tenantId, async (tx): Promise<BuildPageCardResult> => {
    const doc = await lockDocument(tx, tenantId, document.id);
    if (doc.indexedVersionId !== versionId) return { outcome: 'skipped', reason: 'not_indexed' };
    if (doc.archivedAt) return { outcome: 'skipped', reason: 'archived' };
    const [space] = await tx
      .select({ kind: spaces.kind })
      .from(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, doc.spaceId)));
    if (space?.kind === 'inbox') return { outcome: 'skipped', reason: 'inbox' };

    const row = { tenantId, spaceId: doc.spaceId, versionId, summary, outline, embedding, updatedAt: new Date() };
    await tx
      .insert(pageCards)
      .values({ documentId: doc.id, ...row })
      .onConflictDoUpdate({ target: pageCards.documentId, set: row });
    return { outcome: 'built' };
  });
}
