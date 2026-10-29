import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  withTenantTx,
  captures,
  captureMessages,
  captureFacts,
  captureChanges,
  suggestions,
  citations,
  documents,
  spaces,
  versions,
  enqueueJob,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  AppError,
  AnswerCaptureRequestSchema,
  CaptureListQuerySchema,
  CreateCaptureRequestSchema,
  MAX_CAPTURE_CHARS,
  type CaptureDetail,
  type CaptureReceipt,
  type CaptureSummary,
  type SuggestionSummary,
  type FieldChange,
} from '@kinote/contracts';
import { assertValidUuid, isTenantAdmin, senderAccess, type Actor } from '@kinote/core';
import { resolveActorNames } from '../people.js';

type CaptureRow = typeof captures.$inferSelect;
type SuggestionRow = typeof suggestions.$inferSelect;

const LIST_LIMIT = 50;

type CaptureFile = CaptureSummary['file'];

export function toCaptureSummary(row: CaptureRow, senderName: string, file: CaptureFile = null): CaptureSummary {
  return {
    id: row.id,
    senderType: row.senderType,
    senderId: row.senderId,
    senderName,
    channel: row.channel,
    text: row.text,
    scopeSpaceId: row.scopeSpaceId,
    scopePageId: row.scopePageId,
    status: row.status,
    error: row.error,
    shapeMode: row.shapeMode,
    shape: row.shape,
    file,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** The files sent with captures: name and type of each file's latest version. */
async function captureFiles(tx: DbTransaction, tenantId: string, rows: CaptureRow[]): Promise<Map<string, NonNullable<CaptureFile>>> {
  const ids = [...new Set(rows.map((r) => r.fileId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: documents.id, name: documents.title, mimeType: versions.mimeType })
    .from(documents)
    .leftJoin(versions, and(eq(versions.tenantId, documents.tenantId), eq(versions.id, documents.latestVersionId)))
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, ids)));
  return new Map(found.map((f) => [f.id, { id: f.id, name: f.name, mimeType: f.mimeType ?? null }]));
}

/** Captures as the API shows them, each with its sender's display name and its file. */
export async function summaries(tx: DbTransaction, tenantId: string, rows: CaptureRow[]): Promise<CaptureSummary[]> {
  const names = await resolveActorNames(
    tx,
    tenantId,
    rows.map((r) => ({ type: r.senderType, id: r.senderId }))
  );
  const files = await captureFiles(tx, tenantId, rows);
  return rows.map((r) =>
    toCaptureSummary(r, names.get(`${r.senderType}:${r.senderId}`) ?? 'Former member', r.fileId ? files.get(r.fileId) ?? null : null)
  );
}


/**
 * The file a sender attaches: a live file in their own Inbox (404 otherwise,
 * as for any document they can't see), of a type whose text can be read.
 */
async function captureFile(tx: DbTransaction, actor: Actor, fileId: string) {
  const [row] = await tx
    .select({ doc: documents, spaceKind: spaces.kind, mimeType: versions.mimeType })
    .from(documents)
    .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
    .leftJoin(versions, and(eq(versions.tenantId, documents.tenantId), eq(versions.id, documents.latestVersionId)))
    .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, fileId)));
  const mine =
    row &&
    row.doc.kind === 'file' &&
    row.doc.archivedAt === null &&
    row.spaceKind === 'inbox' &&
    row.doc.createdByType === actor.principalType &&
    row.doc.createdBy === actor.principalId;
  if (!mine) throw new AppError('document_not_found');
  // Audio and video are only stored: there is no text to read yet.
  if (row.mimeType && /^(audio|video)\//.test(row.mimeType)) {
    throw new AppError('unsupported_file_type', "Audio and video can't be read yet.");
  }
  return row.doc;
}

function isSender(actor: Actor, row: CaptureRow): boolean {
  return row.senderType === actor.principalType && row.senderId === actor.principalId;
}

