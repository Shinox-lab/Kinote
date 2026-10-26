import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
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
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { documentName, type BlockLike, type CollabClient } from '@living-wiki/shared';
import type { EmbeddingProvider } from '../embedding.js';
import type { RoutingModel } from '../placement/model.js';
import { takePageSnapshot } from '../snapshot.js';
import { blockMarkdown, encodeBlocksYDoc, markdownBlocks, readLiveBlocks } from './liveBlocks.js';
import { planCapture, type CheckedEdit, type Gate, type PlannedFact } from './plan.js';
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
  try {
    await expireQuestions(tenantId, now);
    await withTenantTx(tenantId, (tx) =>
      tx
        .update(captures)
        .set({ status: 'routing', error: null })
        .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)))
    );
    const planned = await planCapture({ tenantId, captureId }, { model: deps.model, embedder: deps.embedder, now });
    await deps.hooks?.afterPlan?.();
    await applyPlannedFacts(tenantId, captureId, planned, deps);
    return await finishCapture(tenantId, captureId);
  } finally {
    await withTenantTx(tenantId, (tx) => releaseRoutingLease(tx, tenantId, holder));
  }
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
  deps: RouteDeps
): Promise<void> {
  const now = deps.now ?? new Date();
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
    const { apply, gated } = await recheck(tenantId, pageId, list, now);
    toSuggest.push(...gated);
    if (apply.length > 0) await applyToPage(tenantId, captureId, pageId, apply, routerId, deps, resultOf);
  }
  for (const item of creates) await createPageFor(tenantId, captureId, item, routerId, resultOf);
  if (toSuggest.length > 0) await writeSuggestions(tenantId, captureId, toSuggest, resultOf);

  await withTenantTx(tenantId, async (tx) => {
    for (const [factId, r] of results) {
      const outcome =
        r.applied.length > 0
          ? r.applied.every((s) => s === 'pending_review')
            ? 'waiting_review'
            : 'applied'
          : r.suggested > 0
            ? 'suggested'
            : 'needs_home';
      await tx
        .update(captureFacts)
        .set({ outcome, ...(outcome === 'needs_home' ? { reason: 'The page changed while this was being filed.' } : {}) })
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

async function applyToPage(
  tenantId: string,
  captureId: string,
  pageId: string,
  items: Item[],
  routerId: string,
  deps: RouteDeps,
  resultOf: (factId: string) => FactResult
) {
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
      ops.push({ op: 'replace', blockId: op.blockId, blocks: blocks as unknown as Record<string, unknown>[] });
      planned.push({ item, blocks, keeps: op.blockId });
    }
  }
  if (ops.length === 0) return;

  try {
    await deps.collab.applyBlockOps({ tenantId, pageId, actor: { type: 'agent', id: routerId }, source: 'agent', ops });
  } catch (err) {
    // The page changed under us (a block was deleted): nothing was applied.
    if (err instanceof AppError && err.code === 'block_not_found') return;
    throw err;
  }
  await deps.collab.flush(documentName(tenantId, pageId));
  const version = await takePageSnapshot({
    tenantId,
    pageId,
    reason: 'capture',
    actorType: 'agent',
    actorId: routerId,
    manual: false,
  });
  await recordChanges(tenantId, captureId, pageId, planned, version, routerId, resultOf);
}

async function recordChanges(
  tenantId: string,
  captureId: string,
  pageId: string,
  planned: Array<{ item: Item; blocks: BlockLike[]; keeps: string | null }>,
  version: { id: string; status: string } | null,
  routerId: string,
  resultOf: (factId: string) => FactResult
) {
  const state = version?.status === 'pending_review' ? 'pending_review' : version?.status === 'indexing' || version?.status === 'indexed' ? 'indexing' : 'other';
  await withTenantTx(tenantId, async (tx) => {
    for (const { item, blocks, keeps } of planned) {
      for (const [i, block] of blocks.entries()) {
        const replaced = i === 0 && keeps !== null;
        await tx.insert(captureChanges).values({
          tenantId,
          captureId,
          factId: item.factId,
          documentId: pageId,
          spaceId: item.checked.spaceId,
          blockId: block.id,
          op: replaced ? 'replace' : 'insert',
          beforeMarkdown: replaced ? item.checked.beforeMarkdown : null,
          afterMarkdown: await blockMarkdown(block),
          versionId: version?.id ?? null,
        });
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
      resultOf(item.factId).applied.push(state);
    }
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
  const blocks = await freshBlocks(op.markdown);
  if (blocks.length === 0) return;
  const pageId = await withTenantTx(tenantId, async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId,
        spaceId: op.spaceId,
        parentId: op.parentId,
        kind: 'page',
        title: op.title,
        placement: 'pinned',
        createdByType: 'agent',
        createdBy: routerId,
      })
      .returning();
    await tx.insert(pages).values({
      documentId: doc!.id,
      tenantId,
      spaceId: op.spaceId,
      slug: slugFor(op.title, doc!.id),
      ydocState: encodeBlocksYDoc(op.title, blocks),
      liveChangedSinceSnapshot: true,
      agentChangedAt: new Date(),
    });
    await tx
      .insert(pagePendingContributors)
      .values({ tenantId, pageId: doc!.id, principalType: 'agent', principalId: routerId });
    await writeAuditEvent(tx, {
      tenantId,
      type: 'page.created',
      actorType: 'agent',
      actorId: routerId,
      subjectType: 'page',
      subjectId: doc!.id,
      payload: { spaceId: op.spaceId, title: op.title, captureId },
    });
    return doc!.id;
  });
  const version = await takePageSnapshot({
    tenantId,
    pageId,
    reason: 'capture',
    actorType: 'agent',
    actorId: routerId,
    manual: false,
  });
  const state = version?.status === 'pending_review' ? 'pending_review' : 'indexing';
  await withTenantTx(tenantId, async (tx) => {
    for (const [i, block] of blocks.entries()) {
      await tx.insert(captureChanges).values({
        tenantId,
        captureId,
        factId: item.factId,
        documentId: pageId,
        spaceId: op.spaceId,
        blockId: block.id,
        op: i === 0 ? 'create_page' : 'insert',
        afterMarkdown: await blockMarkdown(block),
        versionId: version?.id ?? null,
      });
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
  });
  resultOf(item.factId).applied.push(state);
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
