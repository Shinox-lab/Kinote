import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  withTenantTx,
  acquireRoutingLease,
  releaseRoutingLease,
  blockActivity,
  captureChanges,
  captureFacts,
  captureMessages,
  captures,
  citations,
  documents,
  pagePendingContributors,
  pages,
  spaces,
  suggestions,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { documentName, type BlockLike, type CollabClient } from '@kinote/shared';
import type { EmbeddingProvider } from '../embedding.js';
import type { RoutingModel } from '../placement/model.js';
import { takePageSnapshot } from '../snapshot.js';
import { blockMarkdown, encodeBlocksYDoc, markdownBlocks, readLiveBlocks } from './liveBlocks.js';
import { decideShape, planCapture, splitCaptureText, type CheckedEdit, type Gate, type PlannedFact } from './plan.js';
import { planDocument, uniqueChildTitle } from './document.js';
import { attachCaptureFile, fileTitle, routedText } from './captureFile.js';
import { excerptOf, hasUnreadAbout, notify } from '../talk/notify.js';
import { ensureRouterAgent } from './routerAgent.js';

/** How long one routing run may hold the tenant's lease (R13). */
export const ROUTING_LEASE_SECONDS = 300;
/** An engine question unanswered this long sends its facts to Needs a home. */
export const QUESTION_TTL_DAYS = 7;

export interface RouteDeps {
  model: RoutingModel;
  embedder: EmbeddingProvider;
  collab: CollabClient;
  now?: Date;
  /** Test seam: runs after planning, before anything is applied. */
  hooks?: { afterPlan?: () => Promise<void> };
  /** Throws when the run may no longer change anything (it lost the tenant's lease). */
  guard?: () => Promise<void>;
}

type FactResult = { applied: Array<'indexing' | 'pending_review' | 'other'>; suggested: number };

interface Item {
  factId: string;
  statement: string;
  checked: CheckedEdit;
}

/**
 * Routes one capture: plans it, then applies what may be applied (one
 * collab change and one snapshot per page), turns the rest into suggestions,
 * and records the receipt. Holds the tenant's routing lease throughout;
 * `busy` when another run holds it (the caller tries again later).
 */
export async function routeCapture(
  params: { tenantId: string; captureId: string; holder: string },
  deps: RouteDeps
): Promise<'done' | 'waiting_for_answer' | 'busy'> {
  const { tenantId, captureId, holder } = params;
  const now = deps.now ?? new Date();
  const got = await withTenantTx(tenantId, (tx) => acquireRoutingLease(tx, tenantId, holder, ROUTING_LEASE_SECONDS));
  if (!got) return 'busy';
  const guard = leaseGuard(tenantId, holder);
  try {
    await expireQuestions(tenantId, now);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(captures)
        .set({ status: 'routing', error: null })
        .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)))
    );
    let capture = await ensureSplit(tenantId, captureId, { ...deps, guard });
    if (capture.shape === 'document') {
      // Waiting for a person to choose where the page goes: the facts wait with it.
      if (capture.documentOutcome === 'needs_home') return await finishCapture(tenantId, captureId);
      if (capture.documentOutcome !== 'created') {
        capture = await placeDocumentPage(tenantId, capture, { ...deps, guard });
        if (capture.documentOutcome !== 'created') return await finishCapture(tenantId, captureId);
      }
    }
    const fromDocument =
      capture.shape === 'document' && capture.documentPageId
        ? { pageId: capture.documentPageId, title: capture.documentTitle ?? '' }
        : undefined;
    const planned = await planCapture(
      { tenantId, captureId },
      { model: deps.model, embedder: deps.embedder, now, guard, fromDocument }
    );
    await deps.hooks?.afterPlan?.();
    await applyPlannedFacts(tenantId, captureId, planned, { ...deps, guard }, fromDocument ? 'filed_in_document' : 'needs_home');
    return await finishCapture(tenantId, captureId);
  } finally {
    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, holder));
  }
}

type CaptureRow = typeof captures.$inferSelect;

/** Most characters of a capture kept as one fact when nothing could be split out of it. */
const UNSPLIT_FACT_CHARS = 4000;

