import { isDeepStrictEqual } from 'node:util';
import * as Y from 'yjs';
import { createServerEditor, restorePageLinks } from '@kinote/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  pages,
  spaces,
  versions,
  versionContributors,
  pagePendingContributors,
  blockActivity,
  chunks,
  users,
  agents,
  enqueueJob,
  writeAuditEvent,
  lockDocument,
  type DbTransaction,
  type DocumentRow,
} from '@kinote/db';
import {
  CreatePageRequestSchema,
  MovePageRequestSchema,
  ApproveVersionRequestSchema,
  RejectVersionRequestSchema,
  CompareQuerySchema,
  RestoreVersionParamsSchema,
  UpdatePageRequestSchema,
  AppError,
  FIELDS_MAP,
  type CollabTokenResponse,
  type DocumentSummary,
  type PageDetails,
  type PageSummary,
  type RetryVersionResponse,
  type VersionSummary,
  type VersionListItem,
  type VersionDetail,
  type BlockDiffEntry,
  DRAWINGS_MAP,
  isDrawingElement,
  type DrawingElement,
} from '@kinote/contracts';
import {
  requireSpaceRole,
  requireDocumentRole,
  assertValidUuid,
  takePageSnapshot,
  chunkInboxOwner,
  pageSlugScope,
  isTenantAdmin,
  type Actor,
  movePlacementIndex,
  notify,
  isCollection,
  enqueueReindex,
  pageFieldEntries,
  versionDrawings,
  withDrawingText,
  withoutDrawingText,
} from '@kinote/core';
import {
  signCollabToken,
  getCollabTokenSecret,
  documentName,
  COLLAB_TOKEN_TTL_SECONDS,
  liveElements,
} from '@kinote/shared';
import type { BlockLike } from '@kinote/shared';
import {
  requireVisibleParent,
  withdrawLiveVersions,
  wouldCreateCycle,
  returnToReview,
} from '../documents/lifecycle.js';
import { computePageBadge } from '../pages/badge.js';
import { pageCollectionInfo } from './collections.js';
import { diffBlocks, withDrawingDiffs, withFieldLines, type DrawingSide } from '../pages/diff.js';
import { resolveActorNames } from '../people.js';
import { canApprove } from '../pages/approval.js';
import type { CollabClient } from '@kinote/shared';

const blockNote = createServerEditor();

/** The `versions` columns a VersionSummary is built from (no markdown, blocks or Yjs bytes). */
export const versionSummaryColumns = {
  id: versions.id,
  number: versions.number,
  status: versions.status,
  reason: versions.reason,
  createdByType: versions.createdByType,
  createdBy: versions.createdBy,
  createdAt: versions.createdAt,
  reviewedBy: versions.reviewedBy,
  reviewedAt: versions.reviewedAt,
  reviewNote: versions.reviewNote,
  indexedAt: versions.indexedAt,
  error: versions.error,
};

export type VersionSummaryRow = {
  [K in keyof typeof versionSummaryColumns]: (typeof versions.$inferSelect)[K];
};

/** A version row (or its summary columns) as the published VersionSummary. */
export function toVersionSummary(row: VersionSummaryRow): VersionSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    reason: row.reason,
    createdByType: row.createdByType,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    indexedAt: row.indexedAt?.toISOString() ?? null,
    error: row.error,
  };
}

/** A document row as the published DocumentSummary (timestamps as ISO strings). */
export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    position: row.position,
    title: row.title,
    icon: row.icon,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    indexedVersionId: row.indexedVersionId,
  };
}

export async function encodePageYDoc(title: string, markdown: string): Promise<Buffer> {
  const blocks = restorePageLinks(await blockNote.tryParseMarkdownToBlocks(markdown));
  const ydoc = blockNote.blocksToYDoc(blocks, 'document-store');
  ydoc.getMap('meta').set('title', title);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

export async function createPage(actor: Actor, input: unknown): Promise<PageSummary> {
  const parsed = CreatePageRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const { space } = await requireSpaceRole(tx, actor, parsed.space_id, 'editor', {
      lock: 'share',
    });

    if (parsed.parent_id) {
      await requireVisibleParent(tx, actor, parsed.parent_id, parsed.space_id);
    }

    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId: actor.tenantId,
        spaceId: parsed.space_id,
        parentId: parsed.parent_id,
        kind: 'page',
        title: parsed.title,
        placement: 'pinned',
        createdByType: actor.principalType,
        createdBy: actor.principalId,
      })
      .returning();

    const initialYdocState = await encodePageYDoc(parsed.title, parsed.markdown);

    const [page] = await tx
      .insert(pages)
      .values({
        documentId: doc.id,
        tenantId: actor.tenantId,
        spaceId: parsed.space_id,
        slug: parsed.slug,
        // In the Inbox a slug is unique per creator (pages_space_slug_idx).
        slugScope: pageSlugScope(space.kind, doc),
        ydocState: initialYdocState,
        liveChangedSinceSnapshot: parsed.markdown.trim().length > 0,
        agentChangedAt: actor.principalType === 'agent' ? new Date() : null,
      })
      .returning();

    // The creator wrote the initial content (stored directly, not through
    // collab), so they contribute to the page's first snapshot like any
    // other editor: they cannot approve it where self-approval is off.
    await tx.insert(pagePendingContributors).values({
      tenantId: actor.tenantId,
      pageId: doc.id,
      principalType: actor.principalType,
      principalId: actor.principalId,
    });

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'page.created',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'page',
      subjectId: doc.id,
      payload: { spaceId: parsed.space_id, slug: parsed.slug, title: parsed.title },
    });

    return {
      id: doc.id,
      spaceId: doc.spaceId,
      parentId: doc.parentId,
      title: doc.title,
      slug: page.slug,
      icon: doc.icon,
    };
  });
}

