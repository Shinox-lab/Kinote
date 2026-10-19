import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  withTenantTx,
  rowsOf,
  documents,
  pages,
  spaces,
  versions,
  versionContributors,
  pagePendingContributors,
  blockActivity,
  chunks,
  enqueueJob,
  writeAuditEvent,
  lockDocument,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import {
  CreatePageRequestSchema,
  MovePageRequestSchema,
  ApproveVersionRequestSchema,
  RejectVersionRequestSchema,
  CollabTokenResponseSchema,
  RetryVersionResponseSchema,
  VersionSummarySchema,
  AppError,
  type RetryVersionResponse,
  type VersionSummary,
} from '@living-wiki/contracts';
import {
  requireSpaceRole,
  requireDocumentRole,
  assertValidUuid,
  takePageSnapshot,
  chunkInboxOwner,
  pageSlugScope,
  isTenantAdmin,
  type Actor,
} from '@living-wiki/core';
import {
  signCollabToken,
  getCollabTokenSecret,
  documentName,
  COLLAB_TOKEN_TTL_SECONDS,
} from '@living-wiki/shared';
import { computePageBadge } from '../pages/badge.js';
import type { CollabClient } from '../collab/client.js';

const blockNote = ServerBlockNoteEditor.create();

/** The `versions` columns a VersionSummary is built from (no markdown, blocks or Yjs bytes). */
const versionSummaryColumns = {
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

type VersionSummaryRow = {
  [K in keyof typeof versionSummaryColumns]: (typeof versions.$inferSelect)[K];
};

/** A version row (or its summary columns) as the published VersionSummary. */
function toVersionSummary(row: VersionSummaryRow): VersionSummary {
  return VersionSummarySchema.parse({
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
  });
}

export async function encodePageYDoc(title: string, markdown: string): Promise<Buffer> {
  const blocks = await blockNote.tryParseMarkdownToBlocks(markdown);
  const ydoc = blockNote.blocksToYDoc(blocks, 'document-store');
  ydoc.getMap('meta').set('title', title);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

/**
 * Checks that `parentId` is a live page in `spaceId` that the actor can see,
 * or throws 404 `parent_not_found`. Visibility includes the Inbox rule, so
 * another member's Inbox item behaves exactly like a nonexistent parent (same
 * status, code and message) and can never get children it does not know of.
 */
async function requireVisibleParent(
  tx: DbTransaction,
  actor: Actor,
  parentId: string,
  spaceId: string
): Promise<void> {
  assertValidUuid(parentId, 'parent_not_found');
  const [parentDoc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, parentId)));
  if (
    !parentDoc ||
    parentDoc.spaceId !== spaceId ||
    parentDoc.kind !== 'page' ||
    parentDoc.archivedAt !== null
  ) {
    throw new AppError('parent_not_found');
  }
  await requireDocumentRole(tx, actor, parentDoc, 'viewer', { notFound: 'parent_not_found' });
}

export async function createPage(actor: Actor, input: unknown) {
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

    return { document: doc, page };
  });
}

export async function getPageDetails(actor: Actor, pageId: string) {
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
      badge,
      liveMarkdown,
      liveBlocks,
      liveChangedSinceSnapshot: page.liveChangedSinceSnapshot,
      agentChangedAt: page.agentChangedAt,
      archivedAt: doc.archivedAt,
      latestVersion,
      indexedVersion,
      versions: pageVersions,
      blockActivity: activity,
    };
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
export async function submitPageSnapshot(actor: Actor, pageId: string, collab?: CollabClient) {
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
  return takePageSnapshot({
    tenantId: actor.tenantId,
    pageId,
    reason: actor.principalType === 'agent' ? 'agent' : 'submit',
    actorType: actor.principalType,
    actorId: actor.principalId,
    manual: true,
  });
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
) {
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

    const isCreator =
      ver.createdByType === actor.principalType && ver.createdBy === actor.principalId;
    const isHumanContributor = contributors.some(
      (c) => c.principalType === 'user' && c.principalId === actor.principalId
    );

    if (!space.allowSelfApproval && (isCreator || isHumanContributor)) {
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

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'version.approved',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number },
    });

    return updatedVer;
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
) {
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

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'version.rejected',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'version',
      subjectId: ver.id,
      payload: { documentId: doc.id, number: ver.number, reviewNote: parsed.review_note },
    });

    return updated;
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
      throw new AppError('page_archived', 'Page is archived.');
    }

    const [ver] = await tx
      .select({ id: versions.id, number: versions.number, status: versions.status })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)))
      .for('update');
    if (!ver) {
      throw new AppError('version_not_found');
    }
    if (ver.status !== 'failed') {
      throw new AppError('version_not_failed');
    }

    const [updated] = await tx
      .update(versions)
      .set({ status: 'indexing', error: null })
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
      queue: 'version.index',
      idempotencyKey: `index:${ver.id}`,
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

    return RetryVersionResponseSchema.parse({
      ...toVersionSummary(updated),
      documentId: updated.documentId,
    });
  });
}

/**
 * Locks the page's document row (the first statement of every writer that
 * changes what a page publishes, so index, withdraw, archive and move run one
 * after another per document) and returns it. Unknown, other-tenant and
 * non-page documents answer 404 `page_not_found`.
 */
async function lockPage(tx: DbTransaction, tenantId: string, pageId: string): Promise<DocumentRow> {
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
 * Takes a document out of the index (Rule 9: removing is fast): every version
 * that is indexed, indexing, failed or waiting for review becomes `withdrawn`
 * and the document's chunks are deleted. `failed` is included so a withdrawn
 * page can never be revived by Retry (which only accepts `failed`). The caller
 * holds the document lock and clears `indexed_version_id`.
 */
async function withdrawLiveVersions(tx: DbTransaction, tenantId: string, documentId: string) {
  await tx
    .update(versions)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, documentId),
        inArray(versions.status, ['indexed', 'indexing', 'failed', 'pending_review'])
      )
    );
  await tx
    .delete(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)));
}