/** The current name of a capture's file ('' when it is gone). */
async function fileNameOf(tx: DbTransaction, tenantId: string, fileId: string): Promise<string> {
  const [row] = await tx.select({ title: documents.title }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, fileId)));
  return row?.title ?? '';
}

/** A document's title when the model gave none: its first line without list or heading marks. */
function firstLineTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.replace(/^[#*\-\s]+/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim().slice(0, 120) || 'Capture';
}

/**
 * Splits the capture once and stores what came out: its facts (pending) and
 * its shape, subject and title, in one transaction. A capture already split
 * is returned as it is, so a retried run never splits twice. An updates
 * capture with nothing to split waits whole in Needs a home; a document
 * with no facts still gets its page.
 */
export async function ensureSplit(tenantId: string, captureId: string, deps: RouteDeps): Promise<CaptureRow> {
  const loaded = await withTenantTx(tenantId, async (tx) => {
    const [capture] = await tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
    if (!capture) throw new AppError('capture_not_found');
    const [fact] = await tx
      .select({ id: captureFacts.id })
      .from(captureFacts)
      .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, captureId)))
      .limit(1);
    return { capture, split: !!fact || capture.shape !== null };
  });
  if (loaded.split) return loaded.capture;

  const text = routedText(loaded.capture);
  const { facts, shape } = await splitCaptureText(text, deps.model, deps.guard);
  // A file is a document of its own unless the sender asked for updates only.
  const withFile = loaded.capture.fileId !== null;
  const decided = withFile && loaded.capture.shapeMode === 'auto' ? 'document' : decideShape(loaded.capture.shapeMode, shape);
  // Its page is named by what was typed, else by the file.
  const fileName = withFile ? await withTenantTx(tenantId, (tx) => fileNameOf(tx, tenantId, loaded.capture.fileId!)) : null;
  const title =
    fileName !== null
      ? loaded.capture.text.trim()
        ? firstLineTitle(loaded.capture.text)
        : fileTitle(fileName)
      : (shape?.title ?? firstLineTitle(text));
  await deps.guard?.();
  return withTenantTx(tenantId, async (tx) => {
    if (facts.length > 0) {
      await tx.insert(captureFacts).values(
        facts.map((f, ordinal) => ({ tenantId, captureId, ordinal, statement: f.statement, kind: f.kind, names: f.names, date: f.date }))
      );
    } else if (decided === 'updates') {
      await tx.insert(captureFacts).values({
        tenantId,
        captureId,
        ordinal: 0,
        statement: text.slice(0, UNSPLIT_FACT_CHARS),
        kind: 'new',
        outcome: 'needs_home',
        reason: 'This capture could not be split into facts.',
      });
    }
    const [row] = await tx
      .update(captures)
      .set({
        shape: decided,
        subject: shape?.subject ?? null,
        documentTitle: decided === 'document' ? title : null,
      })
      .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)))
      .returning();
    return row!;
  });
}

/**
 * Creates a document capture's page where a person chose, or where
 * `planDocument` places it; when it cannot be placed the capture waits in
 * Needs a home with the reason and parents to offer. The page id is stored
 * in the transaction that creates the page, so a retried run never makes a
 * second one. Returns the capture as it is now.
 */