export async function getPageDetails(actor: Actor, pageId: string): Promise<PageDetails> {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));

    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found');
    }

    const { space } = await requireDocumentRole(tx, actor, doc, 'viewer', {
      notFound: 'page_not_found',
    });

    const [page] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));

    const pageVersions = (
      await tx
        .select(versionSummaryColumns)
        .from(versions)
        .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.documentId, pageId)))
        .orderBy(desc(versions.number))
    ).map(toVersionSummary);

    const latestVersion = pageVersions[0] ?? null;
    const indexedVersion = doc.indexedVersionId
      ? pageVersions.find((v) => v.id === doc.indexedVersionId) ?? null
      : null;

    const badge = computePageBadge({
      liveChangedSinceSnapshot: page.liveChangedSinceSnapshot,
      agentChangedAt: page.agentChangedAt,
      spaceReviewRequired: space.reviewRequired,
      latestVersion: latestVersion
        ? { number: latestVersion.number, status: latestVersion.status }
        : null,
      indexedVersion: indexedVersion ? { number: indexedVersion.number } : null,
    });

    const activity = await tx
      .select()
      .from(blockActivity)
      .where(and(eq(blockActivity.tenantId, actor.tenantId), eq(blockActivity.pageId, pageId)));

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, page.ydocState);
    const liveBlocks = blockNote.yDocToBlocks(ydoc, 'document-store');
    const liveMarkdown = await blockNote.blocksToMarkdownLossy(liveBlocks);
    const liveTitle = ydoc.getMap('meta').get('title')?.toString() || doc.title;

    return {
      id: doc.id,
      spaceId: doc.spaceId,
      parentId: doc.parentId,
      title: liveTitle,
      slug: page.slug,
      icon: doc.icon,
      badge,
      liveMarkdown,
      liveBlocks,
      liveChangedSinceSnapshot: page.liveChangedSinceSnapshot,
      agentChangedAt: page.agentChangedAt?.toISOString() ?? null,
      archivedAt: doc.archivedAt?.toISOString() ?? null,
      latestVersion,
      indexedVersion,
      versions: pageVersions,
      blockActivity: activity.map((a) => ({
        blockId: a.blockId,
        actorType: a.actorType,
        actorId: a.actorId,
        changedAt: a.changedAt.toISOString(),
      })),
      ...(await pageCollectionInfo(tx, actor.tenantId, doc)),
    };
  });
}

/**
 * Reads: version history, version detail and block diffs. All are viewer reads
 * through `requireDocumentRole`, so a document the actor cannot see (hidden
 * Inbox item, unreadable space) answers the same 404 body as an unknown id.
 * They take no document lock (plain reads) and filter on tenant_id.
 */

/** The page document, readable by the actor (404 `page_not_found` otherwise). */
async function readablePage(tx: DbTransaction, actor: Actor, pageId: string): Promise<DocumentRow> {
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
  if (!doc || doc.kind !== 'page') {
    throw new AppError('page_not_found');
  }
  await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'page_not_found' });
  return doc;
}

/** The stored BlockNote blocks of a version (`[]` while it has none). */
function storedBlocks(blocks: unknown): BlockLike[] {
  return Array.isArray(blocks) ? (blocks as BlockLike[]) : [];
}

/** `block_activity` of a page: the last actor per block. */
async function pageActivity(tx: DbTransaction, tenantId: string, pageId: string) {
  return tx
    .select({
      blockId: blockActivity.blockId,
      actorType: blockActivity.actorType,
      actorId: blockActivity.actorId,
    })
    .from(blockActivity)
    .where(and(eq(blockActivity.tenantId, tenantId), eq(blockActivity.pageId, pageId)));
}

/** The blocks of the document's currently indexed version, or null when none is indexed. */
/** The indexed version's blocks, its field lines after them (see `withFieldLines`). */
async function indexedBlocks(tx: DbTransaction, tenantId: string, doc: DocumentRow) {
  if (!doc.indexedVersionId) return null;
  const [row] = await tx
    .select({ blocks: versions.blocks, fields: versions.fields })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.id, doc.indexedVersionId)));
  return row ? withFields(tx, tenantId, doc.id, storedBlocks(row.blocks), row.fields) : null;
}

/** A stored version's drawings, or null. */
function storedDrawings(drawings: unknown): Record<string, DrawingElement[]> | null {
  return drawings && typeof drawings === 'object' && !Array.isArray(drawings) ? (drawings as Record<string, DrawingElement[]>) : null;
}

/** The indexed version's drawing side of a diff (nothing when none is indexed). */
async function indexedDrawings(tx: DbTransaction, tenantId: string, doc: DocumentRow): Promise<DrawingSide> {
  if (!doc.indexedVersionId) return { blocks: [], drawings: null };
  const [row] = await tx
    .select({ blocks: versions.blocks, drawings: versions.drawings })
    .from(versions)
    .where(and(eq(versions.tenantId, tenantId), eq(versions.id, doc.indexedVersionId)));
  return row ? { blocks: storedBlocks(row.blocks), drawings: storedDrawings(row.drawings) } : { blocks: [], drawings: null };
}

/** `blocks` with the page's field lines for `fields` after them, so diffs show field changes. */
async function withFields(tx: DbTransaction, tenantId: string, pageId: string, blocks: BlockLike[], fields: unknown) {
  return withFieldLines(blocks, await pageFieldEntries(tx, tenantId, pageId, fields));
}

/**
 * GET /api/v1/pages/:id/drawings/:drawingId?version=<n>: a drawing's live
 * elements, or version n's. Page readers only (404 `page_not_found`); a
 * drawing the page (or version) doesn't have is 404 `block_not_found`.
 */
export async function getPageDrawing(actor: Actor, pageId: string, drawingId: string, query: unknown): Promise<{ elements: DrawingElement[] }> {
  assertValidUuid(pageId, 'page_not_found');
  const raw = (query as { version?: unknown } | null)?.version;
  const version = raw === undefined ? null : Number(raw);
  if (version !== null && !(Number.isInteger(version) && version > 0)) throw new AppError('version_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    await readablePage(tx, actor, pageId);
    if (version !== null) {
      const [row] = await tx
        .select({ drawings: versions.drawings })
        .from(versions)
        .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.documentId, pageId), eq(versions.number, version)));
      if (!row) throw new AppError('version_not_found');
      const list = storedDrawings(row.drawings)?.[drawingId];
      if (!Array.isArray(list)) throw new AppError('block_not_found');
      return { elements: list.filter(isDrawingElement) };
    }
    const [page] = await tx
      .select({ ydocState: pages.ydocState })
      .from(pages)
      .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));
    if (!page) throw new AppError('page_not_found');
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, page.ydocState);
    const scene = ydoc.getMap<unknown>(DRAWINGS_MAP).get(drawingId);
    if (!(scene instanceof Y.Map)) throw new AppError('block_not_found');
    return { elements: liveElements(scene as Y.Map<unknown>) };
  });
}

