import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  withTenantTx,
  blockActivity,
  captureChanges,
  captureFacts,
  captures,
  citations,
  documents,
  pageCards,
  spaces,
  suggestions,
  versions,
  rowsOf,
  type DbTransaction,
} from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import { blockFullText, type BlockLike } from '@living-wiki/shared';
import type { EmbeddingProvider } from '../embedding.js';
import type { Actor } from '../permissions.js';
import type { CaptureFact, CaptureShape, PlanCandidate, PlannedEdit, RoutingModel } from '../placement/model.js';
import { findEntities, pagesForEntities, searchPageCards, type PlacementFilter } from '../placement/queries.js';
import { searchWiki } from '../search/hybridSearch.js';
import { senderAccess, senderActor } from './access.js';
import { blockMarkdown, blockText, readLiveBlocks } from './liveBlocks.js';

/**
 * Routing settings. Thresholds are to be tuned on the evaluation set:
 * `apply` for an insert or replace, `create` for a new page (R9), and
 * `margin`, how far ahead the best target (or entity) must be (R10), and
 * `document`, the shape confidence that makes a capture a document.
 */
export const ROUTING = { candidates: 8, blocksPerCandidate: 40, apply: 0.6, create: 0.85, margin: 0.1, rrfK: 60, document: 0.6 } as const;

/** Why an edit became a suggestion instead of being applied. */
export type Gate = null | 'removal' | 'protection' | 'conflict' | 'no_edit_access';

export interface CheckedEdit {
  edit: PlannedEdit;
  /** The space the edit lands in (the page's, or the new page's). */
  spaceId: string;
  /** Non-null: becomes a suggestion. */
  gate: Gate;
  /** The block's Markdown before a replace or remove. */
  beforeMarkdown: string | null;
  /** The block's text with its children when planned (replace, remove): collab refuses the op if it changed. */
  expectedText: string | null;
  /** A still-valid version citation on the block (R4). */
  conflictCitationId: string | null;
}

export type FactPlan =
  | { status: 'question'; names: string[]; question: string; options: Array<{ entityId: string; label: string }> }
  | { status: 'needs_home'; reason: string }
  | { status: 'already_known'; documentId: string; blockId: string }
  | { status: 'planned'; edits: CheckedEdit[] }
  /** A document's fact with no standing change, or one the engine was unsure of: kept on the document's page only. */
  | { status: 'filed_in_document'; reason: string };

export interface PlanFactInput {
  ordinal: number;
  /** The stored fact, on a run after the first. */
  factId: string | null;
  fact: CaptureFact;
  /** Entities the sender chose in answers. */
  pinnedEntityIds: string[];
}

export interface PlannedFact extends PlanFactInput {
  plan: FactPlan;
}

export interface PlanDeps {
  model: RoutingModel;
  embedder: EmbeddingProvider;
  now?: Date;
  /** The facts to plan; by default the capture's pending facts, or a fresh split on the first run. */
  facts?: PlanFactInput[];
  /** Restrict candidates to this page and waive the confidence floor (a person chose the page). */
  onlyPage?: string;
  /** Runs before each fact is planned; throws to stop (the routing run lost its lease). */
  guard?: () => Promise<void>;
  /**
   * The facts come from a document filed as its own page (`pageId`, null in a
   * dry run): that page is never a candidate, no question is asked, no page
   * is created, and anything unsure is filed on the document's page.
   */
  fromDocument?: { pageId: string | null; title: string };
}

export interface Context {
  actor: Actor;
  filter: PlacementFilter;
  inboxSpaceId: string;
  editable: Set<string>;
  writableSpaces: Array<{ id: string; name: string }>;
  scopePageId: string | null;
}

export interface Candidate {
  spaceId: string;
  card: PlanCandidate;
  blocks: Map<string, BlockLike>;
}