/** Puts the capture in line for routing (one at a time per tenant, R13). */
export async function enqueueCaptureRoute(tx: DbTransaction, tenantId: string, captureId: string) {
  await enqueueJob(tx, {
    tenantId,
    queue: 'capture.route',
    idempotencyKey: `capture:${captureId}`,
    payload: { captureId },
  });
}

/**
 * POST /api/v1/captures: files any text for the routing engine. The sender
 * must be able to edit at least one space outside the Inbox (403 otherwise);
 * a scope the sender cannot read, or the Inbox, is 404.
 */
export async function createCapture(actor: Actor, body: unknown): Promise<CaptureSummary> {
  const raw = (body as { text?: unknown } | null)?.text;
  if (typeof raw === 'string' && raw.trim().length > MAX_CAPTURE_CHARS) {
    throw new AppError('capture_too_long');
  }
  const parsed = CreateCaptureRequestSchema.safeParse(body);
  if (!parsed.success) throw new AppError('validation_failed');
  const { text, file_id, scope_space_id, scope_page_id, shape } = parsed.data;

  return withTenantTx(actor.tenantId, async (tx) => {
    const access = await senderAccess(tx, actor);
    if (access.editable.length === 0) {
      throw new AppError('forbidden', 'You need to be able to edit at least one space to capture.');
    }
    let scopeSpaceId = scope_space_id ?? null;
    if (scopeSpaceId && !access.readable.includes(scopeSpaceId)) throw new AppError('space_not_found');
    if (scope_page_id) {
      const [doc] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, actor.tenantId), eq(documents.id, scope_page_id)));
      if (!doc || doc.kind !== 'page' || doc.archivedAt || !access.readable.includes(doc.spaceId)) {
        throw new AppError('page_not_found');
      }
      if (scopeSpaceId && scopeSpaceId !== doc.spaceId) throw new AppError('validation_failed');
      scopeSpaceId = doc.spaceId;
    }

    if (file_id) {
      await captureFile(tx, actor, file_id);
      // One capture per file: a second would take the file from the first one's page.
      const [taken] = await tx
        .select({ id: captures.id })
        .from(captures)
        .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.fileId, file_id), ne(captures.status, 'failed')))
        .limit(1);
      if (taken) throw new AppError('capture_file_in_use');
    }

    const [row] = await tx
      .insert(captures)
      .values({
        tenantId: actor.tenantId,
        senderType: actor.principalType,
        senderId: actor.principalId,
        channel: 'console',
        text,
        scopeSpaceId,
        scopePageId: scope_page_id ?? null,
        shapeMode: shape,
        fileId: file_id ?? null,
      })
      .returning();
    await enqueueCaptureRoute(tx, actor.tenantId, row!.id);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.created',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture',
      subjectId: row!.id,
      payload: { scopeSpaceId, scopePageId: scope_page_id ?? null, length: text.length, fileId: file_id ?? null },
    });
    return (await summaries(tx, actor.tenantId, [row!]))[0]!;
  });
}

/** GET /api/v1/captures: the actor's own captures, newest first. */
export async function listCaptures(actor: Actor, query: unknown): Promise<CaptureSummary[]> {
  const parsed = CaptureListQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw new AppError('validation_failed');
  return withTenantTx(actor.tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(captures)
      .where(
        and(
          eq(captures.tenantId, actor.tenantId),
          eq(captures.senderType, actor.principalType),
          eq(captures.senderId, actor.principalId),
          parsed.data.before ? lt(captures.createdAt, new Date(parsed.data.before)) : undefined
        )
      )
      .orderBy(desc(captures.createdAt))
      .limit(LIST_LIMIT);
    return summaries(tx, actor.tenantId, rows);
  });
}