/** GET /api/v1/pages/:id/versions: the page's versions as summaries, newest first. */
export async function listPageVersions(actor: Actor, pageId: string): Promise<VersionListItem[]> {
  assertValidUuid(pageId, 'page_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    await readablePage(tx, actor, pageId);
    const rows = await tx
      .select(versionSummaryColumns)
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.documentId, pageId)))
      .orderBy(desc(versions.number));
    // Names for every role that can read the page, the way /changes names its authors.
    const names = await resolveActorNames(
      tx,
      actor.tenantId,
      rows.map((r) => ({ type: r.createdByType, id: r.createdBy }))
    );
    return rows.map((r) => ({
      ...toVersionSummary(r),
      createdByName: names.get(`${r.createdByType}:${r.createdBy}`)!,
    }));
  });
}

/**
 * Finds a version and its document and checks the actor may read it: unknown
 * ids and versions of hidden documents are the same 404 `version_not_found`.
 */
async function readableVersion(tx: DbTransaction, actor: Actor, versionId: string) {
  const [ver] = await tx
    .select({
      ...versionSummaryColumns,
      documentId: versions.documentId,
      markdown: versions.markdown,
      blocks: versions.blocks,
    })
    .from(versions)
    .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)));
  if (!ver) {
    throw new AppError('version_not_found');
  }
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, ver.documentId)));
  if (!doc || doc.kind !== 'page') {
    throw new AppError('version_not_found');
  }
  await requireDocumentRole(tx, actor, doc, 'viewer', { notFound: 'version_not_found' });
  return { ver, doc };
}

/**
 * GET /api/v1/versions/:id: the summary plus markdown, stored blocks and the
 * contributors with their display names. The Yjs snapshot is never selected.
 */
export async function getVersionDetail(actor: Actor, versionId: string): Promise<VersionDetail> {
  assertValidUuid(versionId, 'version_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const { ver } = await readableVersion(tx, actor, versionId);

    const rows = await tx
      .select({
        type: versionContributors.principalType,
        id: versionContributors.principalId,
        userName: users.name,
        agentName: agents.name,
      })
      .from(versionContributors)
      .leftJoin(users, eq(users.id, versionContributors.principalId))
      .leftJoin(
        agents,
        and(eq(agents.id, versionContributors.principalId), eq(agents.tenantId, actor.tenantId))
      )
      .where(
        and(
          eq(versionContributors.tenantId, actor.tenantId),
          eq(versionContributors.versionId, versionId)
        )
      );
    const contributors = rows
      .map((r) => ({
        type: r.type,
        id: r.id,
        name: (r.type === 'agent' ? r.agentName : r.userName) ?? r.id,
        isAgent: r.type === 'agent',
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    return {
      ...toVersionSummary(ver),
      markdown: ver.markdown,
      blocks: storedBlocks(ver.blocks),
      contributors,
    };
  });
}

/**
 * GET /api/v1/pages/:id/changes: the indexed version's blocks against the
 * live content (all `added` when nothing is indexed), authored from
 * `block_activity`, each author with a display name (the only diff that has
 * one). "Live" is the last STORED collab state (`pages.ydoc_state`, written by
 * the debounced store or a flush), like `getPageDetails`: keystrokes not yet
 * stored by the collab server are not in it.
 */
export async function getPageChanges(actor: Actor, pageId: string): Promise<BlockDiffEntry[]> {
  assertValidUuid(pageId, 'page_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await readablePage(tx, actor, pageId);
    const before = (await indexedBlocks(tx, actor.tenantId, doc)) ?? [];

    const [page] = await tx
      .select({ ydocState: pages.ydocState })
      .from(pages)
      .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));
    if (!page) {
      throw new AppError('page_not_found');
    }
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, page.ydocState);
    // Live drawing blocks read their words from the live scene, as the snapshot will.
    const liveBlocks = withDrawingText(blockNote.yDocToBlocks(ydoc, 'document-store') as BlockLike[], ydoc);
    const live = await withFields(tx, actor.tenantId, pageId, liveBlocks, ydoc.getMap(FIELDS_MAP).toJSON());

    const activity = await pageActivity(tx, actor.tenantId, pageId);
    const diff = withDrawingDiffs(diffBlocks(before, live, activity), await indexedDrawings(tx, actor.tenantId, doc), {
      blocks: liveBlocks,
      drawings: versionDrawings(liveBlocks, ydoc),
    });
    // Names for every role that can read the page: the author's display name
    // only, resolved against the tenant's memberships (see resolveActorNames).
    const names = await resolveActorNames(
      tx,
      actor.tenantId,
      diff.flatMap((e) => (e.author ? [e.author] : []))
    );
    return diff.map((e) =>
      e.author
        ? { ...e, author: { ...e.author, name: names.get(`${e.author.type}:${e.author.id}`) } }
        : e
    );
  });
}

/**
 * GET /api/v1/pages/:id/compare?from=<n>&to=<m>: the diff between two versions
 * of the page, by version number (400 `validation_failed` unless both are
 * positive integers, 404 `version_not_found` for a number the page lacks).
 *
 * Authors are not attributed: `block_activity` keeps only the LAST actor per
 * block, not who changed it between two particular versions, so an author here
 * could be wrong. The activity list is empty on purpose.
 */