/**
 * Plans what a capture would change, without changing anything (a dry run:
 * reads in short transactions, model and embedder calls outside them).
 * Every proposed edit is checked against the rules: unknown ids and low
 * confidence are dropped; removals, protected blocks, blocks citing a valid
 * version and pages the sender cannot edit are gated into suggestions;
 * duplicates of what already waits are dropped.
 */
export async function planCapture(
  params: { tenantId: string; captureId: string },
  deps: PlanDeps
): Promise<PlannedFact[]> {
  const { tenantId, captureId } = params;
  const loaded = await withTenantTx(tenantId, async (tx) => {
    const [capture] = await tx
      .select()
      .from(captures)
      .where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
    if (!capture) throw new AppError('capture_not_found');
    const context = await captureContext(tx, tenantId, capture, deps.onlyPage);
    const stored = deps.facts
      ? null
      : await tx
          .select()
          .from(captureFacts)
          .where(and(eq(captureFacts.tenantId, tenantId), eq(captureFacts.captureId, captureId)))
          .orderBy(captureFacts.ordinal);
    return { capture, context, stored };
  });

  let facts: PlanFactInput[];
  if (deps.facts) facts = deps.facts;
  else if (loaded.stored && loaded.stored.length > 0) {
    // Facts waiting on a question, or placed by a person (their capture.place
    // job files them), are not this run's to plan.
    facts = loaded.stored
      .filter((f) => f.outcome === 'pending' && f.waitingQuestionId === null && f.placedBy === null)
      .map((f) => ({
        ordinal: f.ordinal,
        factId: f.id,
        fact: { statement: f.statement, kind: f.kind, names: f.names, date: f.date },
        pinnedEntityIds: f.pinnedEntityIds,
      }));
  } else {
    const split = (await splitCaptureText(loaded.capture.text, deps.model, deps.guard)).facts;
    if (split.length === 0) {
      // Nothing came out of it: the whole text waits for a person, never silently dropped.
      const fact: CaptureFact = { statement: loaded.capture.text.slice(0, 4000), kind: 'new', names: [], date: null };
      return [
        {
          ordinal: 0,
          factId: null,
          fact,
          pinnedEntityIds: [],
          plan: { status: 'needs_home', reason: 'This capture could not be split into facts.' },
        },
      ];
    }
    facts = split.map((fact, ordinal) => ({ ordinal, factId: null, fact, pinnedEntityIds: [] }));
  }

  const out: PlannedFact[] = [];
  for (const input of facts) {
    await deps.guard?.();
    let plan = await planFact(tenantId, loaded.context, input, deps);
    if (deps.fromDocument && plan.status === 'needs_home') plan = { status: 'filed_in_document', reason: plan.reason };
    out.push({ ...input, plan });
  }
  return out;
}

/**
 * Splits a capture part by part, so a long capture never runs into the
 * per-split fact limit. The shape is the first part's: that is where a
 * document's title and structure are.
 */
export async function splitCaptureText(
  text: string,
  model: RoutingModel,
  guard?: () => Promise<void>
): Promise<{ facts: CaptureFact[]; shape: CaptureShape | null }> {
  const facts: CaptureFact[] = [];
  let shape: CaptureShape | null = null;
  for (const [i, part] of captureParts(text).entries()) {
    await guard?.();
    const out = await model.splitCapture({ text: part });
    facts.push(...out.facts);
    if (i === 0) shape = out.shape;
  }
  return { facts, shape };
}

/** The sender's choice wins; on auto a capture is a document only when the model is sure enough. */
export function decideShape(mode: 'auto' | 'document' | 'updates', shape: CaptureShape | null): 'document' | 'updates' {
  if (mode !== 'auto') return mode;
  return shape?.shape === 'document' && shape.confidence >= ROUTING.document ? 'document' : 'updates';
}

