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
  AppError,
  type RetryVersionResponse,
} from '@living-wiki/contracts';
import { requireSpaceRole, assertValidUuid, takePageSnapshot, type Actor } from '@living-wiki/core';
import { signCollabToken, getCollabTokenSecret, COLLAB_TOKEN_TTL_SECONDS } from '@living-wiki/shared';
import { computePageBadge } from '../pages/badge.js';

const blockNote = ServerBlockNoteEditor.create();

export async function encodePageYDoc(title: string, markdown: string): Promise<Buffer> {
  const blocks = await blockNote.tryParseMarkdownToBlocks(markdown);
  const ydoc = blockNote.blocksToYDoc(blocks, 'document-store');
  ydoc.getMap('meta').set('title', title);
  return Buffer.from(Y.encodeStateAsUpdate(ydoc));
}

export async function createPage(actor: Actor, input: unknown) {
  const parsed = CreatePageRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    await requireSpaceRole(tx, actor, parsed.space_id, 'editor');

    if (parsed.parent_id) {
      assertValidUuid(parsed.parent_id, 'parent_not_found');
      const [parentDoc] = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, actor.tenantId),
            eq(documents.id, parsed.parent_id)
          )
        );
      if (
        !parentDoc ||
        parentDoc.spaceId !== parsed.space_id ||
        parentDoc.kind !== 'page' ||
        parentDoc.archivedAt !== null
      ) {
        throw new AppError('parent_not_found', 'Parent is not a live page in the same space.');
      }
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
        ydocState: initialYdocState,
        liveChangedSinceSnapshot: parsed.markdown.trim().length > 0,
        agentChangedAt: actor.principalType === 'agent' ? new Date() : null,
      })
      .returning();

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
      throw new AppError('page_not_found', 'Page not found.');
    }

    const { space } = await requireSpaceRole(tx, actor, doc.spaceId, 'viewer');

    const [page] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));

    const pageVersions = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.documentId, pageId)))
      .orderBy(desc(versions.number));

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
 * explicit snapshot). The actor must be able to read the page.
 */
export async function submitPageSnapshot(actor: Actor, pageId: string) {
  await getPageDetails(actor, pageId);
  return takePageSnapshot({
    tenantId: actor.tenantId,
    pageId,
    reason: actor.principalType === 'agent' ? 'agent' : 'submit',
    actorType: actor.principalType,
    actorId: actor.principalId,
    manual: true,
  });
}

export async function approveVersion(actor: Actor, versionId: string, input: unknown = {}) {
  assertValidUuid(versionId, 'version_not_found');
  const parsed = ApproveVersionRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const [ver] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)));

    if (!ver) {
      throw new AppError('version_not_found', 'Version not found.');
    }

    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, ver.documentId)));

    if (!doc) {
      throw new AppError('document_not_found', 'Document not found.');
    }

    // Rule 3 & S4: Agents can never approve; user must hold reviewer or admin in the space
    if (actor.principalType === 'agent') {
      throw new AppError('self_approval', 'Agents cannot approve snapshots.');
    }

    const { space } = await requireSpaceRole(tx, actor, doc.spaceId, 'reviewer');

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
    const [updatedVer] = await tx
      .update(versions)
      .set({
        status: 'indexing',
        reviewedBy: actor.principalId,
        reviewedAt,
        reviewNote: parsed.review_note ?? null,
      })
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, ver.id)))
      .returning();

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

export async function rejectVersion(actor: Actor, versionId: string, input: unknown) {
  assertValidUuid(versionId, 'version_not_found');
  const parsed = RejectVersionRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const [ver] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)));

    if (!ver) {
      throw new AppError('version_not_found', 'Version not found.');
    }

    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, ver.documentId)));

    await requireSpaceRole(tx, actor, doc.spaceId, 'reviewer');

    if (ver.status !== 'pending_review') {
      throw new AppError('version_not_pending', 'Version is not waiting for review.');
    }

    const [updated] = await tx
      .update(versions)
      .set({
        status: 'rejected',
        reviewedBy: actor.principalId,
        reviewedAt: new Date(),
        reviewNote: parsed.review_note,
      })
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, ver.id)))
      .returning();

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
 * `version_not_failed`. The document row is locked first so the retry is
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
      throw new AppError('version_not_found', 'Version not found.');
    }

    const doc = await lockDocument(tx, actor.tenantId, found.documentId);
    await requireSpaceRole(tx, actor, doc.spaceId, 'editor');

    const [ver] = await tx
      .select({ id: versions.id, number: versions.number, status: versions.status })
      .from(versions)
      .where(and(eq(versions.tenantId, actor.tenantId), eq(versions.id, versionId)))
      .for('update');
    if (!ver) {
      throw new AppError('version_not_found', 'Version not found.');
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
      .returning({
        id: versions.id,
        documentId: versions.documentId,
        number: versions.number,
        status: versions.status,
        error: versions.error,
      });

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

    return RetryVersionResponseSchema.parse(updated);
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
      throw new AppError('page_not_found', 'Page not found.');
    }
    throw err;
  }
  if (doc.kind !== 'page') {
    throw new AppError('page_not_found', 'Page not found.');
  }
  return doc;
}