async function placeDocumentPage(tenantId: string, capture: CaptureRow, deps: RouteDeps): Promise<CaptureRow> {
  const title = capture.documentTitle ?? firstLineTitle(routedText(capture));
  let place: { spaceId: string; parentId: string | null; title: string } | null = null;
  let waiting: { reason: string; options: unknown[] } | null = null;

  if (capture.documentParentChoice || capture.documentSpaceChoice) {
    place = await withTenantTx(tenantId, async (tx) => {
      let spaceId = capture.documentSpaceChoice;
      const parentId = capture.documentParentChoice;
      if (parentId) {
        const [parent] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, parentId)));
        if (!parent || parent.kind !== 'page' || parent.archivedAt) return null;
        spaceId = parent.spaceId;
      }
      return { spaceId: spaceId!, parentId, title: await uniqueChildTitle(tx, tenantId, spaceId!, parentId, title) };
    });
    if (!place) waiting = { reason: 'The chosen page is no longer there.', options: [] };
  } else {
    const names = await withTenantTx(tenantId, async (tx) =>
      (
        await tx
          .select({ names: captureFacts.names })
          .from(captureFacts)
          .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, capture.id)))
      ).flatMap((f) => f.names)
    );
    const plan = await planDocument(
      { tenantId, captureId: capture.id, title, subject: capture.subject, names: [...new Set(names)] },
      { model: deps.model, embedder: deps.embedder }
    );
    if (plan.status === 'place') place = { spaceId: plan.spaceId, parentId: plan.parentId, title: plan.title };
    else waiting = { reason: plan.reason, options: plan.options };
  }

  await deps.guard?.();
  if (!place) {
    return withTenantTx(tenantId, async (tx) => {
      const [row] = await tx
        .update(captures)
        .set({ documentOutcome: 'needs_home', documentReason: waiting!.reason, documentOptions: waiting!.options })
        .where(and(eq(captures.tenantId, tenantId), eq(captures.id, capture.id)))
        .returning();
      return row!;
    });
  }
  const routerId = await withTenantTx(tenantId, (tx) => ensureRouterAgent(tx, tenantId));
  const target = place;
  await createEnginePage(
    tenantId,
    { ...target, markdown: routedText(capture) },
    {
      captureId: capture.id,
      factId: null,
      quote: null,
      routerId,
      onCreated: async (tx, pageId) => {
        // Fenced: if another run recorded a page meanwhile, this page is rolled back with the error.
        const won = await tx
          .update(captures)
          .set({ documentPageId: pageId, documentOutcome: 'created', documentTitle: target.title, documentReason: null })
          .where(and(eq(captures.tenantId, tenantId), eq(captures.id, capture.id), isNull(captures.documentPageId)))
          .returning({ id: captures.id });
        if (won.length === 0) {
          throw new AppError('router_unavailable', "Another routing run already created this capture's page.");
        }
        // The file the capture came with lives under its page from now on.
        await attachCaptureFile(tx, tenantId, capture, pageId);
        await writeAuditEvent(tx, {
          tenantId,
          type: 'capture.document_created',
          actorType: 'agent',
          actorId: routerId,
          subjectType: 'capture',
          subjectId: capture.id,
          payload: { pageId, parentId: target.parentId, spaceId: target.spaceId },
        });
      },
    }
  );
  const [row] = await withTenantTx(tenantId, (tx) =>
    tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, capture.id)))
  );
  return row!;
}

/**
 * Renews the tenant's routing lease for `holder`, or throws when another run
 * holds it now (this one outlived its lease): the run stops before it plans
 * or changes anything more, and its job retries. Fencing for R13.
 */
export function leaseGuard(tenantId: string, holder: string): () => Promise<void> {
  return async () => {
    const still = await withTenantTx(tenantId, (tx) => acquireRoutingLease(tx, tenantId, holder, ROUTING_LEASE_SECONDS));
    if (!still) throw new AppError('router_unavailable', 'Another routing run took over this tenant; this one stopped.');
  };
}

/** Facts waiting on a question older than QUESTION_TTL_DAYS go to Needs a home. */
async function expireQuestions(tenantId: string, now: Date) {
  const cutoff = new Date(now.getTime() - QUESTION_TTL_DAYS * 86_400_000);
  await withTenantTx(tenantId, async (tx) => {
    const stale = await tx
      .select({ id: captureFacts.id, captureId: captureFacts.captureId })
      .from(captureFacts)
      .innerJoin(
        captureMessages,
        and(eq(captureMessages.tenantId, captureFacts.tenantId), eq(captureMessages.id, captureFacts.waitingQuestionId))
      )
      .where(and(eq(captureFacts.tenantId, tenantId), lt(captureMessages.createdAt, cutoff)));
    if (stale.length === 0) return;
    await tx
      .update(captureFacts)
      .set({ outcome: 'needs_home', waitingQuestionId: null, reason: 'The question was not answered within 7 days.' })
      .where(and(eq(captureFacts.tenantId, tenantId), inArray(captureFacts.id, stale.map((s) => s.id))));
    for (const captureId of new Set(stale.map((s) => s.captureId))) await settleStatus(tx, tenantId, captureId);
  });
}

