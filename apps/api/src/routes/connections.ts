import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { captureChanges, captures, documents, links, spaces, versions, withTenantTx, type DbTransaction } from '@living-wiki/db';
import {
  AppError,
  DocumentTitlesQuerySchema,
  LinkTargetQuerySchema,
  type DocumentTitle,
  type LinkTarget,
  type PageConnections,
} from '@living-wiki/contracts';
import { assertValidUuid, getReadableSpaceIds, isTenantAdmin, requireDocumentRole, type Actor } from '@living-wiki/core';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';

const EXCERPT_CHARS = 160;

/**
 * The rule for "a live document the caller can read", over `documents`
 * joined with its `spaces` row: not archived, in a readable space, and an
 * Inbox document only for its creator (tenant admins excepted).
 */
async function visibleDocuments(tx: DbTransaction, actor: Actor): Promise<SQL | null> {
  const { readableSpaceIds } = await getReadableSpaceIds(tx, actor);
  if (readableSpaceIds.length === 0) return null;
  const inboxRule = isTenantAdmin(actor)
    ? undefined
    : or(
        ne(spaces.kind, 'inbox'),
        and(eq(documents.createdByType, actor.principalType), eq(documents.createdBy, actor.principalId))
      );
  return and(
    eq(documents.tenantId, actor.tenantId),
    isNull(documents.archivedAt),
    isNull(spaces.archivedAt),
    inArray(documents.spaceId, readableSpaceIds),
    inboxRule
  )!;
}

const spaceOfDocument = and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId));

/** GET /api/v1/link-targets: pages for the `[[` picker. */
export async function listLinkTargets(actor: Actor, query: unknown): Promise<LinkTarget[]> {
  const { q, limit } = LinkTargetQuerySchema.parse(query);
  const term = q.trim();
  return withTenantTx(actor.tenantId, async (tx) => {
    const visible = await visibleDocuments(tx, actor);
    if (!visible) return [];
    const parent = alias(documents, 'parent');
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    // `%` (similarity above pg_trgm's limit, 0.3 by default) and ILIKE can both use the trigram index.
    const match = term
      ? or(ilike(documents.title, `%${escaped}%`), sql`${documents.title} % ${term}`)
      : undefined;
    const order = term
      ? [
          desc(sql`(lower(${documents.title}) = lower(${term}))`),
          desc(sql`(${documents.title} ILIKE ${`${escaped}%`})`),
          desc(sql`similarity(${documents.title}, ${term})`),
          asc(documents.title),
        ]
      : [desc(documents.createdAt)];
    const rows = await tx
      .select({
        id: documents.id,
        title: documents.title,
        icon: documents.icon,
        spaceId: spaces.id,
        spaceName: spaces.name,
        parentTitle: parent.title,
      })
      .from(documents)
      .innerJoin(spaces, spaceOfDocument)
      .leftJoin(parent, and(eq(parent.tenantId, documents.tenantId), eq(parent.id, documents.parentId)))
      .where(and(visible, eq(documents.kind, 'page'), match))
      .orderBy(...order)
      .limit(limit);
    return rows.map((r) => ({ ...r, parentTitle: r.parentTitle ?? null }));
  });
}

/** GET /api/v1/documents/titles: current titles of readable, live documents. */
export async function listDocumentTitles(actor: Actor, query: unknown): Promise<DocumentTitle[]> {
  const { ids } = DocumentTitlesQuerySchema.parse(query);
  return withTenantTx(actor.tenantId, async (tx) => {
    const visible = await visibleDocuments(tx, actor);
    if (!visible) return [];
    return tx
      .select({ id: documents.id, kind: documents.kind, title: documents.title, icon: documents.icon })
      .from(documents)
      .innerJoin(spaces, spaceOfDocument)
      .where(and(visible, inArray(documents.id, ids)))
      .orderBy(asc(documents.title));
  });
}

