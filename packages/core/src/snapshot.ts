import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
  lockDocument,
  type DbTransaction,
  type DocumentRow,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { flattenBlocks, type BlockLike } from '@living-wiki/shared';

const editor = ServerBlockNoteEditor.create();

const WIKI_LINK = /\[\[([0-9a-f-]{36})\]\]/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The `[[document-id]]` links of a page's blocks (nested children included),
 * one per (block, target), self-links and malformed ids dropped. Ids are
 * lower-cased so they compare equal to what Postgres returns.
 */
export function extractWikiLinks(
  blocks: BlockLike[],
  pageId: string
): Array<{ blockId: string; targetId: string }> {
  const self = pageId.toLowerCase();
  const seen = new Set<string>();
  const out: Array<{ blockId: string; targetId: string }> = [];
  for (const block of flattenBlocks(blocks)) {
    for (const match of block.text.matchAll(WIKI_LINK)) {
      const targetId = match[1]!.toLowerCase();
      if (!UUID.test(targetId) || targetId === self) continue;
      const key = `${block.id}\u0000${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ blockId: block.id, targetId });
    }
  }
  return out;
}

export interface TakePageSnapshotHooks {
  /**
   * Test seam: runs inside the snapshot transaction, under the document lock,
   * right after the page row is read (the last of the rows the snapshot
   * decides on: document, space, latest version, page).
   */
  afterRead?: (tx: DbTransaction) => Promise<void>;
}

/**
 * Snapshots a page's live state as a new version. Takes the document lock
 * first (lock order everywhere: document row, then version rows), so the
 * space a concurrent move put the page in is the one that decides review,
 * and withdraw, approve and indexing run before or after it, never between.
 * The page is marked "not changed since snapshot" only if no live change
 * landed after its row was read.
 */
export async function takePageSnapshot(
  params: {
    tenantId: string;
    pageId: string;
    reason: 'quiet' | 'submit' | 'agent' | 'restore';
    actorType: 'user' | 'agent';
    actorId: string;
    manual: boolean;
  },
  hooks: TakePageSnapshotHooks = {}
) {
  const { tenantId, pageId, reason, actorType, actorId, manual } = params;

  return withTenantTx(tenantId, async (tx) => {
    let docRow: DocumentRow;
    try {
      docRow = await lockDocument(tx, tenantId, pageId);
    } catch (err) {
      if (err instanceof AppError && err.code === 'document_not_found') {
        throw new AppError('page_not_found', 'Page not found.');
      }
      throw err;
    }

    const [spaceRow] = await tx
      .select()
      .from(spaces)
      .where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, docRow.spaceId)));

    const [latestVersion = null] = await tx
      .select()
      .from(versions)
      .where(and(eq(versions.tenantId, tenantId), eq(versions.documentId, pageId)))
      .orderBy(desc(versions.number))
      .limit(1);

    // live_updated_at as text keeps Postgres' microseconds (a JS Date would
    // round them away and never compare equal again).
    const [pageRow] = await tx
      .select({
        ydocState: pages.ydocState,
        agentChangedAt: pages.agentChangedAt,
        liveUpdatedAt: sql<string>`${pages.liveUpdatedAt}::text`,
      })
      .from(pages)
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));

    if (!pageRow || !spaceRow) {
      throw new AppError('page_not_found', 'Page not found.');
    }

    if (hooks.afterRead) await hooks.afterRead(tx);

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

    if (latestVersion && latestVersion.contentHash === contentHash) {
      if (manual) {
        throw new AppError('no_changes', 'No changes since the latest snapshot.');
      }
      return latestVersion;
    }

    // Supersede any existing pending_review snapshot so reviewers always review
    // the newest state. Only a version still pending: never a withdrawn one.
    if (latestVersion && latestVersion.status === 'pending_review') {
      await tx
        .update(versions)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(versions.tenantId, tenantId),
            eq(versions.id, latestVersion.id),
            eq(versions.status, 'pending_review')
          )
        );
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

    // Only targets that exist as documents of this tenant are recorded: an
    // unknown id (or another tenant's) is plain text, not a failed snapshot.
    const found = extractWikiLinks(blocks as BlockLike[], pageId);
    if (found.length > 0) {
      const targetIds = [...new Set(found.map((l) => l.targetId))];
      const existing = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, targetIds)));
      const known = new Set(existing.map((d) => d.id));
      const rows = found
        .filter((l) => known.has(l.targetId))
        .map((l) => ({
          tenantId,
          fromPageId: pageId,
          fromBlockId: l.blockId,
          toDocumentId: l.targetId,
          kind: 'link' as const,
        }));
      if (rows.length > 0) await tx.insert(links).values(rows);
    }

    await tx
      .update(documents)
      .set({ title, latestVersionId: newVersion.id })
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));

    // A live change that landed after the page row was read moved
    // live_updated_at on, so the page stays "changed since" this snapshot.
    await tx
      .update(pages)
      .set({ liveChangedSinceSnapshot: false })
      .where(
        and(
          eq(pages.tenantId, tenantId),
          eq(pages.documentId, pageId),
          sql`${pages.liveUpdatedAt} = ${pageRow.liveUpdatedAt}::timestamptz`
        )
      );

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