/** `waiting_for_answer` while any fact waits on a question, else `done`. */
async function settleStatus(tx: DbTransaction, tenantId: string, captureId: string) {
  const [waiting] = await tx
    .select({ id: captureFacts.id })
    .from(captureFacts)
    .where(
      and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, captureId), isNotNull(captureFacts.waitingQuestionId))
    )
    .limit(1);
  const status = waiting ? 'waiting_for_answer' : 'done';
  await tx
    .update(captures)
    .set({ status, finishedAt: status === 'done' ? new Date() : null })
    .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
  return status;
}

/**
 * Tells a person who sent a capture that something in it waits for them (a
 * question, or a fact or page that needs a home), once until they read it.
 */
async function notifyWaiting(tx: DbTransaction, tenantId: string, captureId: string, routerId: string, factsWait: boolean) {
  const [capture] = await tx
    .select({ senderType: captures.senderType, senderId: captures.senderId, text: captures.text, documentOutcome: captures.documentOutcome })
    .from(captures)
    .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
  if (!capture || capture.senderType !== 'user') return;
  if (!factsWait && capture.documentOutcome !== 'needs_home') return;
  if (await hasUnreadAbout(tx, tenantId, capture.senderId, 'capture_waiting', captureId)) return;
  await notify(tx, tenantId, [
    {
      recipientId: capture.senderId,
      kind: 'capture_waiting',
      actorType: 'agent',
      actorId: routerId,
      captureId,
      excerpt: excerptOf(capture.text),
    },
  ]);
}

/** Settles the capture's status and audits the run. */
export async function finishCapture(tenantId: string, captureId: string) {
  return withTenantTx(tenantId, async (tx) => {
    const status = await settleStatus(tx, tenantId, captureId);
    const facts = await tx
      .select({ outcome: captureFacts.outcome })
      .from(captureFacts)
      .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, captureId)));
    const counts: Record<string, number> = {};
    for (const f of facts) counts[f.outcome] = (counts[f.outcome] ?? 0) + 1;
    const routerId = await ensureRouterAgent(tx, tenantId);
    await notifyWaiting(tx, tenantId, captureId, routerId, status === 'waiting_for_answer' || (counts.needs_home ?? 0) > 0);
    await writeAuditEvent(tx, {
      tenantId,
      type: 'capture.routed',
      actorType: 'agent',
      actorId: routerId,
      subjectType: 'capture',
      subjectId: captureId,
      payload: { status, outcomes: counts },
    });
    return status;
  });
}

/**
 * Records planned facts and acts on them: questions are asked, needs-home and
 * already-known facts are recorded, ungated edits are applied (per page, one
 * collab change and one snapshot) and gated ones become suggestions.
 */
