import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import { agents, documents, spaces, suggestions, versions, withTenantTx, writeAuditEvent } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { senderAccess, type Actor, type VersionRow } from '@kinote/core';
import type { CollabClient, ObjectStorage } from '@kinote/shared';
import { loadFileChunks } from '@kinote/core';
import { approveVersion, rejectVersion } from '../../routes/pages.js';
import { listReviewQueue } from '../../routes/reviews.js';
import { acceptSuggestion, declineSuggestion, suggestionDecidable } from '../../routes/suggestions.js';
import { proposerNames, suggestionField, toSuggestionSummary } from '../../routes/captures.js';

/** One thing waiting for the owner in the review panel. */
export interface ReviewPanelItem {
  type: 'version' | 'suggestion';
  id: string;
  page: { id: string; title: string; space: string };
  kind: 'version' | 'remove' | 'replace' | 'insert' | 'set_field' | 'archive';
  proposer: { type: 'user' | 'agent'; name: string };
  created_at: string;
  reason: string | null;
  /** Markdown: the indexed page, or the addressed block / field value. */
  before: string | null;
  /** Markdown: the waiting version, or the proposed block / value; null for a delete request. */
  after: string | null;
  /** A delete request only: the page's live sub-pages. */
  sub_pages?: number;
  /** A file version: its name, sizes and links (and image previews); `before`/`after` hold its text when both versions have some. */
  file?: ReviewFileInfo;
  /** False: the owner may see it but someone else decides it (`why_not` says why). */
  decidable: boolean;
  why_not?: string;
}

export interface ReviewFileSide {
  version: number;
  size: number;
  url: string | null;
}
export interface ReviewFileInfo {
  name: string;
  mime: string;
  after: ReviewFileSide;
  /** The published version it would replace; null for a file's first version. */
  before: ReviewFileSide | null;
  /** `data:` URLs, for images of at most 256 KiB only. */
  preview: { before: string | null; after: string | null };
}
/** What file items need: storage for text and previews, and a download link per version (null: none). */
export interface ReviewFileDeps {
  storage?: ObjectStorage;
  link?: (versionId: string) => string | null;
}

export const MAX_ITEMS = 50;
const PREVIEW_BYTES = 256 * 1024;
const PREVIEW_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CLIP = 20_000;
const NOT_YOURS = 'You worked on this, so someone else approves it.';
const YOUR_AGENT = 'Your agent proposed this, so someone else decides it.';
const GONE = 'This is no longer waiting for you here. Refresh the list.';
/** A version rejected from the panel without a note (a rejection needs one). */
export const DEFAULT_REJECT_NOTE = 'Rejected in the AI client.';

function clip(text: string | null): string | null {
  if (text === null || text.length <= CLIP) return text;
  return `${text.slice(0, CLIP)}… (${text.length - CLIP} more characters)`;
}

/**
 * What `owner` can review, oldest first, at most 50: the waiting versions of the review queue and the open
 * suggestions on pages the owner can edit. `pageId` keeps one page; `agentId` keeps what that agent proposed;
 * `spaceIds` keeps those spaces (the agent's own reach: the panel never shows what the agent could not read).
 * In a space that requires review (without self-approval), what the owner's own agents wrote is someone
 * else's to decide, versions as suggestions.
 */
