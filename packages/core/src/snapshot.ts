import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { createServerEditor } from '@kinote/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  withTenantTx,
  documents,
  pages,
  spaces,
  versions,
  versionContributors,
  pagePendingContributors,
  links,
  enqueueJob,
  writeAuditEvent,
  lockDocument,
  type DbTransaction,
  type DocumentRow,
} from '@kinote/db';
import { AppError, FIELDS_MAP, storableFields, validFields } from '@kinote/contracts';
import { rowCollectionOf } from './collections/fields.js';
import { notify, recordPageMentions, usersWithSpaceRole } from './talk/notify.js';
import { flattenBlocks, pageLinksOf, type BlockLike } from '@kinote/shared';

const editor = createServerEditor();

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

/** JSON with object keys sorted at every level, so equal values hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
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
 * landed after its row was read. An archived page is refused: manual 409
 * `page_archived`, otherwise null (no version).
 */
export async function takePageSnapshot(
  params: {
    tenantId: string;
    pageId: string;
    reason: 'quiet' | 'submit' | 'agent' | 'restore' | 'capture';
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
        throw new AppError('page_not_found');
      }
      throw err;
    }

    // An archived page never gets a new version: checked under the document
    // lock, so an archive that committed first always wins. A manual snapshot
    // is told why (409 page_archived); a quiet snapshot just does nothing.
    if (docRow.archivedAt !== null) {
      if (manual) throw new AppError('page_archived');
      return null;
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
      throw new AppError('page_not_found');
    }

    if (hooks.afterRead) await hooks.afterRead(tx);

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, pageRow.ydocState);

    const blocks = editor.yDocToBlocks(ydoc, 'document-store');
    const markdown = (await editor.blocksToMarkdownLossy(blocks)).trim();
    // Collection field values (raw: readers check them against the fields).
    // Values Postgres can't store (a NUL) are left out, so they never fail the snapshot.
    const fieldsMap = storableFields(ydoc.getMap(FIELDS_MAP).toJSON() as Record<string, unknown>);
    const fields = Object.keys(fieldsMap).length > 0 ? fieldsMap : null;

    // A row with a value that fits one of its fields has content even with an empty body.
    let hasFieldContent = false;
    if (!markdown && fields) {
      const row = await rowCollectionOf(tx, tenantId, pageId);
      hasFieldContent = row !== null && Object.keys(validFields(row.fields, fields)).length > 0;
    }

    if (!markdown && !hasFieldContent) {
      if (manual) {
        throw new AppError('empty_file', 'Page body cannot be empty.');
      }
      return null;
    }

    const title = ydoc.getMap('meta').get('title')?.toString() || docRow.title;
    // Rule 11: The title is part of the indexed text, so a rename is a content change
    const indexedPayload = `# ${title}\n\n${markdown}`;
    // Pages without fields hash exactly as before fields existed (no new versions on upgrade).
    const hashed = fields ? `${indexedPayload}\n\n${canonicalJson(fields)}` : indexedPayload;
    const contentHash = createHash('sha256').update(hashed, 'utf8').digest('hex');

    // Same content as the latest version: nothing to snapshot. Except that a
    // manual snapshot of a WITHDRAWN latest version is how a withdrawn (or
    // archived and restored) page goes back in unchanged, so it makes a new
    // version. A quiet snapshot never undoes a withdraw on its own.
    const sameAsLatest =
      latestVersion !== null &&
      latestVersion.contentHash === contentHash &&
      !(manual && latestVersion.status === 'withdrawn');
    if (latestVersion && sameAsLatest) {
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
    // R1: review follows the space for every edit, an agent's included.
    const needsReview = spaceRow.reviewRequired;
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
        fields,
        ydocSnapshot: pageRow.ydocState,
      })
      .returning();

    // Contributors, part 1: everyone recorded as changing the page since the
    // previous snapshot (collab's bookkeeping, and the page's creator), plus
    // whoever takes this one. The pending rows are consumed here, under the
    // document lock: collab's bookkeeping takes FOR KEY SHARE on the same
    // row first, so a recording commits wholly before this reads them or
    // waits until this commits (and then counts towards the next snapshot).
    // That the consumed authors' edits are in this version's content holds
    // when the live document was stored and its bookkeeping awaited first
    // (manual snapshots flush); see `writeAttribution` in apps/collab for the
    // bounded quiet-snapshot gap.
    const pending = await tx
      .delete(pagePendingContributors)
      .where(
        and(
          eq(pagePendingContributors.tenantId, tenantId),
          eq(pagePendingContributors.pageId, pageId)
        )
      )
      .returning({
        principalType: pagePendingContributors.principalType,
        principalId: pagePendingContributors.principalId,
      });

    const contributorsMap = new Map<string, { principalType: 'user' | 'agent'; principalId: string }>();
    for (const c of [{ principalType: actorType, principalId: actorId }, ...pending]) {
      contributorsMap.set(`${c.principalType}:${c.principalId}`, c);
    }

    await tx
      .insert(versionContributors)
      .values(
        [...contributorsMap.values()].map((c) => ({
          tenantId,
          versionId: newVersion.id,
          principalType: c.principalType,
          principalId: c.principalId,
        }))
      )
      .onConflictDoNothing({
        target: [
          versionContributors.tenantId,
          versionContributors.versionId,
          versionContributors.principalType,
          versionContributors.principalId,
        ],
      });

    // Contributors, part 2: everyone who contributed to a version whose
    // content has not been approved and indexed yet (superseded, rejected,
    // still pending, approved but not yet indexed, failed) is still riding in
    // the live content, so stays a contributor until a version past them is
    // indexed. Versions after the latest indexed one only (all of them when
    // none is indexed); withdrawn versions do not carry.
    await tx.execute(sql`
      INSERT INTO version_contributors (tenant_id, version_id, principal_type, principal_id)
      SELECT DISTINCT vc.tenant_id, ${newVersion.id}::uuid, vc.principal_type, vc.principal_id
        FROM version_contributors vc
        JOIN versions v ON v.tenant_id = vc.tenant_id AND v.id = vc.version_id
       WHERE vc.tenant_id = ${tenantId}::uuid
         AND v.tenant_id = ${tenantId}::uuid
         AND v.document_id = ${pageId}::uuid
         AND v.id <> ${newVersion.id}::uuid
         AND v.status IN ('pending_review', 'superseded', 'rejected', 'failed', 'indexing')
         AND v.number > COALESCE(
               (SELECT max(i.number) FROM versions i
                 WHERE i.tenant_id = ${tenantId}::uuid
                   AND i.document_id = ${pageId}::uuid
                   AND i.status = 'indexed'),
               0)
      ON CONFLICT (tenant_id, version_id, principal_type, principal_id) DO NOTHING
    `);

    // Rebuild internal wiki links from blocks: page link nodes and the older [[target-doc-id]] text
    await tx
      .delete(links)
      .where(and(eq(links.tenantId, tenantId), eq(links.fromPageId, pageId)));

    // Only targets that exist as documents of this tenant are recorded: an
    // unknown id (or another tenant's) is plain text, not a failed snapshot.
    const self = pageId.toLowerCase();
    const seenLinks = new Set<string>();
    const found = [...pageLinksOf(blocks as BlockLike[]), ...extractWikiLinks(blocks as BlockLike[], pageId)].filter((l) => {
      const key = `${l.blockId}\u0000${l.targetId}`;
      if (l.targetId === self || seenLinks.has(key)) return false;
      seenLinks.add(key);
      return true;
    });
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

    // People newly mentioned are told; a review that starts (not one superseded by a newer draft) tells the reviewers.
    await recordPageMentions(tx, docRow, blocks as BlockLike[], { type: actorType, id: actorId });
    if (initialStatus === 'pending_review' && latestVersion?.status !== 'pending_review') {
      const reviewers = await usersWithSpaceRole(tx, tenantId, spaceRow.id, 'reviewer');
      await notify(
        tx,
        tenantId,
        reviewers.map((recipientId) => ({ recipientId, kind: 'review_requested' as const, actorType, actorId, documentId: pageId }))
      );
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
