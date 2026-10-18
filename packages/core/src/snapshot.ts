import { createHash } from 'node:crypto';
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
  links,
  enqueueJob,
  writeAuditEvent,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';

const editor = ServerBlockNoteEditor.create();

export async function takePageSnapshot(params: {
  tenantId: string;
  pageId: string;
  reason: 'quiet' | 'submit' | 'agent' | 'restore';
  actorType: 'user' | 'agent';
  actorId: string;
  manual: boolean;
}) {
  const { tenantId, pageId, reason, actorType, actorId, manual } = params;

  return withTenantTx(tenantId, async (tx) => {
    const [pageRow] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    const [docRow] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));

    if (!pageRow || !docRow) {
      throw new AppError('page_not_found', 'Page not found.');
    }

    const [spaceRow] = await tx
      .select()
      .from(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, docRow.spaceId)));

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, pageRow.ydocState);

    const blocks = editor.yDocToBlocks(ydoc, 'document-store');
    const markdown = (await editor.blocksToMarkdownLossy(blocks)).trim();

    if (!markdown) {
      if (manual) {
        throw new AppError('empty_file', 'Page body cannot be empty.');
      }
      return null;
    }

    const title = ydoc.getMap('meta').get('title')?.toString() || docRow.title;
    // Rule 11: The title is part of the indexed text, so a rename is a content change
    const indexedPayload = `# ${title}\n\n${markdown}`;
    const contentHash = createHash('sha256').update(indexedPayload, 'utf8').digest('hex');

    const existingVersions = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, pageId)))
      .orderBy(desc(versions.number));

    const latestVersion = existingVersions[0] ?? null;

    if (latestVersion && latestVersion.contentHash === contentHash) {
      if (manual) {
        throw new AppError('no_changes', 'No changes since the latest snapshot.');
      }
      return latestVersion;
    }

    // Supersede any existing pending_review snapshot so reviewers always review the newest state
    if (latestVersion && latestVersion.status === 'pending_review') {
      await tx
        .update(versions)
        .set({ status: 'superseded' })
        .where(and(eq(versions.tenantId, tenantId), eq(versions.id, latestVersion.id)));
    }

    const nextNumber = (latestVersion?.number ?? 0) + 1;
    const needsReview =
      spaceRow.reviewRequired || pageRow.agentChangedAt !== null || actorType === 'agent';
    const initialStatus = needsReview ? 'pending_review' : 'indexing';

    const [newVersion] = await tx
      .insert(versions)
      .values({
        tenantId,
        documentId: pageId,
        number: nextNumber,
        title,
        status: initialStatus,
        contentHash,
        reason,
        createdByType: actorType,
        createdBy: actorId,
        markdown,
        blocks,
        ydocSnapshot: pageRow.ydocState,
      })
      .returning();

    // Record version_contributors from block_activity since previous snapshot
    const activities = await tx
      .select()
      .from(blockActivity)
      .where(and(eq(blockActivity.tenantId, tenantId), eq(blockActivity.pageId, pageId)));

    const contributorsMap = new Map<string, { principalType: 'user' | 'agent'; principalId: string }>();
    contributorsMap.set(`${actorType}:${actorId}`, {
      principalType: actorType,
      principalId: actorId,
    });
    for (const act of activities) {
      contributorsMap.set(`${act.actorType}:${act.actorId}`, {
        principalType: act.actorType as 'user' | 'agent',
        principalId: act.actorId,
      });
    }

    for (const contributor of contributorsMap.values()) {
      await tx
        .insert(versionContributors)
        .values({
          tenantId,
          versionId: newVersion.id,
          principalType: contributor.principalType,
          principalId: contributor.principalId,
        })
        .onConflictDoUpdate({
          target: [
            versionContributors.tenantId,
            versionContributors.versionId,
            versionContributors.principalType,
            versionContributors.principalId,
          ],
          set: { principalId: contributor.principalId },
        });
    }

    // Rebuild internal wiki links ([[target-doc-id]]) from blocks
    await tx
      .delete(links)
      .where(and(eq(links.tenantId, tenantId), eq(links.fromPageId, pageId)));

    const wikiLinkRegex = /\[\[([0-9a-f-]{36})\]\]/gi;
    for (const blk of blocks as Array<{ id: string; content?: string }>) {
      const textContent = typeof blk.content === 'string' ? blk.content : JSON.stringify(blk);
      let match: RegExpExecArray | null;
      while ((match = wikiLinkRegex.exec(textContent)) !== null) {
        await tx.insert(links).values({
          tenantId,
          fromPageId: pageId,
          fromBlockId: blk.id ?? 'root',
          toDocumentId: match[1],
          kind: 'link',
        });
      }
    }

    await tx
      .update(documents)
      .set({ title, latestVersionId: newVersion.id })
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));

    await tx
      .update(pages)
      .set({ liveChangedSinceSnapshot: false })
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    await writeAuditEvent(tx, {
      tenantId,
      type: 'version.created',
      actorType,
      actorId,
      subjectType: 'version',
      subjectId: newVersion.id,
      payload: { documentId: pageId, number: nextNumber, status: initialStatus, reason },
    });

    if (initialStatus === 'indexing') {
      await enqueueJob(tx, {
        tenantId,
        queue: 'version.index',
        idempotencyKey: `index:${newVersion.id}`,
        payload: { versionId: newVersion.id },
      });
    }

    return newVersion;
  });
}