/** Who the capture's sender is, what they may read and edit, and the capture's scope. */
export async function captureContext(
  tx: DbTransaction,
  tenantId: string,
  capture: typeof captures.$inferSelect,
  onlyPage?: string
): Promise<Context> {
  const actor = await senderActor(tx, { tenantId, type: capture.senderType, id: capture.senderId });
  const access = await senderAccess(tx, actor);
  let spaceIds = access.readable;
  // A page a person chose overrides the capture's scope.
  if (capture.scopeSpaceId && !onlyPage) spaceIds = spaceIds.filter((id) => id === capture.scopeSpaceId);
  const all = await tx.select({ id: spaces.id, kind: spaces.kind, name: spaces.name }).from(spaces).where(eq(spaces.tenantId, tenantId));
  return {
    actor,
    filter: { tenantId, spaceIds },
    inboxSpaceId: all.find((s) => s.kind === 'inbox')?.id ?? '00000000-0000-0000-0000-000000000000',
    editable: new Set(access.editable),
    writableSpaces: all.filter((s) => access.editable.includes(s.id)).map((s) => ({ id: s.id, name: s.name })),
    scopePageId: onlyPage ?? capture.scopePageId,
  };
}

/**
 * Entities for `names`: an exact or clearly-ahead match per name. The first
 * name two entities fit about equally well is returned as `ambiguous`
 * (with the close options), and resolving stops there.
 */
export async function resolveNames(
  tenantId: string,
  ctx: Context,
  names: string[],
  pinnedEntityIds: string[]
): Promise<{ resolved: string[]; ambiguous: { name: string; options: Array<{ entityId: string; label: string }> } | null }> {
  const resolved: string[] = [];
  const hitsByName = await withTenantTx(tenantId, async (tx) => {
    const found: Array<[string, Awaited<ReturnType<typeof findEntities>>]> = [];
    for (const name of names) found.push([name, await findEntities(tx, ctx.filter, name, 5)]);
    return found;
  });
  for (const [name, hits] of hitsByName) {
    const pinned = hits.find((h) => pinnedEntityIds.includes(h.entityId));
    if (pinned) {
      resolved.push(pinned.entityId);
      continue;
    }
    const [top, second] = hits;
    if (!top) continue;
    const clearlyAhead =
      !second || (top.match === 'exact' && second.match !== 'exact') || top.score - second.score > ROUTING.margin;
    if (clearlyAhead) {
      resolved.push(top.entityId);
      continue;
    }
    const close = hits.filter((h) => h.match === top.match && top.score - h.score <= ROUTING.margin);
    return { resolved, ambiguous: { name, options: close.map((h) => ({ entityId: h.entityId, label: h.name })) } };
  }
  return { resolved, ambiguous: null };
}

/**
 * The page's blocks the planner sees, at most ROUTING.blocksPerCandidate:
 * blocks passage search matched first, then blocks naming the fact's names,
 * then the rest from the top; shown in page order.
 */
function relevantBlocks(blocks: BlockLike[], hits: Set<string>, names: string[]): BlockLike[] {
  if (blocks.length <= ROUTING.blocksPerCandidate) return blocks;
  const lower = names.map((n) => n.toLowerCase()).filter((n) => n.length > 0);
  const score = (b: BlockLike) => {
    const text = blockText(b).toLowerCase();
    return (hits.has(b.id) ? 2 : 0) + (lower.some((n) => text.includes(n)) ? 1 : 0);
  };
  const chosen = new Set(
    blocks
      .map((b, i) => ({ b, i, s: score(b) }))
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .slice(0, ROUTING.blocksPerCandidate)
      .map((x) => x.b.id)
  );
  return blocks.filter((b) => chosen.has(b.id));
}

/** Longest piece of a capture split in one model call. */
const SPLIT_PART_CHARS = 3000;

/**
 * A capture cut into pieces of at most SPLIT_PART_CHARS, on paragraph
 * breaks where possible (a longer paragraph is cut on sentence ends, then
 * hard). Joined with blank lines they give the paragraphs back.
 */