/**
 * Takes a document out of the index (Rule 9: removing is fast): every version
 * that is indexed, indexing or waiting for review becomes `withdrawn` and the
 * document's chunks are deleted. The caller holds the document lock and clears
 * `indexed_version_id`.
 */
async function withdrawLiveVersions(tx: DbTransaction, tenantId: string, documentId: string) {
  await tx
    .update(versions)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, documentId),
        inArray(versions.status, ['indexed', 'indexing', 'pending_review'])
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
 * the index and exactly one version is left waiting for review. A newer
 * pending version (the latest, not the indexed one) stays the one to review
 * and the indexed and indexing versions become `superseded`; otherwise the
 * newest of the indexed and indexing versions returns to `pending_review` and
 * any older one is superseded. The caller holds the document lock and clears
 * `indexed_version_id`.
 */
async function returnToReview(tx: DbTransaction, tenantId: string, doc: DocumentRow) {
  const candidates = await tx
    .select({ id: versions.id, number: versions.number, status: versions.status })
    .from(versions)
    .where(
      and(
        eq(versions.tenantId, tenantId),
        eq(versions.documentId, doc.id),
        inArray(versions.status, ['indexed', 'indexing', 'pending_review'])
      )
    )
    .orderBy(desc(versions.number));

  const latestPending = candidates.find(
    (v) => v.id === doc.latestVersionId && v.status === 'pending_review' && v.id !== doc.indexedVersionId
  );
  const live = candidates.filter((v) => v.status === 'indexed' || v.status === 'indexing');
  const keep = latestPending ? null : live[0] ?? null;
  const supersede = live.filter((v) => v.id !== keep?.id).map((v) => v.id);

  if (keep) {
    await tx
      .update(versions)
      .set({ status: 'pending_review', indexedAt: null })
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
 * `chunks.space_id` in place. Refuses a target parent that is not a live page
 * in the target space (404 `parent_not_found`), a cycle (409 `parent_cycle`)
 * and archived pages (409 `page_archived`).
 */
export async function movePage(actor: Actor, pageId: string, input: unknown) {
  assertValidUuid(pageId, 'page_not_found');
  const parsed = MovePageRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);
    if (doc.archivedAt) {
      throw new AppError('page_archived', 'Page is archived.');
    }

    await requireSpaceRole(tx, actor, doc.spaceId, 'editor');
    const { space: targetSpace, effectiveRole: targetRole } = await requireSpaceRole(
      tx,
      actor,
      parsed.target_space_id,
      'editor'
    );

    if (parsed.target_parent_id) {
      if (parsed.target_parent_id === pageId) {
        throw new AppError('parent_cycle', 'Cannot move a page under itself.');
      }
      const [targetParent] = await tx
        .select({
          id: documents.id,
          spaceId: documents.spaceId,
          kind: documents.kind,
          archivedAt: documents.archivedAt,
        })
        .from(documents)
        .where(
          and(eq(documents.tenantId, actor.tenantId), eq(documents.id, parsed.target_parent_id))
        );
      if (
        !targetParent ||
        targetParent.spaceId !== parsed.target_space_id ||
        targetParent.kind !== 'page' ||
        targetParent.archivedAt !== null
      ) {
        throw new AppError('parent_not_found', 'Target parent page not found.');
      }
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
        await tx
          .update(chunks)
          .set({ spaceId: parsed.target_space_id })
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
      await tx
        .update(pages)
        .set({ spaceId: parsed.target_space_id })
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

    await requireSpaceRole(tx, actor, doc.spaceId, 'admin');

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
 * Withdraws a page from the index (reviewer; no approval needed): every
 * indexed, indexing or pending version becomes `withdrawn`, the chunks are
 * deleted and `indexed_version_id` cleared, in one transaction under the
 * document lock, so search stops returning it immediately.
 */
export async function withdrawPage(actor: Actor, pageId: string) {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const doc = await lockPage(tx, actor.tenantId, pageId);

    await requireSpaceRole(tx, actor, doc.spaceId, 'reviewer');

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
 * token carries `write` only for effective space role editor or higher. The
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
      throw new AppError('page_not_found', 'Page not found.');
    }

    const { effectiveRole } = await requireSpaceRole(tx, actor, doc.spaceId, 'viewer');
    return {
      documentId: doc.id,
      access: effectiveRole === 'viewer' ? ('read' as const) : ('write' as const),
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