function excerptOf(blocks: unknown, blockId: string): string {
  const flat = flattenBlocks(Array.isArray(blocks) ? (blocks as BlockLike[]) : []);
  const text = flat.find((b) => b.id === blockId)?.text.trim() ?? '';
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

/** GET /api/v1/pages/:id/connections: links in, and the routing engine's document edits both ways. */
export async function getPageConnections(actor: Actor, pageId: string): Promise<PageConnections> {
  assertValidUuid(pageId, 'page_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const [page] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
    if (!page || page.kind !== 'page') throw new AppError('page_not_found');
    await requireDocumentRole(tx, actor, page, 'viewer', { notFound: 'page_not_found' });
    const visible = await visibleDocuments(tx, actor);
    if (!visible) return { linkedFrom: [], updatedBy: [], updated: [] };

    // Links in: the first linking block of each readable page, from its latest snapshot.
    const linkRows = await tx
      .select({
        pageId: documents.id,
        title: documents.title,
        icon: documents.icon,
        spaceName: spaces.name,
        blockId: links.fromBlockId,
        blocks: versions.blocks,
      })
      .from(links)
      .innerJoin(documents, and(eq(documents.tenantId, links.tenantId), eq(documents.id, links.fromPageId)))
      .innerJoin(spaces, spaceOfDocument)
      .leftJoin(versions, and(eq(versions.tenantId, documents.tenantId), eq(versions.id, documents.latestVersionId)))
      .where(and(visible, eq(links.tenantId, actor.tenantId), eq(links.toDocumentId, pageId), ne(links.fromPageId, pageId)))
      // The first linking block of each page, the same one every time.
      .orderBy(asc(documents.title), asc(documents.id), asc(links.fromBlockId));
    const seen = new Set<string>();
    const linkedFrom = linkRows
      .filter((r) => (seen.has(r.pageId) ? false : (seen.add(r.pageId), true)))
      .map(({ blocks, ...r }) => ({ ...r, excerpt: excerptOf(blocks, r.blockId) }));

    // Applied fact edits that came from a document capture (its own page's blocks have no fact).
    const factEdit = and(
      eq(captureChanges.tenantId, actor.tenantId),
      eq(captureChanges.status, 'applied'),
      isNotNull(captureChanges.factId)
    );
    const captureOfChange = and(eq(captures.tenantId, captureChanges.tenantId), eq(captures.id, captureChanges.captureId));

    const updatedBy = await tx
      .select({
        pageId: documents.id,
        title: documents.title,
        icon: documents.icon,
        spaceName: spaces.name,
        blockIds: sql<string[]>`array_agg(DISTINCT ${captureChanges.blockId} ORDER BY ${captureChanges.blockId})`,
      })
      .from(captureChanges)
      .innerJoin(captures, captureOfChange)
      .innerJoin(documents, and(eq(documents.tenantId, captures.tenantId), eq(documents.id, captures.documentPageId)))
      .innerJoin(spaces, spaceOfDocument)
      .where(and(visible, factEdit, eq(captureChanges.documentId, pageId), ne(documents.id, pageId)))
      .groupBy(documents.id, documents.title, documents.icon, spaces.name)
      .orderBy(asc(documents.title));

    const updated = await tx
      .select({
        pageId: documents.id,
        title: documents.title,
        icon: documents.icon,
        spaceName: spaces.name,
        captureId: captures.id,
        sections: sql<number>`count(DISTINCT ${captureChanges.blockId})::int`,
      })
      .from(captureChanges)
      .innerJoin(captures, captureOfChange)
      .innerJoin(documents, and(eq(documents.tenantId, captureChanges.tenantId), eq(documents.id, captureChanges.documentId)))
      .innerJoin(spaces, spaceOfDocument)
      .where(and(visible, factEdit, eq(captures.documentPageId, pageId), ne(captureChanges.documentId, pageId)))
      .groupBy(documents.id, documents.title, documents.icon, spaces.name, captures.id)
      .orderBy(asc(documents.title));

    return { linkedFrom, updatedBy, updated };
  });
}