export function captureParts(text: string): string[] {
  const pieces: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    if (para.length <= SPLIT_PART_CHARS) {
      pieces.push(para);
      continue;
    }
    let rest = para;
    while (rest.length > SPLIT_PART_CHARS) {
      const window = rest.slice(0, SPLIT_PART_CHARS);
      const end = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
      const cut = end > SPLIT_PART_CHARS / 2 ? end + 1 : SPLIT_PART_CHARS;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) pieces.push(rest);
  }
  const parts: string[] = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last !== undefined && last.length + 2 + piece.length <= SPLIT_PART_CHARS) parts[parts.length - 1] = `${last}\n\n${piece}`;
    else parts.push(piece);
  }
  return parts.filter((p) => p.trim().length > 0);
}

async function planFact(tenantId: string, ctx: Context, input: PlanFactInput, deps: PlanDeps): Promise<FactPlan> {
  const { fact, pinnedEntityIds } = input;

  // 1. Resolve the names, asking when two entities fit about equally well
  //    (a document's facts never ask: an ambiguous name is skipped).
  const resolved: string[] = [];
  let ambiguous: Awaited<ReturnType<typeof resolveNames>>['ambiguous'] = null;
  if (deps.fromDocument) {
    for (const name of fact.names) resolved.push(...(await resolveNames(tenantId, ctx, [name], pinnedEntityIds)).resolved);
  } else {
    const r = await resolveNames(tenantId, ctx, fact.names, pinnedEntityIds);
    resolved.push(...r.resolved);
    ambiguous = r.ambiguous;
  }
  if (ambiguous) {
    return {
      status: 'question',
      names: [ambiguous.name],
      question: `Which ${ambiguous.name} do you mean?`,
      options: ambiguous.options,
    };
  }

  // 2. Gather candidate pages from passages, cards and the graph, fused.
  const [vector] = await deps.embedder.embed([fact.statement], 'query');
  const { candidates, examples } = await withTenantTx(tenantId, async (tx) => {
    const candidates = await gatherCandidates(tx, ctx, fact, vector!, resolved, deps.fromDocument?.pageId ?? undefined);
    const spaceIds = [...new Set([...candidates.values()].map((c) => c.spaceId))];
    return { candidates, examples: await similarExamples(tx, tenantId, spaceIds, vector!) };
  });
  if (candidates.size === 0) return { status: 'needs_home', reason: 'No page you can read is about this.' };

  // 3. Plan, shown how people corrected similar facts in these spaces (R11).
  const planned = await deps.model.planEdits({
    fact,
    candidates: [...candidates.values()].map((c) => c.card),
    examples,
    writableSpaces: ctx.writableSpaces,
    fromDocument: deps.fromDocument ? { title: deps.fromDocument.title } : null,
  });
  // A document's facts never create pages: the document already is one.
  const edits = deps.fromDocument ? planned.edits.filter((e) => e.op.op !== 'create_page') : planned.edits;

  // 4. Check.
  return checkEdits(tenantId, ctx, candidates, edits, deps);
}