export async function comparePageVersions(
  actor: Actor,
  pageId: string,
  query: unknown
): Promise<BlockDiffEntry[]> {
  assertValidUuid(pageId, 'page_not_found');
  const { from, to } = CompareQuerySchema.parse(query);
  return withTenantTx(actor.tenantId, async (tx) => {
    await readablePage(tx, actor, pageId);
    const rows = await tx
      .select({ number: versions.number, blocks: versions.blocks, fields: versions.fields, drawings: versions.drawings })
      .from(versions)
      .where(
        and(
          eq(versions.tenantId, actor.tenantId),
          eq(versions.documentId, pageId),
          inArray(versions.number, [from, to])
        )
      );
    const fromRow = rows.find((r) => r.number === from);
    const toRow = rows.find((r) => r.number === to);
    if (!fromRow || !toRow) {
      throw new AppError('version_not_found');
    }
    const entries = diffBlocks(
      await withFields(tx, actor.tenantId, pageId, storedBlocks(fromRow.blocks), fromRow.fields),
      await withFields(tx, actor.tenantId, pageId, storedBlocks(toRow.blocks), toRow.fields),
      []
    );
    return withDrawingDiffs(
      entries,
      { blocks: storedBlocks(fromRow.blocks), drawings: storedDrawings(fromRow.drawings) },
      { blocks: storedBlocks(toRow.blocks), drawings: storedDrawings(toRow.drawings) }
    );
  });
}

/**
 * GET /api/v1/versions/:id/diff: the version against the document's CURRENT
 * indexed version. When the version IS the indexed one every block is
 * `unchanged`; when the document has no indexed version the base is empty and
 * every block is `added`.
 */
export async function getVersionDiff(actor: Actor, versionId: string): Promise<BlockDiffEntry[]> {
  assertValidUuid(versionId, 'version_not_found');
  return withTenantTx(actor.tenantId, async (tx) => {
    const { ver, doc } = await readableVersion(tx, actor, versionId);
    const [stored] = await tx
      .select({ fields: versions.fields, drawings: versions.drawings })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)));
    const after = await withFields(tx, actor.tenantId, doc.id, storedBlocks(ver.blocks), stored?.fields);
    // The indexed version itself: nothing to differ from (all `unchanged`).
    // Nothing indexed: against an empty base, so a new page's first version
    // shows all its content as `added`.
    const base =
      doc.indexedVersionId === ver.id ? after : ((await indexedBlocks(tx, actor.tenantId, doc)) ?? []);
    const afterSide = { blocks: storedBlocks(ver.blocks), drawings: storedDrawings(stored?.drawings) };
    const baseSide = doc.indexedVersionId === ver.id ? afterSide : await indexedDrawings(tx, actor.tenantId, doc);
    // No authors, for the reason given at comparePageVersions.
    return withDrawingDiffs(diffBlocks(base, after, []), baseSide, afterSide);
  });
}

/**
 * Manual snapshot of a page's live state (the "submit" button, or an agent's
 * explicit snapshot). The actor must be editor or higher on the page
 * (`requireDocumentRole`): a reader who cannot see it gets 404
 * `page_not_found`, a viewer 403 `forbidden`, an archived space 409
 * `space_archived`.
 *
 * The live document is flushed through `collab` first, so the snapshot holds
 * what was typed a moment ago rather than the last debounced store. A failed
 * flush fails the snapshot (`internal_error`): it never snapshots stale state.
 */
export async function submitPageSnapshot(
  actor: Actor,
  pageId: string,
  collab?: CollabClient
): Promise<VersionSummary> {
  assertValidUuid(pageId, 'page_not_found');
  await withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found');
    }
    await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'page_not_found' });
  });
  if (collab) {
    await collab.flush(documentName(actor.tenantId, pageId));
  }
  const created = await takePageSnapshot({
    tenantId: actor.tenantId,
    pageId,
    reason: actor.principalType === 'agent' ? 'agent' : 'submit',
    actorType: actor.principalType,
    actorId: actor.principalId,
    manual: true,
  });
  // A manual snapshot either makes a version or throws; null is the quiet path.
  if (!created) {
    throw new AppError('internal_error');
  }
  return toVersionSummary(created);
}

/**
 * POST /api/v1/pages/:id/versions/:n/restore: puts version `n`'s blocks and
 * title back as the page's live content and snapshots that as a NEW version
 * (reason `restore`; older versions are never touched). The actor must be
 * editor or higher (`requireDocumentRole`, as for a manual snapshot).
 * 404 `version_not_found` for a number the page lacks or that is not one;
 * 409 `no_changes` when the latest version already has that content (unless
 * it is withdrawn: restoring then puts the page back).
 *
 * No lock is held across the collab calls: collab's own bookkeeping takes
 * FOR KEY SHARE on the document row, so a held `lockDocument` would deadlock
 * until the call times out. The checks run in a short transaction first;
 * `takePageSnapshot` then locks, and decides review, on its own.
 */