/** The capture when the actor is its sender (or, unless `senderOnly`, a tenant admin); else 404. */
export async function visibleCapture(
  tx: DbTransaction,
  actor: Actor,
  id: string,
  opts: { senderOnly?: boolean; lock?: boolean } = {}
): Promise<CaptureRow> {
  assertValidUuid(id, 'capture_not_found');
  const query = tx
    .select()
    .from(captures)
    .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, id)));
  const [row] = opts.lock ? await query.for('update') : await query;
  if (!row) throw new AppError('capture_not_found');
  if (!isSender(actor, row) && (opts.senderOnly || !isTenantAdmin(actor))) {
    throw new AppError('capture_not_found');
  }
  return row;
}

export function toSuggestionSummary(row: SuggestionRow, conflictWith: string | null, field: FieldChange | null = null): SuggestionSummary {
  return {
    id: row.id,
    documentId: row.documentId,
    kind: row.kind,
    blockId: row.blockId,
    afterBlockId: row.afterBlockId,
    proposedMarkdown: row.proposedMarkdown,
    field,
    reason: row.reason,
    blockedBy: row.blockedBy,
    conflictWith,
    status: row.status,
    captureId: row.captureId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What each conflicting citation's source is called, by citation id. */
export async function conflictNames(tx: DbTransaction, tenantId: string, rows: SuggestionRow[]) {
  const ids = rows.map((r) => r.conflictCitationId).filter((v): v is string => v !== null);
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const found = await tx
    .select({ id: citations.id, title: documents.title, number: versions.number })
    .from(citations)
    .leftJoin(documents, and(eq(documents.tenantId, citations.tenantId), eq(documents.id, citations.sourceDocumentId)))
    .leftJoin(versions, and(eq(versions.tenantId, citations.tenantId), eq(versions.id, citations.sourceVersionId)))
    .where(and(eq(citations.tenantId, tenantId), inArray(citations.id, ids)));
  for (const f of found) {
    names.set(f.id, f.title ? `${f.title}${f.number ? ` (v${f.number})` : ''}` : 'another source');
  }
  return names;
}

/**
 * The receipt of a capture as `viewer` sees it: grouped by space and page,
 * with pages in spaces the viewer cannot read only counted.
 */
export async function captureReceipt(tx: DbTransaction, viewer: Actor, captureId: string): Promise<CaptureReceipt> {
  const { readable } = await senderAccess(tx, viewer);
  const visible = new Set(readable);
  const [capture] = await tx
    .select()
    .from(captures)
    .where(and(eq(captures.tenantId, viewer.tenantId), eq(captures.id, captureId)));
  // A document capture's own page is shown as the receipt's lead, not among the pages it updated.
  const documentPageId = capture?.shape === 'document' ? capture.documentPageId : null;

  const changes = await tx
    .select({
      change: captureChanges,
      reason: captureFacts.reason,
      title: documents.title,
      spaceName: spaces.name,
      versionStatus: versions.status,
    })
    .from(captureChanges)
    .leftJoin(captureFacts, and(eq(captureFacts.tenantId, captureChanges.tenantId), eq(captureFacts.id, captureChanges.factId)))
    .innerJoin(documents, and(eq(documents.tenantId, captureChanges.tenantId), eq(documents.id, captureChanges.documentId)))
    .innerJoin(spaces, and(eq(spaces.tenantId, captureChanges.tenantId), eq(spaces.id, captureChanges.spaceId)))
    .leftJoin(versions, and(eq(versions.tenantId, captureChanges.tenantId), eq(versions.id, captureChanges.versionId)))
    .where(and(eq(captureChanges.tenantId, viewer.tenantId), eq(captureChanges.captureId, captureId)))
    .orderBy(captureChanges.createdAt);
  const proposed = await tx
    .select({ suggestion: suggestions, title: documents.title, spaceName: spaces.name })
    .from(suggestions)
    .innerJoin(documents, and(eq(documents.tenantId, suggestions.tenantId), eq(documents.id, suggestions.documentId)))
    .innerJoin(spaces, and(eq(spaces.tenantId, suggestions.tenantId), eq(spaces.id, suggestions.spaceId)))
    .where(and(eq(suggestions.tenantId, viewer.tenantId), eq(suggestions.captureId, captureId)))
    .orderBy(suggestions.createdAt);
  const names = await conflictNames(tx, viewer.tenantId, proposed.map((p) => p.suggestion));
  const facts = await tx
    .select()
    .from(captureFacts)
    .where(and(eq(captureFacts.tenantId, viewer.tenantId), eq(captureFacts.captureId, captureId)))
    .orderBy(captureFacts.ordinal);

  type Page = CaptureReceipt['spaces'][number]['pages'][number] & { waiting: boolean };
  const bySpace = new Map<string, { spaceId: string; spaceName: string; pages: Map<string, Page> }>();
  let hiddenChanges = 0;
  const pageOf = (spaceId: string, spaceName: string, documentId: string, title: string): Page | null => {
    if (!visible.has(spaceId)) {
      hiddenChanges += 1;
      return null;
    }
    let space = bySpace.get(spaceId);
    if (!space) bySpace.set(spaceId, (space = { spaceId, spaceName, pages: new Map() }));
    let page = space.pages.get(documentId);
    if (!page) {
      space.pages.set(
        documentId,
        (page = { documentId, title, outcome: 'suggestion', changes: [], suggestions: [], waiting: false })
      );
    }
    return page;
  };

  let document: CaptureReceipt['document'] = null;
  if (capture?.shape === 'document' && capture.documentOutcome) {
    if (documentPageId) {
      const own = changes.filter((c) => c.change.documentId === documentPageId);
      const [page] = await tx
        .select({ title: documents.title, spaceId: documents.spaceId, parentId: documents.parentId, spaceName: spaces.name })
        .from(documents)
        .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
        .where(and(eq(documents.tenantId, viewer.tenantId), eq(documents.id, documentPageId)));
      if (page && visible.has(page.spaceId)) {
        const [parent] = page.parentId
          ? await tx
              .select({ title: documents.title })
              .from(documents)
              .where(and(eq(documents.tenantId, viewer.tenantId), eq(documents.id, page.parentId)))
          : [];
        document = {
          pageId: documentPageId,
          title: page.title,
          outcome: 'created',
          parentTitle: parent?.title ?? null,
          spaceName: page.spaceName,
          reason: null,
          changeIds: own.filter((c) => c.change.status === 'applied').map((c) => c.change.id),
        };
      } else if (page) {
        hiddenChanges += own.length > 0 ? 1 : 0;
      }
    } else {
      document = {
        pageId: null,
        title: capture.documentTitle ?? '',
        outcome: capture.documentOutcome,
        parentTitle: null,
        spaceName: null,
        reason: capture.documentReason,
        changeIds: [],
      };
    }
  }

  for (const c of changes) {
    if (documentPageId && c.change.documentId === documentPageId) continue;
    const page = pageOf(c.change.spaceId, c.spaceName, c.change.documentId, c.title);
    if (!page) continue;
    page.changes.push({
      id: c.change.id,
      factId: c.change.factId,
      documentId: c.change.documentId,
      op: c.change.op,
      blockId: c.change.blockId,
      beforeMarkdown: c.change.beforeMarkdown,
      afterMarkdown: c.change.afterMarkdown,
      status: c.change.status,
      reason: c.reason,
      field: null,
    });
    if (c.versionStatus === 'pending_review') page.waiting = true;
  }
  for (const p of proposed) {
    const page = pageOf(p.suggestion.spaceId, p.spaceName, p.suggestion.documentId, p.title);
    if (!page) continue;
    page.suggestions.push(
      toSuggestionSummary(p.suggestion, p.suggestion.conflictCitationId ? names.get(p.suggestion.conflictCitationId) ?? null : null)
    );
  }

  return {
    spaces: [...bySpace.values()].map((s) => ({
      spaceId: s.spaceId,
      spaceName: s.spaceName,
      pages: [...s.pages.values()].map(({ waiting, ...page }) => ({
        ...page,
        outcome: waiting ? 'waiting_review' : page.changes.length > 0 ? 'applied' : 'suggestion',
      })),
    })),
    hiddenChanges,
    alreadyKnown: facts.filter((f) => f.outcome === 'already_known').map((f) => ({ factId: f.id, statement: f.statement })),
    needsHome: facts
      .filter((f) => f.outcome === 'needs_home')
      .map((f) => ({ factId: f.id, statement: f.statement, reason: f.reason })),
    document,
    filedInDocument: facts
      .filter((f) => f.outcome === 'filed_in_document')
      .map((f) => ({ factId: f.id, statement: f.statement })),
  };
}

async function captureDetail(tx: DbTransaction, actor: Actor, row: CaptureRow): Promise<CaptureDetail> {
  const thread = await tx
    .select()
    .from(captureMessages)
    .where(and(eq(captureMessages.tenantId, actor.tenantId), eq(captureMessages.captureId, row.id)))
    .orderBy(captureMessages.createdAt);
  return {
    capture: (await summaries(tx, actor.tenantId, [row]))[0]!,
    thread: thread.map((m) => ({
      id: m.id,
      author: m.author,
      body: m.body,
      options: (m.options as Array<{ entityId: string; label: string }> | null) ?? null,
      answersMessageId: m.answersMessageId,
      choice: m.choice,
      createdAt: m.createdAt.toISOString(),
    })),
    receipt: await captureReceipt(tx, actor, row.id),
  };
}

/** GET /api/v1/captures/:id: the sender or a tenant admin; anyone else 404. */
export async function getCapture(actor: Actor, id: string): Promise<CaptureDetail> {
  return withTenantTx(actor.tenantId, async (tx) => captureDetail(tx, actor, await visibleCapture(tx, actor, id)));
}

/**
 * POST /api/v1/captures/:id/answer: the sender picks one of the options an
 * engine question offered. The facts waiting on it are routed again with the
 * chosen entity pinned. 409 `capture_not_waiting` when that question waits
 * for nothing.
 */
export async function answerCapture(actor: Actor, id: string, body: unknown): Promise<CaptureDetail> {
  const parsed = AnswerCaptureRequestSchema.safeParse(body);
  return withTenantTx(actor.tenantId, async (tx) => {
    const row = await visibleCapture(tx, actor, id, { senderOnly: true, lock: true });
    if (!parsed.success) throw new AppError('validation_failed');
    const { message_id, choice } = parsed.data;

    const [question] = await tx
      .select()
      .from(captureMessages)
      .where(
        and(
          eq(captureMessages.tenantId, actor.tenantId),
          eq(captureMessages.captureId, row.id),
          eq(captureMessages.id, message_id),
          eq(captureMessages.author, 'engine')
        )
      );
    const waiting = question
      ? await tx
          .select({ id: captureFacts.id })
          .from(captureFacts)
          .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.waitingQuestionId, question.id)))
      : [];
    if (!question || waiting.length === 0) throw new AppError('capture_not_waiting');
    const option = ((question.options as Array<{ entityId: string; label: string }> | null) ?? []).find(
      (o) => o.entityId === choice
    );
    if (!option) throw new AppError('validation_failed', 'Pick one of the options offered.');

    await tx.insert(captureMessages).values({
      tenantId: actor.tenantId,
      captureId: row.id,
      author: 'sender',
      body: option.label,
      answersMessageId: question.id,
      choice,
    });
    await tx
      .update(captureFacts)
      .set({
        outcome: 'pending',
        waitingQuestionId: null,
        pinnedEntityIds: sql`array_append(${captureFacts.pinnedEntityIds}, ${choice}::uuid)`,
      })
      .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.waitingQuestionId, question.id)));
    const [updated] = await tx
      .update(captures)
      .set({ status: 'queued', finishedAt: null })
      .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, row.id)))
      .returning();
    await enqueueCaptureRoute(tx, actor.tenantId, row.id);
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'capture.answered',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'capture',
      subjectId: row.id,
      payload: { questionId: question.id, choice },
    });
    return captureDetail(tx, actor, updated!);
  });
}