/** Candidate pages for `fact`: passages, cards and the graph fused, at most ROUTING.candidates; `exclude` never is one. */
export async function gatherCandidates(
  tx: DbTransaction,
  ctx: Context,
  fact: CaptureFact,
  vector: number[],
  entityIds: string[],
  exclude?: string
): Promise<Map<string, Candidate>> {
  const statement = fact.statement;
  /** Block ids passage search matched, per page: the blocks most about this fact. */
  const hitBlocks = new Map<string, Set<string>>();
  let ids: string[];
  if (ctx.scopePageId) {
    ids = [ctx.scopePageId];
  } else {
    const passages = (
      await searchWiki(tx, ctx.actor, ctx.filter.spaceIds, ctx.inboxSpaceId, statement, vector, 20)
    ).filter((p) => p.documentKind === 'page');
    for (const p of passages) {
      const set = hitBlocks.get(p.documentId) ?? new Set<string>();
      for (const id of p.blockIds) set.add(id);
      hitBlocks.set(p.documentId, set);
    }
    const cards = await searchPageCards(tx, ctx.filter, vector, 20);
    const graph = (await pagesForEntities(tx, ctx.filter, entityIds, 1)).sort((a, b) => a.hops - b.hops);
    const score = new Map<string, number>();
    for (const list of [passages.map((p) => p.documentId), cards.map((c) => c.documentId), graph.map((g) => g.documentId)]) {
      [...new Set(list)].forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (ROUTING.rrfK + rank + 1)));
    }
    ids = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  if (ids.length === 0) return new Map();

  const docs = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, ctx.filter.tenantId), inArray(documents.id, ids)));
  const cards = await tx
    .select()
    .from(pageCards)
    .where(and(eq(pageCards.tenantId, ctx.filter.tenantId), inArray(pageCards.documentId, ids)));
  const out = new Map<string, Candidate>();
  for (const id of ids) {
    if (out.size >= ROUTING.candidates) break;
    if (id === exclude) continue;
    const doc = docs.find((d) => d.id === id);
    if (!doc || doc.kind !== 'page' || doc.archivedAt || !ctx.filter.spaceIds.includes(doc.spaceId)) continue;
    const live = await readLiveBlocks(tx, ctx.filter.tenantId, id);
    if (!live) continue;
    const card = cards.find((c) => c.documentId === id);
    const top = relevantBlocks(live.blocks, hitBlocks.get(id) ?? new Set(), fact.names);
    out.set(id, {
      spaceId: doc.spaceId,
      blocks: new Map(live.blocks.map((b) => [b.id, b])),
      card: {
        documentId: id,
        spaceId: doc.spaceId,
        parentId: doc.parentId,
        ...(await pageTree(tx, ctx.filter.tenantId, doc)),
        title: doc.title,
        summary: card?.summary ?? '',
        outline: card?.outline ?? [],
        blocks: top.map((b) => ({ id: b.id, type: b.type, text: blockText(b) })),
      },
    });
  }
  return out;
}

/** How many sibling and child titles the planner sees per candidate. */
const TREE_TITLES = 10;

/**
 * Where a page sits: its ancestors' titles (root first, at most 10 levels),
 * and up to 10 live sibling and 10 live child page titles, newest first.
 */
export async function pageTree(
  tx: DbTransaction,
  tenantId: string,
  doc: { id: string; parentId: string | null; spaceId: string }
): Promise<{ path: string[]; siblings: string[]; children: string[] }> {
  const path = rowsOf<{ title: string }>(
    await tx.execute(sql`
      WITH RECURSIVE up(id, parent_id, title, depth) AS (
        SELECT id, parent_id, title, 1 FROM documents
         WHERE tenant_id = ${tenantId}::uuid AND id = ${doc.parentId}::uuid
        UNION ALL
        SELECT d.id, d.parent_id, d.title, up.depth + 1 FROM documents d
          JOIN up ON d.tenant_id = ${tenantId}::uuid AND d.id = up.parent_id
         WHERE up.depth < 10
      )
      SELECT title FROM up ORDER BY depth DESC`)
  ).map((r) => r.title);
  const titlesUnder = async (parentId: string | null, except: string | null) =>
    (
      await tx
        .select({ title: documents.title })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.spaceId, doc.spaceId),
            eq(documents.kind, 'page'),
            isNull(documents.archivedAt),
            parentId === null ? isNull(documents.parentId) : eq(documents.parentId, parentId),
            except ? ne(documents.id, except) : undefined
          )
        )
        .orderBy(desc(documents.createdAt))
        .limit(TREE_TITLES)
    ).map((r) => r.title);
  // Pages at the top of a space are not each other's siblings: that would be the whole space.
  const siblings = doc.parentId === null ? [] : await titlesUnder(doc.parentId, doc.id);
  return { path, siblings, children: await titlesUnder(doc.id, null) };
}

