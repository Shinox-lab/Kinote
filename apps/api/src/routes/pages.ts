import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { and, desc, eq } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  pages,
  spaces,
  versions,
  versionContributors,
  blockActivity,
  chunks,
  enqueueJob,
  writeAuditEvent,
} from '@living-wiki/db';
import {
  CreatePageRequestSchema,
  MovePageRequestSchema,
  ApproveVersionRequestSchema,
  RejectVersionRequestSchema,
  AppError,
} from '@living-wiki/contracts';
import { requireSpaceRole, assertValidUuid, type Actor } from '@living-wiki/core';
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

export async function movePage(actor: Actor, pageId: string, input: unknown) {
  assertValidUuid(pageId, 'page_not_found');
  const parsed = MovePageRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));

    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found', 'Page not found.');
    }
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

    // Check parent_cycle if target_parent_id is provided
    if (parsed.target_parent_id) {
      if (parsed.target_parent_id === pageId) {
        throw new AppError('parent_cycle', 'Cannot move a page under itself.');
      }
      const allDocs = await tx
        .select()
        .from(documents)
        .where(eq(documents.tenantId, actor.tenantId));

      const parentById = new Map(allDocs.map((d) => [d.id, d]));
      const targetParent = parentById.get(parsed.target_parent_id);
      if (
        !targetParent ||
        targetParent.spaceId !== parsed.target_space_id ||
        targetParent.kind !== 'page' ||
        targetParent.archivedAt !== null
      ) {
        throw new AppError('parent_not_found', 'Target parent page not found.');
      }

      let cursor: string | null = targetParent.parentId;
      while (cursor) {
        if (cursor === pageId) {
          throw new AppError('parent_cycle', 'Moving this page under one of its descendants would create a cycle.');
        }
        cursor = parentById.get(cursor)?.parentId ?? null;
      }
    }

    const crossSpace = doc.spaceId !== parsed.target_space_id;
    const isTargetReviewer = targetRole === 'reviewer' || targetRole === 'admin';

    let nextIndexedVersionId = doc.indexedVersionId;

    // Moving across spaces updates chunks.space_id in the same transaction;
    // Moving into a review space returns indexed version to pending_review (and deletes chunks)
    // unless the mover is a reviewer of the target space.
    if (crossSpace) {
      if (targetSpace.reviewRequired && !isTargetReviewer && doc.indexedVersionId) {
        await tx
          .update(versions)
          .set({ status: 'pending_review', indexedAt: null })
          .where(
            and(
              eq(versions.tenantId, actor.tenantId),
              eq(versions.id, doc.indexedVersionId)
            )
          );
        await tx
          .delete(chunks)
          .where(and(eq(chunks.tenantId, actor.tenantId), eq(chunks.documentId, pageId)));
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

    await tx
      .update(pages)
      .set({ spaceId: parsed.target_space_id })
      .where(and(eq(pages.tenantId, actor.tenantId), eq(pages.documentId, pageId)));

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

export async function archivePage(actor: Actor, pageId: string) {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));

    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found', 'Page not found.');
    }

    await requireSpaceRole(tx, actor, doc.spaceId, 'admin');

    const children = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.parentId, pageId)));

    if (children.some((c) => !c.archivedAt)) {
      throw new AppError('has_children', 'Cannot archive a page while active child documents exist.');
    }

    if (doc.indexedVersionId) {
      await tx
        .update(versions)
        .set({ status: 'withdrawn' })
        .where(
          and(eq(versions.tenantId, actor.tenantId), eq(versions.id, doc.indexedVersionId))
        );
    }

    await tx
      .delete(chunks)
      .where(and(eq(chunks.tenantId, actor.tenantId), eq(chunks.documentId, pageId)));

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

export async function withdrawPage(actor: Actor, pageId: string) {
  assertValidUuid(pageId, 'page_not_found');

  return withTenantTx(actor.tenantId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, pageId)));

    if (!doc || doc.kind !== 'page') {
      throw new AppError('page_not_found', 'Page not found.');
    }

    await requireSpaceRole(tx, actor, doc.spaceId, 'reviewer');

    if (doc.latestVersionId) {
      await tx
        .update(versions)
        .set({ status: 'withdrawn' })
        .where(
          and(eq(versions.tenantId, actor.tenantId), eq(versions.id, doc.latestVersionId))
        );
    }

    await tx
      .delete(chunks)
      .where(and(eq(chunks.tenantId, actor.tenantId), eq(chunks.documentId, pageId)));

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