export async function applyPlannedFacts(
  tenantId: string,
  captureId: string,
  planned: PlannedFact[],
  deps: RouteDeps,
  /** Where a fact goes when its edits came to nothing (a document's facts stay on its page). */
  fallback: 'needs_home' | 'filed_in_document' = 'needs_home'
): Promise<void> {
  const now = deps.now ?? new Date();
  await deps.guard?.();
  const { routerId, items } = await withTenantTx(tenantId, async (tx) => {
    const routerId = await ensureRouterAgent(tx, tenantId);
    const items: Item[] = [];
    for (const p of planned) {
      let factId = p.factId;
      if (!factId) {
        const [row] = await tx
          .insert(captureFacts)
          .values({
            tenantId,
            captureId,
            ordinal: p.ordinal,
            statement: p.fact.statement,
            kind: p.fact.kind,
            names: p.fact.names,
            date: p.fact.date,
            pinnedEntityIds: p.pinnedEntityIds,
          })
          .returning({ id: captureFacts.id });
        factId = row!.id;
      }
      const where = and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.id, factId));
      const plan = p.plan;
      if (plan.status === 'question') {
        const [message] = await tx
          .insert(captureMessages)
          .values({ tenantId, captureId, author: 'engine', body: plan.question, options: plan.options })
          .returning({ id: captureMessages.id });
        await tx.update(captureFacts).set({ outcome: 'pending', waitingQuestionId: message!.id }).where(where);
        await writeAuditEvent(tx, {
          tenantId,
          type: 'capture.question_asked',
          actorType: 'agent',
          actorId: routerId,
          subjectType: 'capture',
          subjectId: captureId,
          payload: { factId, names: plan.names, options: plan.options.length },
        });
      } else if (plan.status === 'needs_home') {
        await tx.update(captureFacts).set({ outcome: 'needs_home', reason: plan.reason }).where(where);
      } else if (plan.status === 'already_known') {
        await tx.update(captureFacts).set({ outcome: 'already_known', reason: 'The wiki already says this.' }).where(where);
      } else if (plan.status === 'filed_in_document') {
        await tx.update(captureFacts).set({ outcome: 'filed_in_document', reason: plan.reason }).where(where);
      } else {
        await tx
          .update(captureFacts)
          .set({
            confidence: Math.max(...plan.edits.map((e) => e.edit.confidence)),
            reason: plan.edits[0]?.edit.reason ?? null,
          })
          .where(where);
        for (const checked of plan.edits) items.push({ factId, statement: p.fact.statement, checked });
      }
    }
    return { routerId, items };
  });

  const results = new Map<string, FactResult>();
  const resultOf = (factId: string) => {
    let r = results.get(factId);
    if (!r) results.set(factId, (r = { applied: [], suggested: 0 }));
    return r;
  };
  for (const item of items) resultOf(item.factId);

  const toSuggest: Array<Item & { gate: Exclude<Gate, null> }> = [];
  const byPage = new Map<string, Item[]>();
  const creates: Item[] = [];
  for (const item of items) {
    const op = item.checked.edit.op;
    if (item.checked.gate) toSuggest.push({ ...item, gate: item.checked.gate });
    else if (op.op === 'create_page') creates.push(item);
    else if (op.op !== 'already_known') {
      const list = byPage.get(op.documentId) ?? [];
      list.push(item);
      byPage.set(op.documentId, list);
    }
  }

  for (const [pageId, list] of byPage) {
    await deps.guard?.();
    // What people typed is stored first, so the recheck compares live text.
    await deps.collab.flush(documentName(tenantId, pageId));
    const { apply, gated } = await recheck(tenantId, pageId, list, now);
    toSuggest.push(...gated);
    if (apply.length > 0) toSuggest.push(...(await applyToPage(tenantId, captureId, pageId, apply, routerId, deps, resultOf)));
  }
  for (const item of creates) {
    await deps.guard?.();
    await createPageFor(tenantId, captureId, item, routerId, resultOf);
  }
  if (toSuggest.length > 0) {
    await deps.guard?.();
    await writeSuggestions(tenantId, captureId, toSuggest, resultOf);
  }

  await withTenantTx(tenantId, async (tx) => {
    for (const [factId, r] of results) {
      const outcome =
        r.applied.length > 0
          ? r.applied.every((s) => s === 'pending_review')
            ? 'waiting_review'
            : 'applied'
          : r.suggested > 0
            ? 'suggested'
            : fallback;
      await tx
        .update(captureFacts)
        .set({ outcome, ...(outcome === fallback ? { reason: 'The page changed while this was being filed.' } : {}) })
        .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.id, factId)));
    }
  });
}

/**
 * Right before applying: a block a person changed since planning (its text
 * differs from what was planned on, or a person edited it within the
 * space's protection window) is not overwritten; that edit becomes a
 * suggestion. Edits whose block is gone are dropped.
 */