/** Up to 5 corrections in `spaceIds` most similar to the fact. */
async function similarExamples(tx: DbTransaction, tenantId: string, spaceIds: string[], vector: number[]) {
  if (spaceIds.length === 0) return [];
  const literal = `[${vector.join(',')}]`;
  const rows = rowsOf<{ statement: string; title: string }>(
    await tx.execute(sql`
      SELECT e.statement, d.title
        FROM routing_examples e
        JOIN documents d ON d.tenant_id = e.tenant_id AND d.id = e.chosen_document_id
       WHERE e.tenant_id = ${tenantId}::uuid AND e.kind = 'fact' AND e.space_id = ANY(${sql.param(spaceIds)}::uuid[])
       ORDER BY e.statement_embedding <=> ${literal}::halfvec
       LIMIT 5`)
  );
  return rows.map((r) => ({ statement: r.statement, chosenTitle: r.title }));
}

/** Lower-cased, single spaces, no closing punctuation, no Markdown marks: how "the page already says this" compares. */
function comparable(text: string): string {
  return text
    .replace(/[*_`#>]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');
}

function targetOf(edit: PlannedEdit): string {
  return edit.op.op === 'create_page' ? `new:${edit.op.spaceId}` : edit.op.documentId;
}

async function checkEdits(
  tenantId: string,
  ctx: Context,
  candidates: Map<string, Candidate>,
  edits: PlannedEdit[],
  deps: PlanDeps
): Promise<FactPlan> {
  const now = deps.now ?? new Date();
  const waived = deps.onlyPage !== undefined;

  // Unknown pages and blocks, and low confidence, are dropped.
  const valid: PlannedEdit[] = [];
  for (const edit of edits) {
    const op = edit.op;
    if (op.op === 'create_page') {
      if (!ctx.editable.has(op.spaceId) || waived) continue;
      if (op.parentId !== null) {
        const [parent] = await withTenantTx(tenantId, (tx) =>
          tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, op.parentId!)))
        );
        if (!parent || parent.kind !== 'page' || parent.archivedAt || parent.spaceId !== op.spaceId) continue;
      }
      if (edit.confidence < ROUTING.create) continue;
      valid.push(edit);
      continue;
    }
    const candidate = candidates.get(op.documentId);
    if (!candidate) continue;
    const block = op.op === 'insert_after' ? op.after : op.blockId;
    if (block !== null && !candidate.blocks.has(block)) continue;
    if (op.op !== 'already_known' && !waived && edit.confidence < ROUTING.apply) continue;
    valid.push(edit);
  }

  const known = valid.find((e) => e.op.op === 'already_known');
  const changes = valid.filter((e) => e.op.op !== 'already_known');
  if (changes.length === 0) {
    if (known && known.op.op === 'already_known') {
      return { status: 'already_known', documentId: known.op.documentId, blockId: known.op.blockId };
    }
    return { status: 'needs_home', reason: 'No page fits this fact well enough.' };
  }

  // The best target must be clearly ahead of the next (R10).
  const best = new Map<string, number>();
  for (const e of changes) best.set(targetOf(e), Math.max(best.get(targetOf(e)) ?? 0, e.confidence));
  const ranked = [...best.values()].sort((a, b) => b - a);
  if (ranked.length >= 2 && ranked[0]! - ranked[1]! <= ROUTING.margin) {
    return { status: 'needs_home', reason: 'Two pages fit this fact about equally well.' };
  }

  return withTenantTx(tenantId, async (tx) => {
    const spaceRows = await tx.select().from(spaces).where(eq(spaces.tenantId, tenantId));
    const checked: CheckedEdit[] = [];
    let duplicateOf: { documentId: string; blockId: string } | null = null;
    for (const edit of changes) {
      const op = edit.op;
      const spaceId = op.op === 'create_page' ? op.spaceId : candidates.get(op.documentId)!.spaceId;
      let gate: Gate = op.op === 'remove' ? 'removal' : null;
      let conflictCitationId: string | null = null;
      let beforeMarkdown: string | null = null;
      let expectedText: string | null = null;

      if (op.op === 'replace' || op.op === 'remove') {
        const space = spaceRows.find((s) => s.id === spaceId)!;
        const since = new Date(now.getTime() - space.humanProtectionSeconds * 1000);
        const [touched] = await tx
          .select()
          .from(blockActivity)
          .where(
            and(
              eq(blockActivity.tenantId, tenantId),
              eq(blockActivity.pageId, op.documentId),
              eq(blockActivity.blockId, op.blockId),
              eq(blockActivity.actorType, 'user'),
              gt(blockActivity.changedAt, since)
            )
          );
        if (touched && !gate) gate = 'protection';
        const [cited] = await tx
          .select({ id: citations.id })
          .from(citations)
          .where(
            and(
              eq(citations.tenantId, tenantId),
              eq(citations.pageId, op.documentId),
              eq(citations.blockId, op.blockId),
              eq(citations.sourceKind, 'version'),
              eq(citations.state, 'ok')
            )
          );
        if (cited) {
          conflictCitationId = cited.id;
          if (!gate) gate = 'conflict';
        }
        const block = candidates.get(op.documentId)!.blocks.get(op.blockId)!;
        beforeMarkdown = await blockMarkdown(block);
        expectedText = blockFullText(block);
      }
      if (!gate && !ctx.editable.has(spaceId)) gate = 'no_edit_access';

      // Text the page already holds is never added again, whatever the model said
      // (also what makes a retried run safe after its edit already landed).
      if (op.op === 'insert_after' || op.op === 'replace') {
        const wanted = comparable(op.markdown);
        const same = candidates.get(op.documentId)!.card.blocks.find((b) => comparable(b.text) === wanted);
        if (same) {
          duplicateOf = { documentId: op.documentId, blockId: same.id };
          continue;
        }
      }
      if (op.op !== 'create_page' && op.op !== 'already_known' && (await isDuplicate(tx, tenantId, op))) {
        duplicateOf = { documentId: op.documentId, blockId: op.op === 'insert_after' ? op.after ?? '' : op.blockId };
        continue;
      }
      checked.push({ edit, spaceId, gate, beforeMarkdown, expectedText, conflictCitationId });
    }
    if (checked.length === 0 && duplicateOf) return { status: 'already_known', ...duplicateOf };
    return { status: 'planned', edits: checked };
  });
}

/** The same change already waits: an open suggestion, or an applied change whose snapshot waits for review. */
async function isDuplicate(
  tx: DbTransaction,
  tenantId: string,
  op: Exclude<PlannedEdit['op'], { op: 'create_page' } | { op: 'already_known' }>
): Promise<boolean> {
  const open = await tx
    .select()
    .from(suggestions)
    .where(
      and(eq(suggestions.tenantId, tenantId), eq(suggestions.documentId, op.documentId), eq(suggestions.status, 'open'))
    );
  const markdown = op.op === 'remove' ? null : op.markdown.trim();
  const kind = op.op === 'insert_after' ? 'insert' : op.op;
  if (
    open.some(
      (s) =>
        s.kind === kind &&
        (op.op === 'insert_after' || s.blockId === op.blockId) &&
        (markdown === null || (s.proposedMarkdown ?? '').trim() === markdown)
    )
  ) {
    return true;
  }
  if (markdown === null) return false;
  const waiting = await tx
    .select({ after: captureChanges.afterMarkdown })
    .from(captureChanges)
    .innerJoin(versions, and(eq(versions.tenantId, captureChanges.tenantId), eq(versions.id, captureChanges.versionId)))
    .where(
      and(
        eq(captureChanges.tenantId, tenantId),
        eq(captureChanges.documentId, op.documentId),
        eq(captureChanges.status, 'applied'),
        eq(versions.status, 'pending_review')
      )
    );
  return waiting.some((w) => w.after.trim() === markdown);
}