export async function restorePageVersion(
  actor: Actor,
  pageId: string,
  params: unknown,
  collab?: CollabClient
): Promise<VersionSummary> {
  assertValidUuid(pageId, 'page_not_found');
  const parsed = RestoreVersionParamsSchema.safeParse(params);
  const target = await withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found');
    }
    await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'page_not_found' });
    if (doc.archivedAt !== null) {
      throw new AppError('page_archived');
    }
    if (!parsed.success) {
      throw new AppError('version_not_found');
    }

    const [wanted] = await tx
      .select({ title: versions.title, blocks: versions.blocks, fields: versions.fields, drawings: versions.drawings })
      .from(versions)
      .where(
        and(
          eq(versions.tenantId, actor.tenantId),
          eq(versions.documentId, pageId),
          eq(versions.number, parsed.data.n)
        )
      );
    if (!wanted) {
      throw new AppError('version_not_found');
    }
    const [latest] = await tx
      .select({ title: versions.title, blocks: versions.blocks, fields: versions.fields, drawings: versions.drawings, status: versions.status })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.documentId, pageId)))
      .orderBy(desc(versions.number))
      .limit(1);
    // A withdrawn latest version does not count: restoring it puts the page
    // back (as a manual snapshot of a withdrawn page does).
    if (
      latest &&
      latest.status !== 'withdrawn' &&
      latest.title === wanted.title &&
      isDeepStrictEqual(storedBlocks(latest.blocks), storedBlocks(wanted.blocks)) &&
      isDeepStrictEqual(latest.fields ?? null, wanted.fields ?? null) &&
      isDeepStrictEqual(latest.drawings ?? null, wanted.drawings ?? null)
    ) {
      throw new AppError('no_changes', 'The latest version already has this content.');
    }
    // Only keys that can be field ids go back (a stray key a client wrote can't be one).
    const fields = Object.fromEntries(
      Object.entries(wanted.fields && typeof wanted.fields === 'object' ? (wanted.fields as Record<string, unknown>) : {}).filter(
        ([key]) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
      )
    );
    // The version's drawing scenes come back too; drawings it didn't have are left alone (their blocks go).
    const drawings: Record<string, DrawingElement[]> = {};
    if (wanted.drawings && typeof wanted.drawings === 'object') {
      for (const [drawingId, list] of Object.entries(wanted.drawings as Record<string, unknown>)) {
        if (Array.isArray(list)) drawings[drawingId] = list.filter(isDrawingElement);
      }
    }
    // The snapshot's in-memory drawing text never goes into the live document.
    return { title: wanted.title, blocks: withoutDrawingText(storedBlocks(wanted.blocks)), fields, drawings };
  });

  // Restoring needs the live document, which only collab can change.
  if (!collab) {
    throw new AppError('internal_error');
  }
  await collab.replaceBlocks({
    tenantId: actor.tenantId,
    pageId,
    blocks: target.blocks,
    title: target.title,
    // The version's field values come back too (values of removed fields stay ignored).
    fields: target.fields,
    drawings: target.drawings,
    actor: { type: actor.principalType, id: actor.principalId },
    source: 'restore',
  });
  await collab.flush(documentName(actor.tenantId, pageId));
  const created = await takePageSnapshot({
    tenantId: actor.tenantId,
    pageId,
    reason: 'restore',
    actorType: actor.principalType,
    actorId: actor.principalId,
    manual: true,
  });
  // A manual snapshot either makes a version or throws; null is the quiet path.
  if (!created) {
    throw new AppError('internal_error');
  }
  return toVersionSummary(created);
}

/** Tells the people who wrote a version (its author and every contributor) how the review went. */
async function notifyContributors(
  tx: DbTransaction,
  actor: Actor,
  ver: { id: string; createdByType: string; createdBy: string },
  documentId: string,
  kind: 'review_approved' | 'review_rejected',
  note: string | null
) {
  const rows = await tx
    .select({ type: versionContributors.principalType, id: versionContributors.principalId })
    .from(versionContributors)
    .where(and(eq(versionContributors.tenantId, actor.tenantId), eq(versionContributors.versionId, ver.id)));
  const people = new Set(rows.filter((r) => r.type === 'user').map((r) => r.id));
  if (ver.createdByType === 'user') people.add(ver.createdBy);
  await notify(
    tx,
    actor.tenantId,
    [...people].map((recipientId) => ({
      recipientId,
      kind,
      actorType: actor.principalType,
      actorId: actor.principalId,
      documentId,
      excerpt: note,
    }))
  );
}

/** Test seam for approve and reject: `beforeLock` runs after the version was found, before its document is locked. */
export interface ReviewHooks {
  beforeLock?: () => Promise<void>;
}

/**
 * Finds the document a version belongs to (versions never change document).
 * Its own short transaction, so nothing is held while waiting for the lock.
 */
async function documentIdOfVersion(actor: Actor, versionId: string): Promise<string> {
  const [found] = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .select({ documentId: versions.documentId })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)))
  );
  if (!found) {
    throw new AppError('version_not_found');
  }
  return found.documentId;
}

/**
 * Locks the version's document (lock order everywhere: document row first,
 * then version rows), then re-reads the version under the lock. A version
 * that is not there any more is 404 `version_not_found`.
 */
async function lockReviewTarget(tx: DbTransaction, actor: Actor, versionId: string, documentId: string) {
  let doc: DocumentRow;
  try {
    doc = await lockDocument(tx, actor.tenantId, documentId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'document_not_found') {
      throw new AppError('version_not_found');
    }
    throw err;
  }
  const [ver] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.tenantId, actor.tenantId),
        eq(versions.id, versionId),
        eq(versions.documentId, documentId)
      )
    )
    .for('update');
  if (!ver) {
    throw new AppError('version_not_found');
  }
  return { doc, ver };
}

/**
 * Approves a `pending_review` version: it moves to `indexing` and its
 * `version.index` job is enqueued. Runs under the document lock and only
 * moves a version that is still `pending_review`, so a withdraw, archive or
 * move that committed first wins (409 `version_not_pending`). Access is
 * checked first (`requireDocumentRole` reviewer): a version the actor cannot
 * see is 404 `version_not_found`, a lower role (every agent: agents are capped
 * at editor) 403 `forbidden`. Only then the `self_approval` rule: unless the
 * space allows self-approval, the actor is neither its creator nor a human
 * contributor.
 */