async function recheck(tenantId: string, pageId: string, list: Item[], now: Date) {
  return withTenantTx(tenantId, async (tx) => {
    const live = await readLiveBlocks(tx, tenantId, pageId);
    const blocks = new Map((live?.blocks ?? []).map((b) => [b.id, b]));
    const [space] = await tx
      .select({ seconds: spaces.humanProtectionSeconds })
      .from(pages)
      .innerJoin(spaces, and(eq(spaces.tenantId, pages.tenantId), eq(spaces.id, pages.spaceId)))
      .where(and(eq(pages.tenantId, tenantId), eq(pages.documentId, pageId)));
    const since = new Date(now.getTime() - (space?.seconds ?? 0) * 1000);
    const apply: Item[] = [];
    const gated: Array<Item & { gate: Exclude<Gate, null> }> = [];
    for (const item of list) {
      const op = item.checked.edit.op;
      if (op.op === 'insert_after') {
        if (op.after === null || blocks.has(op.after)) apply.push(item);
        continue;
      }
      if (op.op !== 'replace') continue;
      const block = blocks.get(op.blockId);
      if (!block) continue;
      const [touched] = await tx
        .select({ at: blockActivity.changedAt })
        .from(blockActivity)
        .where(
          and(
            eq(blockActivity.tenantId, tenantId),
            eq(blockActivity.pageId, pageId),
            eq(blockActivity.blockId, op.blockId),
            eq(blockActivity.actorType, 'user'),
            gt(blockActivity.changedAt, since)
          )
        );
      const changed = (await blockMarkdown(block)) !== item.checked.beforeMarkdown;
      if (touched || changed) gated.push({ ...item, gate: 'protection' });
      else apply.push(item);
    }
    return { apply, gated };
  });
}

/** Engine Markdown as blocks with fresh top-level ids (the receipt and undo address them). */
async function freshBlocks(markdown: string): Promise<BlockLike[]> {
  return (await markdownBlocks(markdown)).map((b) => ({ ...b, id: randomUUID() }));
}

/**
 * Applies a page's ungated edits in one collab change and snapshots it.
 * Returns the edits that became suggestions instead: all of them when collab
 * refuses because a planned block changed since (`block_changed`).
 * The changes are recorded as soon as collab has applied them, before the
 * flush and snapshot, so a run that fails after that point keeps its receipt
 * and its retry does not plan the same facts again.
 */
async function applyToPage(
  tenantId: string,
  captureId: string,
  pageId: string,
  items: Item[],
  routerId: string,
  deps: RouteDeps,
  resultOf: (factId: string) => FactResult
): Promise<Array<Item & { gate: Exclude<Gate, null> }>> {
  type Planned = { item: Item; blocks: BlockLike[]; keeps: string | null };
  const planned: Planned[] = [];
  const ops: Parameters<CollabClient['applyBlockOps']>[0]['ops'] = [];
  for (const item of items) {
    const op = item.checked.edit.op;
    if (op.op === 'insert_after') {
      const blocks = await freshBlocks(op.markdown);
      if (blocks.length === 0) continue;
      ops.push({ op: 'insert_after', after: op.after, blocks: blocks as unknown as Record<string, unknown>[] });
      planned.push({ item, blocks, keeps: null });
    } else if (op.op === 'replace') {
      const blocks = await freshBlocks(op.markdown);
      if (blocks.length === 0) continue;
      blocks[0] = { ...blocks[0]!, id: op.blockId };
      ops.push({
        op: 'replace',
        blockId: op.blockId,
        blocks: blocks as unknown as Record<string, unknown>[],
        ...(item.checked.expectedText !== null ? { expectedText: item.checked.expectedText } : {}),
      });
      planned.push({ item, blocks, keeps: op.blockId });
    }
  }
  if (ops.length === 0) return [];

  try {
    await deps.collab.applyBlockOps({ tenantId, pageId, actor: { type: 'agent', id: routerId }, source: 'agent', ops });
  } catch (err) {
    // Someone changed a planned block since: nothing was applied; a person decides.
    if (err instanceof AppError && err.code === 'block_changed') {
      return planned.map((p) => ({ ...p.item, gate: 'protection' as const }));
    }
    // The page changed under us (a block was deleted): nothing was applied.
    if (err instanceof AppError && err.code === 'block_not_found') return [];
    throw err;
  }

  const rowIds = await recordChanges(tenantId, captureId, pageId, planned, routerId);
  await deps.collab.flush(documentName(tenantId, pageId));
  const version = await takePageSnapshot({
    tenantId,
    pageId,
    reason: 'capture',
    actorType: 'agent',
    actorId: routerId,
    manual: false,
  });
  const state =
    version?.status === 'pending_review'
      ? 'pending_review'
      : version?.status === 'indexing' || version?.status === 'indexed'
        ? 'indexing'
        : 'other';
  await withTenantTx(tenantId, async (tx) => {
    if (version) {
      await tx
        .update(captureChanges)
        .set({ versionId: version.id })
        .where(and(eq(captureChanges.tenantId, tenantId), inArray(captureChanges.id, rowIds)));
    }
    for (const { item } of planned) {
      resultOf(item.factId).applied.push(state);
      if (state === 'pending_review') {
        await tx
          .update(captureFacts)
          .set({ outcome: 'waiting_review' })
          .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.id, item.factId)));
      }
    }
  });
  return [];
}