export async function reviewItems(
  owner: Actor,
  opts: { pageId?: string; agentId?: string; spaceIds?: readonly string[]; files?: ReviewFileDeps }
): Promise<ReviewPanelItem[]> {
  const queue = await listReviewQueue(owner, {});
  const inScope = (spaceId: string) => opts.spaceIds === undefined || opts.spaceIds.includes(spaceId);
  const out: ReviewPanelItem[] = [];

  const waiting = queue.filter(
    (q) =>
      inScope(q.document.spaceId) &&
      (opts.pageId === undefined || q.document.id === opts.pageId) &&
      (opts.agentId === undefined ||
        (q.version.createdByType === 'agent' && q.version.createdBy === opts.agentId) ||
        q.contributors.some((c) => c.type === 'agent' && c.id === opts.agentId))
  );

  await withTenantTx(owner.tenantId, async (tx) => {
    if (waiting.length > 0) {
      const docIds = waiting.map((q) => q.document.id);
      const indexedOf = new Map(
        (
          await tx
            .select({ id: documents.id, kind: documents.kind, indexed: documents.indexedVersionId, published: documents.publishedVersionId })
            .from(documents)
            .where(and(eq(documents.tenantId, owner.tenantId), inArray(documents.id, docIds)))
        ).map((d) => [d.id, d.kind === 'file' ? d.published : d.indexed])
      );
      const versionIds = [...waiting.map((q) => q.version.id), ...[...indexedOf.values()].filter((v): v is string => v !== null)];
      const versionRows = await tx
        .select()
        .from(versions)
        .where(and(eq(versions.tenantId, owner.tenantId), inArray(versions.id, versionIds)));
      const rowOf = new Map(versionRows.map((v) => [v.id, v]));
      const markdownOf = new Map(versionRows.map((v) => [v.id, v.markdown ?? '']));
      const strictSpaces = new Set(
        (
          await tx
            .select({ id: spaces.id })
            .from(spaces)
            .where(
              and(
                eq(spaces.tenantId, owner.tenantId),
                inArray(spaces.id, [...new Set(waiting.map((q) => q.document.spaceId))]),
                eq(spaces.reviewRequired, true),
                eq(spaces.allowSelfApproval, false)
              )
            )
        ).map((r) => r.id)
      );
      const ownAgents = new Set(
        (
          await tx
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.tenantId, owner.tenantId), eq(agents.createdBy, owner.principalId)))
        ).map((a) => a.id)
      );
      for (const q of waiting) {
        const indexed = indexedOf.get(q.document.id) ?? null;
        const byOwnAgent =
          strictSpaces.has(q.document.spaceId) &&
          ((q.version.createdByType === 'agent' && ownAgents.has(q.version.createdBy)) ||
            q.contributors.some((c) => c.type === 'agent' && ownAgents.has(c.id)));
        const why = !q.canApprove ? NOT_YOURS : byOwnAgent ? YOUR_AGENT : null;
        if (q.document.kind === 'file') {
          const after = rowOf.get(q.version.id);
          if (!after) continue;
          const before = indexed ? (rowOf.get(indexed) ?? null) : null;
          const file = await fileItem(owner.tenantId, after, before, opts.files ?? {});
          out.push({
            type: 'version',
            id: q.version.id,
            page: { id: q.document.id, title: q.document.title, space: q.document.spaceName },
            kind: 'version',
            proposer: { type: q.version.createdByType === 'user' ? 'user' : 'agent', name: q.version.createdByName },
            created_at: q.version.createdAt,
            reason: null,
            before: file.text.before,
            after: file.text.after,
            file: file.info,
            decidable: why === null,
            ...(why === null ? {} : { why_not: why }),
          });
          continue;
        }
        out.push({
          type: 'version',
          id: q.version.id,
          page: { id: q.document.id, title: q.document.title, space: q.document.spaceName },
          kind: 'version',
          proposer: { type: q.version.createdByType === 'user' ? 'user' : 'agent', name: q.version.createdByName },
          created_at: q.version.createdAt,
          reason: null,
          before: clip(indexed ? (markdownOf.get(indexed) ?? '') : ''),
          after: clip(markdownOf.get(q.version.id) ?? ''),
          decidable: why === null,
          ...(why === null ? {} : { why_not: why }),
        });
      }
    }

    const editable = (await senderAccess(tx, owner)).editable.filter(inScope);
    if (editable.length === 0) return;
    const rows = await tx
      .select({ s: suggestions, title: documents.title, spaceName: spaces.name })
      .from(suggestions)
      .innerJoin(documents, and(eq(documents.tenantId, suggestions.tenantId), eq(documents.id, suggestions.documentId)))
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .where(
        and(
          eq(suggestions.tenantId, owner.tenantId),
          eq(suggestions.status, 'open'),
          isNull(documents.archivedAt),
          inArray(documents.spaceId, editable),
          ...(opts.pageId !== undefined ? [eq(suggestions.documentId, opts.pageId)] : []),
          ...(opts.agentId !== undefined ? [eq(suggestions.proposedByType, 'agent'), eq(suggestions.proposedBy, opts.agentId)] : [])
        )
      )
      .orderBy(asc(suggestions.createdAt))
      .limit(MAX_ITEMS);
    const proposers = await proposerNames(tx, owner.tenantId, rows.map((r) => r.s));
    for (const { s: row, title, spaceName } of rows) {
      const summary = toSuggestionSummary(row, null, await suggestionField(tx, owner.tenantId, row), proposers);
      const can = await suggestionDecidable(tx, owner, row.id);
      let subPages: number | undefined;
      if (row.kind === 'archive') {
        const [c] = await tx
          .select({ n: count() })
          .from(documents)
          .where(and(eq(documents.tenantId, owner.tenantId), eq(documents.parentId, row.documentId), isNull(documents.archivedAt)));
        subPages = Number(c?.n ?? 0);
      }
      out.push({
        type: 'suggestion',
        id: row.id,
        page: { id: row.documentId, title, space: spaceName },
        kind: row.kind,
        proposer: summary.proposedBy ? { type: summary.proposedBy.type, name: summary.proposedBy.name } : { type: 'agent', name: 'the routing engine' },
        created_at: summary.createdAt,
        reason: row.reason,
        before: clip(summary.field ? summary.field.before : row.kind === 'insert' || row.kind === 'archive' ? null : row.expectedText),
        after: clip(summary.field ? summary.field.after : row.kind === 'remove' ? null : row.proposedMarkdown),
        ...(subPages !== undefined ? { sub_pages: subPages } : {}),
        decidable: can.ok,
        ...(can.ok ? {} : { why_not: can.why }),
      });
    }
  });

  return out.sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, MAX_ITEMS);
}