export async function approveVersion(
  actor: Actor,
  versionId: string,
  input: unknown = {},
  hooks: ReviewHooks = {}
): Promise<VersionSummary> {
  assertValidUuid(versionId, 'version_not_found');
  const parsed = ApproveVersionRequestSchema.parse(input);

  const documentId = await documentIdOfVersion(actor, versionId);
  if (hooks.beforeLock) await hooks.beforeLock();

  return withTenantTx(actor.tenantId, async (tx) => {
    const { doc, ver } = await lockReviewTarget(tx, actor, versionId, documentId);

    // Access first, before anything about the version is revealed: a document
    // the actor cannot see is 404 version_not_found, a role below reviewer is
    // 403 forbidden. Agents are capped at editor by the gate, so they always
    // stop here (Rule 3 & S4: agents never approve).
    const { space } = await requireDocumentRole(tx, actor, doc, 'reviewer', {
      notFound: 'version_not_found',
    });

    if (ver.status !== 'pending_review') {
      throw new AppError('version_not_pending', 'Version is not waiting for review.');
    }

    const contributors = await tx
      .select()
      .from(versionContributors)
      .where(
        and(
          eq(versionContributors.tenantId, actor.tenantId),
          eq(versionContributors.versionId, ver.id)
        )
      );

    if (!canApprove(actor, ver, contributors, space)) {
      throw new AppError('self_approval', 'Authors cannot approve their own snapshots unless self-approval is enabled on the space.');
    }

    const reviewedAt = new Date();
    const updatedRows = await tx
      .update(versions)
      .set({
        status: 'indexing',
        reviewedBy: actor.principalId,
        reviewedAt,
        reviewNote: parsed.review_note ?? null,
      })
      .where(
        and(
          eq(versions.tenantId, actor.tenantId),
          eq(versions.id, ver.id),
          eq(versions.status, 'pending_review')
        )
      )
      .returning();
    if (updatedRows.length !== 1) {
      throw new AppError('version_not_pending', 'Version is not waiting for review.');
    }
    const [updatedVer] = updatedRows;

    // Clear agent_changed_at ONLY when no agent change happened after the approved snapshot was taken
    if (doc.kind === 'page') {
      const [page] = await tx
        .select()
        .from(pages)
        .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, doc.id)));

      if (page?.agentChangedAt && page.agentChangedAt <= ver.createdAt) {
        await tx
          .update(pages)
          .set({ agentChangedAt: null })
          .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, doc.id)));
      }
    }

    await enqueueJob(tx, {
      tenantId: actor.tenantId,
      queue: 'version.index',
      idempotencyKey: `index:${ver.id}`,
      payload: { versionId: ver.id },
    });

    await notifyContributors(tx, actor, ver, doc.id, 'review_approved', parsed.review_note ?? null);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'version.approved',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number },
    });

    return toVersionSummary(updatedVer);
  });
}

/**
 * Rejects a `pending_review` version (reviewer or higher). Same lock order and
 * `pending_review` guard as approve.
 */
export async function rejectVersion(
  actor: Actor,
  versionId: string,
  input: unknown,
  hooks: ReviewHooks = {}
): Promise<VersionSummary> {
  assertValidUuid(versionId, 'version_not_found');
  const parsed = RejectVersionRequestSchema.parse(input);

  const documentId = await documentIdOfVersion(actor, versionId);
  if (hooks.beforeLock) await hooks.beforeLock();

  return withTenantTx(actor.tenantId, async (tx) => {
    const { doc, ver } = await lockReviewTarget(tx, actor, versionId, documentId);

    // Access first (404 version_not_found for a document the actor cannot
    // see, 403 forbidden below reviewer; agents are capped at editor).
    await requireDocumentRole(tx, actor, doc, 'reviewer', { notFound: 'version_not_found' });

    if (ver.status !== 'pending_review') {
      throw new AppError('version_not_pending', 'Version is not waiting for review.');
    }

    const updatedRows = await tx
      .update(versions)
      .set({
        status: 'rejected',
        reviewedBy: actor.principalId,
        reviewedAt: new Date(),
        reviewNote: parsed.review_note,
      })
      .where(
        and(
          eq(versions.tenantId, actor.tenantId),
          eq(versions.id, ver.id),
          eq(versions.status, 'pending_review')
        )
      )
      .returning();
    if (updatedRows.length !== 1) {
      throw new AppError('version_not_pending', 'Version is not waiting for review.');
    }
    const [updated] = updatedRows;

    await notifyContributors(tx, actor, ver, doc.id, 'review_rejected', parsed.review_note ?? null);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'version.rejected',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number, reviewNote: parsed.review_note },
    });

    return toVersionSummary(updated);
  });
}

/**
 * Retries indexing of a `failed` version: back to `indexing` (error cleared),
 * the keyed `version.index` job re-enqueued (the upsert revives a
 * dead-lettered job with attempts reset) and `version.retried` audited.
 * Editor or higher on the document's space. Any other status is 409
 * `version_not_failed`; an archived document is 409 `page_archived`. The document row is locked first so the retry is
 * serialised with indexing, archive, withdraw and move.
 */
export async function retryVersion(actor: Actor, versionId: string): Promise<RetryVersionResponse> {
  assertValidUuid(versionId, 'version_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const [found] = await tx
      .select({ documentId: versions.documentId })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)));
    if (!found) {
      throw new AppError('version_not_found');
    }

    let doc: DocumentRow;
    try {
      doc = await lockDocument(tx, actor.tenantId, found.documentId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'document_not_found') {
        throw new AppError('version_not_found');
      }
      throw err;
    }
    await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'version_not_found' });
    if (doc.archivedAt) {
      throw doc.kind === 'file'
        ? new AppError('page_archived', 'This file is archived. Restore it before making changes.')
        : new AppError('page_archived', 'Page is archived.');
    }

    const [ver] = await tx
      .select({
        id: versions.id,
        number: versions.number,
        status: versions.status,
        extractedKey: versions.extractedKey,
      })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)))
      .for('update');
    if (!ver) {
      throw new AppError('version_not_found');
    }
    if (ver.status !== 'failed') {
      throw new AppError('version_not_failed');
    }

    // A file whose text was never read goes back to extraction; everything else to indexing.
    const reextract = doc.kind === 'file' && ver.extractedKey === null;

    const [updated] = await tx
      .update(versions)
      .set({ status: reextract ? 'extracting' : 'indexing', error: null })
      .where(
        and(
          eq(versions.tenantId, actor.tenantId),
          eq(versions.id, ver.id),
          eq(versions.status, 'failed')
        )
      )
      .returning({ ...versionSummaryColumns, documentId: versions.documentId });

    await enqueueJob(tx, {
      tenantId: actor.tenantId,
      queue: reextract ? 'file.extract' : 'version.index',
      idempotencyKey: `${reextract ? 'extract' : 'index'}:${ver.id}`,
      payload: { versionId: ver.id },
    });

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'version.retried',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number },
    });

    return { ...toVersionSummary(updated), documentId: updated.documentId };
  });
}

/**
 * Locks the page's document row (the first statement of every writer that
 * changes what a page publishes, so index, withdraw, archive and move run one
 * after another per document) and returns it. Unknown, other-tenant and
 * non-page documents answer 404 `page_not_found`.
 */
export async function lockPage(tx: DbTransaction, tenantId: string, pageId: string): Promise<DocumentRow> {
  let doc: DocumentRow;
  try {
    doc = await lockDocument(tx, tenantId, pageId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'document_not_found') {
      throw new AppError('page_not_found');
    }
    throw err;
  }
  if (doc.kind !== 'page') {
    throw new AppError('page_not_found');
  }
  return doc;
}