/**
 * Writes the receipt rows and citations of edits collab just applied, and
 * marks their facts applied (the snapshot may still turn that into
 * waiting_review). Returns the new capture_changes ids.
 */
async function recordChanges(
  tenantId: string,
  captureId: string,
  pageId: string,
  planned: Array<{ item: Item; blocks: BlockLike[]; keeps: string | null }>,
  routerId: string
): Promise<string[]> {
  return withTenantTx(tenantId, async (tx) => {
    const ids: string[] = [];
    for (const { item, blocks, keeps } of planned) {
      for (const [i, block] of blocks.entries()) {
        const replaced = i === 0 && keeps !== null;
        const [row] = await tx
          .insert(captureChanges)
          .values({
            tenantId,
            captureId,
            factId: item.factId,
            documentId: pageId,
            spaceId: item.checked.spaceId,
            blockId: block.id,
            op: replaced ? 'replace' : 'insert',
            beforeMarkdown: replaced ? item.checked.beforeMarkdown : null,
            afterMarkdown: await blockMarkdown(block),
          })
          .returning({ id: captureChanges.id });
        ids.push(row!.id);
        await tx.insert(citations).values({
          tenantId,
          pageId,
          blockId: block.id,
          sourceKind: 'capture',
          captureId,
          factId: item.factId,
          quote: item.statement,
          createdByType: 'agent',
          createdBy: routerId,
        });
      }
      await tx
        .update(captureFacts)
        .set({ outcome: 'applied' })
        .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.id, item.factId)));
    }
    return ids;
  });
}