/**
 * True when `pageId` is `targetParentId` or one of its ancestors, i.e. moving
 * the page under the target parent would create a cycle. Walks up from the
 * target parent with a recursive CTE (UNION, so a corrupt cyclic chain still
 * terminates) instead of loading the tenant's documents.
 */
async function wouldCreateCycle(
  tx: DbTransaction,
  tenantId: string,
  pageId: string,
  targetParentId: string
): Promise<boolean> {
  const result = await tx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT d.id, d.parent_id
      FROM documents d
      WHERE d.tenant_id = ${tenantId}::uuid AND d.id = ${targetParentId}::uuid
      UNION
      SELECT p.id, p.parent_id
      FROM documents p
      JOIN ancestors a ON p.id = a.parent_id
      WHERE p.tenant_id = ${tenantId}::uuid
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${pageId}::uuid) AS cycle
  `);
  const [row] = rowsOf<{ cycle: boolean | string }>(result);
  return row?.cycle === true || row?.cycle === 't';
}

/**
 * Sends a document moved into a review space back to review: its chunks leave
 * the index and exactly one version is left waiting for review, so nothing it
 * held can reach the index again without a reviewer (Rule 9: adding is gated).
 *
 * "Newer pending" below means the latest version is `pending_review` and is not
 * the indexed one. "Newest live" is the highest-numbered version among the
 * indexed, indexing and failed ones.
 *
 * | status before      | newer pending exists | otherwise                                |
 * |--------------------|----------------------|------------------------------------------|
 * | `pending_review`   | stays pending        | (n/a: it would be the newer pending)     |
 * | `indexed`          | `superseded`         | `pending_review` if newest live, else `superseded` |
 * | `indexing`         | `superseded`         | `pending_review` if newest live, else `superseded` |
 * | `failed`           | `superseded`         | `pending_review` if newest live, else `superseded` |
 * | anything else      | unchanged            | unchanged                                |
 *
 * A failed version sent back to review loses its error text (Retry, which
 * only accepts `failed`, then refuses it). The caller holds the document lock
 * and clears `indexed_version_id`.
 */
async function returnToReview(tx: DbTransaction, tenantId: string, doc: DocumentRow) {
  const candidates = await tx
    .select({ id: versions.id, number: versions.number, status: versions.status })
    .from(versions)
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, doc.id),
        inArray(versions.status, ['indexed', 'indexing', 'failed', 'pending_review'])
      )
    )
    .orderBy(desc(versions.number));

  const latestPending = candidates.find(
    (v) => v.id === doc.latestVersionId && v.status === 'pending_review' && v.id !== doc.indexedVersionId
  );
  const live = candidates.filter(
    (v) => v.status === 'indexed' || v.status === 'indexing' || v.status === 'failed'
  );
  const keep = latestPending ? null : live[0] ?? null;
  const supersede = live.filter((v) => v.id !== keep?.id).map((v) => v.id);

  if (keep) {
    await tx
      .update(versions)
      .set({ status: 'pending_review', indexedAt: null, error: null })
      .where(and(eq(versions.tenantId, tenantId), eq(versions.id, keep.id)));
  }
  if (supersede.length > 0) {
    await tx
      .update(versions)
      .set({ status: 'superseded' })
      .where(and(eq(versions.tenantId, tenantId), inArray(versions.id, supersede)));
  }
  await tx
    .delete(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, doc.id)));
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
export async function movePage(actor: Actor, pageId: string, input: unknown) {
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

    return updatedDoc;
  });
}

/**
 * Archives a page (space admin): refused with 409 `has_children` while any
 * non-archived child document exists; otherwise every indexed, indexing or
 * pending version is withdrawn, the chunks are deleted and `archived_at` set,
 * all in one transaction under the document lock.
 */
export async function archivePage(actor: Actor, pageId: string) {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    await requireDocumentRole(tx, actor, doc, 'admin', { notFound: 'page_not_found' });

    const [liveChild] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, actor.tenantId),
          eq(documents.parentId, pageId),
          isNull(documents.archivedAt)
        )
      )
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

    return updated;
  });
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
export async function restorePage(actor: Actor, pageId: string) {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    // Document lock first (lockPage), then the space share lock: see SpaceRoleOptions.lock.
    await requireDocumentRole(tx, actor, doc, 'admin', {
      notFound: 'page_not_found',
      lock: 'share',
    });

    if (!doc.archivedAt) {
      return doc;
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

    return updated;
  });
}

/**
 * Withdraws a page from the index (reviewer; no approval needed): every
 * indexed, indexing or pending version becomes `withdrawn`, the chunks are
 * deleted and `indexed_version_id` cleared, in one transaction under the
 * document lock, so search stops returning it immediately.
 */
export async function withdrawPage(actor: Actor, pageId: string) {
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

    return updated;
  });
}

/**
 * Issues a short-lived collab (live editing) token for a page. Readable pages
 * only, checked exactly like getPageDetails (archived pages included); the
 * token carries `write` only for effective space role editor or higher in a
 * space that is not archived. The
 * collab server re-reads the role from the database on connect.
 */
export async function issueCollabToken(actor: Actor, pageId: string) {
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
  return CollabTokenResponseSchema.parse({
    token,
    // Same second-resolution expiry the token itself carries.
    expiresAt: new Date((Math.floor(now.getTime() / 1000) + COLLAB_TOKEN_TTL_SECONDS) * 1000).toISOString(),
    access,
  });
}