/**
 * Renames a page (editor): the live title in the collab document changes, so
 * the page screen shows the new name at once and the next snapshot indexes it
 * (the title is part of the indexed text, so a rename is a content change).
 * The tree's copy of the title is updated here too, so the sidebar shows the
 * new name without waiting for that snapshot.
 *
 * The collab call runs before the document lock is taken: collab's authorship
 * bookkeeping takes a share lock on the same row, so the two would wait for
 * each other.
 */
export async function renamePage(
  actor: Actor,
  pageId: string,
  input: unknown,
  collab?: CollabClient
): Promise<DocumentSummary> {
  assertValidUuid(pageId, 'page_not_found');
  const parsed = UpdatePageRequestSchema.parse(input);
  const hasTitle = parsed.title !== undefined;
  if (hasTitle && !collab) throw new AppError('internal_error');

  // Access and state first, in their own short transaction (no lock held while
  // collab works on the same row).
  await withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));
    if (!doc || doc.kind !== 'page') throw new AppError('page_not_found');
    await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'page_not_found' });
    if (doc.archivedAt) throw new AppError('page_archived');
  });

  if (hasTitle) {
    await collab!.setTitle({
      tenantId: actor.tenantId,
      pageId,
      title: parsed.title!,
      actor: { type: actor.principalType === 'agent' ? 'agent' : 'user', id: actor.principalId },
    });
  }

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);
    const [updated] = await tx
      .update(documents)
      .set({
        ...(hasTitle ? { title: parsed.title } : {}),
        ...(parsed.icon !== undefined ? { icon: parsed.icon } : {}),
      })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'page.renamed',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'page',
      subjectId: pageId,
      payload: {
        previousTitle: doc.title,
        title: updated.title,
        ...(parsed.icon !== undefined ? { icon: parsed.icon } : {}),
      },
    });
    return toDocumentSummary(updated);
  });
}

/**
 * Moves a page (editor on both the source and the target space). Same-space
 * moves change only parent and position. A cross-space move into a review
 * space by someone who is not a reviewer or admin there sends the page back to
 * review (see `returnToReview`); any other cross-space move updates
 * `chunks.space_id` and `chunks.inbox_owner` in place; `pages.slug_scope`
 * follows the target space (409 `slug_taken` on a collision). Refuses a
 * target parent that is not a live page in the target space the actor can see
 * (404 `parent_not_found`), a cycle (409 `parent_cycle`) and archived pages
 * (409 `page_archived`).
 */
export async function movePage(
  actor: Actor,
  pageId: string,
  input: unknown
): Promise<DocumentSummary> {
  assertValidUuid(pageId, 'page_not_found');
  const parsed = MovePageRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    // Access before any state check, so a page the actor cannot see is 404
    // whatever its state.
    await requireDocumentRole(tx, actor, doc, 'editor', { notFound: 'page_not_found' });
    if (doc.archivedAt) {
      throw new AppError('page_archived', 'Page is archived.');
    }
    const { space: targetSpace, effectiveRole: targetRole } = await requireSpaceRole(
      tx,
      actor,
      parsed.target_space_id,
      'editor',
      // Share-locked: see SpaceRoleOptions.lock (a live page must not land in a
      // space that is being archived).
      { lock: 'share' }
    );
    // Moving into the Inbox keeps the document's creator, so afterwards only
    // the creator and tenant owners and admins see it (as `chunks.inbox_owner`
    // does). Anyone else would lose sight of the page and could probe the
    // creator's private slugs through `slug_taken`: 403 (the actor can see
    // the page, so this reveals nothing).
    if (
      targetSpace.kind === 'inbox' &&
      !isTenantAdmin(actor) &&
      !(doc.createdByType === actor.principalType && doc.createdBy === actor.principalId)
    ) {
      throw new AppError('forbidden', 'Only the creator of a page can move it into the Inbox.');
    }

    if (parsed.target_parent_id) {
      if (parsed.target_parent_id === pageId) {
        throw new AppError('parent_cycle', 'Cannot move a page under itself.');
      }
      await requireVisibleParent(tx, actor, parsed.target_parent_id, parsed.target_space_id);
      if (await wouldCreateCycle(tx, actor.tenantId, pageId, parsed.target_parent_id)) {
        throw new AppError('parent_cycle', 'Moving this page under one of its descendants would create a cycle.');
      }
    }

    const crossSpace = doc.spaceId !== parsed.target_space_id;
    const isTargetReviewer = targetRole === 'reviewer' || targetRole === 'admin';
    let nextIndexedVersionId = doc.indexedVersionId;

    if (crossSpace) {
      if (targetSpace.reviewRequired && !isTargetReviewer) {
        await returnToReview(tx, actor.tenantId, doc);
        nextIndexedVersionId = null;
      } else {
        // Inbox visibility moves with the chunks: set to the document's creator
        // when entering the Inbox, cleared when leaving it.
        await tx
          .update(chunks)
          .set({
            spaceId: parsed.target_space_id,
            inboxOwner: chunkInboxOwner(targetSpace.kind, doc),
          })
          .where(and(eq(chunks.tenantId, actor.tenantId), eq(chunks.documentId, pageId)));
        await movePlacementIndex(tx, actor.tenantId, doc, { spaceId: parsed.target_space_id, kind: targetSpace.kind });
      }
    }

    const [updatedDoc] = await tx
      .update(documents)
      .set({
        spaceId: parsed.target_space_id,
        parentId: parsed.target_parent_id,
        position: parsed.position,
        placement: 'pinned',
        indexedVersionId: nextIndexedVersionId,
      })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)))
      .returning();

    if (crossSpace) {
      // The slug scope follows the space: the document's creator in the
      // Inbox, '' elsewhere. A slug already used in the target scope violates
      // pages_space_slug_idx -> 409 slug_taken (mapDbError). Into the Inbox
      // only the creator or a tenant admin gets here (checked above), so the
      // scope is the creator's own and a collision reveals nothing.
      await tx
        .update(pages)
        .set({ spaceId: parsed.target_space_id, slugScope: pageSlugScope(targetSpace.kind, doc) })
        .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));
    }

    // Under a collection or not decides the page's field header in the index.
    if (doc.parentId !== parsed.target_parent_id && doc.indexedVersionId) {
      const wasRow = doc.parentId !== null && (await isCollection(tx, actor.tenantId, doc.parentId));
      const isRow = parsed.target_parent_id !== null && (await isCollection(tx, actor.tenantId, parsed.target_parent_id));
      if (wasRow || isRow) await enqueueReindex(tx, actor.tenantId, [pageId]);
    }

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'page.moved',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'page',
      subjectId: pageId,
      payload: {
        fromSpaceId: doc.spaceId,
        toSpaceId: parsed.target_space_id,
        parentId: parsed.target_parent_id,
      },
    });

    return toDocumentSummary(updatedDoc);
  });
}