/** A file version's extracted text (its chunks, in order), or null when it has none or it can't be read. */
async function fileText(storage: ObjectStorage | undefined, tenantId: string, v: VersionRow): Promise<string | null> {
  if (!storage || v.noText || !v.extractedKey) return null;
  try {
    const { chunks } = await loadFileChunks(storage, tenantId, { title: v.fileName ?? '', extractedKey: v.extractedKey });
    return chunks.map((c) => c.text).join('\n\n');
  } catch {
    return null;
  }
}

async function preview(storage: ObjectStorage | undefined, tenantId: string, v: VersionRow): Promise<string | null> {
  if (!storage || !v.objectKey || !v.mimeType || !PREVIEW_MIME.has(v.mimeType) || (v.sizeBytes ?? Infinity) > PREVIEW_BYTES) return null;
  try {
    const { bytes } = await storage.get(tenantId, v.objectKey);
    return `data:${v.mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}

/** The file part of a waiting file version's item: the published version it would replace, sizes, links, previews, text. */
async function fileItem(tenantId: string, after: VersionRow, before: VersionRow | null, deps: ReviewFileDeps) {
  const side = (v: VersionRow): ReviewFileSide => ({ version: v.number, size: v.sizeBytes ?? 0, url: deps.link?.(v.id) ?? null });
  const [textAfter, textBefore, previewAfter, previewBefore] = await Promise.all([
    fileText(deps.storage, tenantId, after),
    before ? fileText(deps.storage, tenantId, before) : Promise.resolve(null),
    preview(deps.storage, tenantId, after),
    before ? preview(deps.storage, tenantId, before) : Promise.resolve(null),
  ]);
  // Text is shown as a diff only when both sides have it (a first version: the new text against nothing).
  const both = textAfter !== null && (before === null || textBefore !== null);
  return {
    info: {
      name: after.fileName ?? 'file',
      mime: after.mimeType ?? 'application/octet-stream',
      after: side(after),
      before: before ? side(before) : null,
      preview: { before: previewBefore, after: previewAfter },
    } satisfies ReviewFileInfo,
    text: { before: both ? clip(textBefore ?? '') : null, after: both ? clip(textAfter) : null },
  };
}

export type ReviewDecision = { type: 'version' | 'suggestion'; id: string; decision: 'approve' | 'reject'; note?: string };
export type DecideResult = { ok: true; status: string } | { ok: false; message: string };

/**
 * Approves or rejects one item as `owner`, through the same routes as the web app. A refusal (someone else
 * decides it, it was already decided, the owner lost access) is `{ ok: false, message }`, never thrown.
 */
export async function decideReviewItem(
  owner: Actor,
  input: ReviewDecision,
  collab: CollabClient,
  audit: { agentId?: string; spaceIds?: readonly string[] } = {}
): Promise<DecideResult> {
  // Only what the panel would list: in the agent's reach, still waiting, and the owner's to decide.
  const [where] = await withTenantTx(owner.tenantId, (tx) =>
    input.type === 'version'
      ? tx.select({ pageId: versions.documentId }).from(versions).where(and(eq(versions.tenantId, owner.tenantId), eq(versions.id, input.id)))
      : tx.select({ pageId: suggestions.documentId }).from(suggestions).where(and(eq(suggestions.tenantId, owner.tenantId), eq(suggestions.id, input.id)))
  ).catch(() => [] as Array<{ pageId: string }>);
  if (!where) return { ok: false, message: GONE };
  const item = (await reviewItems(owner, { pageId: where.pageId, ...(audit.spaceIds ? { spaceIds: audit.spaceIds } : {}) })).find(
    (i) => i.type === input.type && i.id === input.id
  );
  if (!item) return { ok: false, message: GONE };
  if (!item.decidable) return { ok: false, message: item.why_not ?? GONE };
  let status: string;
  try {
    if (input.type === 'version') {
      const note = input.note?.trim();
      const res =
        input.decision === 'approve'
          ? await approveVersion(owner, input.id, note ? { review_note: note } : {})
          : await rejectVersion(owner, input.id, { review_note: note || DEFAULT_REJECT_NOTE });
      status = res.status;
    } else {
      const res = input.decision === 'approve' ? await acceptSuggestion(owner, input.id, collab) : await declineSuggestion(owner, input.id);
      status = res.status;
    }
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
  await withTenantTx(owner.tenantId, (tx) =>
    writeAuditEvent(tx, {
      tenantId: owner.tenantId,
      type: 'review.decided_in_client',
      actorType: owner.principalType,
      actorId: owner.principalId,
      subjectType: input.type,
      subjectId: input.id,
      payload: { via: 'mcp_app', agentId: audit.agentId ?? null, decision: input.decision, status },
    })
  );
  return { ok: true, status };
}