function slugFor(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'page'}-${id.slice(0, 8)}`;
}

/** A new page the engine created for a fact nothing else fits (R9: needs the higher threshold). */
async function createPageFor(
  tenantId: string,
  captureId: string,
  item: Item,
  routerId: string,
  resultOf: (factId: string) => FactResult
) {
  const op = item.checked.edit.op;
  if (op.op !== 'create_page') return;
  const created = await createEnginePage(
    tenantId,
    { spaceId: op.spaceId, parentId: op.parentId, title: op.title, markdown: op.markdown },
    { captureId, factId: item.factId, quote: item.statement, routerId }
  );
  if (created) resultOf(item.factId).applied.push(created.state);
}

/** Longest quote a document page's citation keeps of its block. */
const DOCUMENT_QUOTE_CHARS = 280;

/**
 * Creates a page as the Routing engine holding `markdown`, with its receipt
 * rows (the first block `create_page`, the rest `insert`) and a capture
 * citation per block, in one transaction (`onCreated` runs in it too), then
 * snapshots it. `quote` null cites each block with its own text (a
 * document's page). Null when the Markdown has no blocks.
 */
export async function createEnginePage(
  tenantId: string,
  page: { spaceId: string; parentId: string | null; title: string; markdown: string },
  ctx: {
    captureId: string;
    factId: string | null;
    quote: string | null;
    routerId: string;
    onCreated?: (tx: DbTransaction, pageId: string) => Promise<void>;
  }
): Promise<{ pageId: string; state: 'pending_review' | 'indexing' } | null> {
  const blocks = await freshBlocks(page.markdown);
  if (blocks.length === 0) return null;
  const { pageId, rowIds } = await withTenantTx(tenantId, async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId,
        spaceId: page.spaceId,
        parentId: page.parentId,
        kind: 'page',
        title: page.title,
        placement: 'pinned',
        createdByType: 'agent',
        createdBy: ctx.routerId,
      })
      .returning();
    await tx.insert(pages).values({
      documentId: doc!.id,
      tenantId,
      spaceId: page.spaceId,
      slug: slugFor(page.title, doc!.id),
      ydocState: encodeBlocksYDoc(page.title, blocks),
      liveChangedSinceSnapshot: true,
      agentChangedAt: new Date(),
    });
    await tx
      .insert(pagePendingContributors)
      .values({ tenantId, pageId: doc!.id, principalType: 'agent', principalId: ctx.routerId });
    await writeAuditEvent(tx, {
      tenantId,
      type: 'page.created',
      actorType: 'agent',
      actorId: ctx.routerId,
      subjectType: 'page',
      subjectId: doc!.id,
      payload: { spaceId: page.spaceId, title: page.title, captureId: ctx.captureId },
    });
    const rowIds: string[] = [];
    for (const [i, block] of blocks.entries()) {
      const markdown = await blockMarkdown(block);
      const [row] = await tx
        .insert(captureChanges)
        .values({
          tenantId,
          captureId: ctx.captureId,
          factId: ctx.factId,
          documentId: doc!.id,
          spaceId: page.spaceId,
          blockId: block.id,
          op: i === 0 ? 'create_page' : 'insert',
          afterMarkdown: markdown,
        })
        .returning({ id: captureChanges.id });
      rowIds.push(row!.id);
      await tx.insert(citations).values({
        tenantId,
        pageId: doc!.id,
        blockId: block.id,
        sourceKind: 'capture',
        captureId: ctx.captureId,
        factId: ctx.factId,
        quote: ctx.quote ?? (markdown.slice(0, DOCUMENT_QUOTE_CHARS) || page.title),
        createdByType: 'agent',
        createdBy: ctx.routerId,
      });
    }
    await ctx.onCreated?.(tx, doc!.id);
    return { pageId: doc!.id, rowIds };
  });
  const version = await takePageSnapshot({
    tenantId,
    pageId,
    reason: 'capture',
    actorType: 'agent',
    actorId: ctx.routerId,
    manual: false,
  });
  if (version) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(captureChanges)
        .set({ versionId: version.id })
        .where(and(eq(captureChanges.tenantId, tenantId), inArray(captureChanges.id, rowIds)))
    );
  }
  return { pageId, state: version?.status === 'pending_review' ? 'pending_review' : 'indexing' };
}

async function writeSuggestions(
  tenantId: string,
  captureId: string,
  list: Array<Item & { gate: Exclude<Gate, null> }>,
  resultOf: (factId: string) => FactResult
) {
  const rows: Array<typeof suggestions.$inferInsert> = [];
  for (const item of list) {
    const op = item.checked.edit.op;
    if (op.op === 'already_known' || op.op === 'create_page') continue;
    const markdown = op.op === 'remove' ? null : op.markdown;
    rows.push({
      tenantId,
      documentId: op.documentId,
      spaceId: item.checked.spaceId,
      blockId: op.op === 'insert_after' ? null : op.blockId,
      afterBlockId: op.op === 'insert_after' ? op.after : null,
      kind: op.op === 'insert_after' ? ('insert' as const) : op.op,
      proposedMarkdown: markdown,
      proposedBlocks: markdown === null ? null : await markdownBlocks(markdown),
      expectedText: item.checked.expectedText,
      reason: item.checked.edit.reason || 'Proposed by the routing engine.',
      blockedBy: item.gate,
      conflictCitationId: item.checked.conflictCitationId,
      captureId,
      factId: item.factId,
    });
    resultOf(item.factId).suggested += 1;
  }
  if (rows.length === 0) return;
  await withTenantTx(tenantId, (tx) => tx.insert(suggestions).values(rows));
}

/** Marks a capture failed (its routing job was dead-lettered). */
export async function failCapture(tenantId: string, captureId: string, error: string) {
  await withTenantTx(tenantId, (tx) =>
    tx
      .update(captures)
      .set({ status: 'failed', error: error.slice(0, 500), finishedAt: sql`now()` })
      .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)))
  );
}