/**
 * Archives a page (space admin): refused with 409 `has_children` while any
 * non-archived child document exists; otherwise every indexed, indexing or
 * pending version is withdrawn, the chunks are deleted and `archived_at` set,
 * all in one transaction under the document lock.
 */
export async function archivePage(actor: Actor, pageId: string): Promise<DocumentSummary> {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    await requireDocumentRole(tx, actor, doc, 'admin', { notFound: 'page_not_found' });
    return toDocumentSummary(await archivePageTx(tx, actor, doc));
  });
}

/**
 * Archives a locked page as `actor` without a role check (the caller
 * decided who may): 409 `has_children` while a live child exists; its live
 * versions are withdrawn. Shared by archivePage and capture undo.
 */
export async function archivePageTx(tx: DbTransaction, actor: Actor, doc: DocumentRow): Promise<DocumentRow> {
  const pageId = doc.id;
  const [liveChild] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.parentId, pageId), isNull(documents.archivedAt)))
    .limit(1);
  if (liveChild) {
    throw new AppError('has_children', 'Cannot archive a page while active child documents exist.');
  }

  await withdrawLiveVersions(tx, actor.tenantId, pageId);

  const [updated] = await tx
    .update(documents)
    .set({ archivedAt: new Date(), indexedVersionId: null })
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)))
    .returning();

  await writeAuditEvent(tx, {
    tenantId: actor.tenantId,
    type: 'page.archived',
    actorType: actor.principalType,
    actorId: actor.principalId,
    subjectType: 'page',
    subjectId: pageId,
  });

  return updated!;
}

/**
 * Restores an archived page (space admin on the page's space). Clears
 * `archived_at`; the page's versions stay `withdrawn` (it comes back with the
 * `Withdrawn` badge and goes through review and indexing like any page). A
 * parent that is archived, or no longer a page in the same space, is dropped:
 * the page returns at the root. Restoring a page that is not archived changes
 * nothing and answers the page. Same lock as the other lifecycle writers; an
 * archived space is 409 `space_archived` (checked by the gate).
 */
export async function restorePage(actor: Actor, pageId: string): Promise<DocumentSummary> {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    // Document lock first (lockPage), then the space share lock: see SpaceRoleOptions.lock.
    await requireDocumentRole(tx, actor, doc, 'admin', {
      notFound: 'page_not_found',
      lock: 'share',
    });

    if (!doc.archivedAt) {
      return toDocumentSummary(doc);
    }

    let parentId = doc.parentId;
    if (parentId) {
      const [parent] = await tx
        .select({
          spaceId: documents.spaceId,
          kind: documents.kind,
          archivedAt: documents.archivedAt,
        })
        .from(documents)
        .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, parentId)));
      if (
        !parent ||
        parent.archivedAt !== null ||
        parent.kind !== 'page' ||
        parent.spaceId !== doc.spaceId
      ) {
        parentId = null;
      }
    }

    const [updated] = await tx
      .update(documents)
      .set({ archivedAt: null, parentId })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)))
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'page.restored',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'page',
      subjectId: pageId,
      payload: { parentId },
    });

    return toDocumentSummary(updated);
  });
}

/**
 * Withdraws a page from the index (reviewer; no approval needed): every
 * indexed, indexing or pending version becomes `withdrawn`, the chunks are
 * deleted and `indexed_version_id` cleared, in one transaction under the
 * document lock, so search stops returning it immediately.
 */
export async function withdrawPage(actor: Actor, pageId: string): Promise<DocumentSummary> {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    await requireDocumentRole(tx, actor, doc, 'reviewer', { notFound: 'page_not_found' });

    await withdrawLiveVersions(tx, actor.tenantId, pageId);

    const [updated] = await tx
      .update(documents)
      .set({ indexedVersionId: null })
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)))
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'page.withdrawn',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'page',
      subjectId: pageId,
    });

    return toDocumentSummary(updated);
  });
}

/**
 * Issues a short-lived collab (live editing) token for a page. Readable pages
 * only, checked exactly like getPageDetails (archived pages included); the
 * token carries `write` only for effective space role editor or higher in a
 * space that is not archived. The
 * collab server re-reads the role from the database on connect.
 */
export async function issueCollabToken(actor: Actor, pageId: string): Promise<CollabTokenResponse> {
  assertValidUuid(pageId, 'page_not_found');

  const { access, documentId } = await withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));

    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found');
    }

    const { space, effectiveRole } = await requireDocumentRole(tx, actor, doc, 'viewer', {
      notFound: 'page_not_found',
    });
    // An archived space is read-only for everyone, tenant admins included.
    const canWrite = effectiveRole !== 'viewer' && space.archivedAt === null;
    return {
      documentId: doc.id,
      access: canWrite ? ('write' as const) : ('read' as const),
    };
  });

  const now = new Date();
  const token = signCollabToken(
    {
      tenantId: actor.tenantId,
      pageId: documentId,
      principalType: actor.principalType,
      principalId: actor.principalId,
      access,
    },
    getCollabTokenSecret(),
    now
  );
  return {
    token,
    // Same second-resolution expiry the token itself carries.
    expiresAt: new Date((Math.floor(now.getTime() / 1000) + COLLAB_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    access,
  };
}
