import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  withTenantTx,
  captures,
  documents,
  memberships,
  pages,
  spaces,
  tenants,
  users,
  versions,
} from '@kinote/db';
import {
  blockText,
  buildPageCard,
  encodeBlocksYDoc,
  extractVersionEntities,
  indexVersion,
  markdownBlocks,
  planCapture,
  planDocument,
  splitCaptureText,
  decideShape,
  ROUTING,
  type EmbeddingProvider,
  type PlannedOp,
  type RoutingModel,
} from '../../src/index.js';

interface CorpusPage {
  title: string;
  markdown: string;
  /** Child pages, seeded under this one. */
  children?: CorpusPage[];
}
interface Corpus {
  spaces: Array<{ name: string; pages: CorpusPage[] }>;
}
type ExpectedOp = 'insert' | 'replace' | 'remove' | 'already_known' | 'needs_home';
interface Expected {
  fact: number;
  documentTitle: string | null;
  /** Several when more than one edit is right (e.g. "X too" may extend a block or add one). */
  op: ExpectedOp | ExpectedOp[];
}
interface LabelledCapture {
  text: string;
  /** A document: its page should go under `parent`; `expect` then lists standing edits, matched as a set. */
  document?: { parent: string };
  expect: Expected[];
}

/**
 * Who a miss is on. Kinote's: `retrieval` (the expected page was never shown
 * to the model) and `engine` (the model proposed the expected edit, the
 * checks turned it into something else). The model's: `split` (a labelled
 * fact did not come out of the split, or an unlabelled one did), `shape`,
 * `model` (shown the right page, proposed something else) and `error` (no
 * usable answer).
 */
export type MissCause = 'split' | 'shape' | 'retrieval' | 'engine' | 'model' | 'error';
export const KINOTE_CAUSES: readonly MissCause[] = ['retrieval', 'engine'];

export interface RoutingMiss {
  capture: string;
  fact: number;
  expected: string;
  got: string;
  cause: MissCause;
  /** What the model was shown and proposed, or why the engine changed it. */
  detail: string;
}

export interface RoutingEvalResult {
  /** Labelled facts (a document's placement counts as one): the denominator. */
  facts: number;
  /** Facts the engine gave a page (planned or already known). */
  placed: number;
  /** Labelled facts routed as labelled; a correct "needs a home" counts. */
  hits: number;
  /** hits / facts: abstaining is a miss, never left out. */
  hitRate: number;
  needsHome: number;
  /** Removals that would have applied without a person: must be 0 (R2). */
  wrongRemovals: number;
  /** Ungated replaces planned for a fact the split called a removal: R2's gate does not see these. */
  removalsAsReplace: number;
  /** Inserts or replaces whose text the target page already holds. */
  duplicates: number;
  /** Facts the split produced that no label covers. */
  extraFacts: number;
  misses: RoutingMiss[];
  causes: Record<MissCause, number>;
  /** Labelled documents, and those placed under the expected parent. */
  documents: number;
  documentHits: number;
  /** An updates capture that would get a page, or a document that would not. */
  shapeMisses: number;
}

const here = (name: string) => new URL(name, import.meta.url);
const comparable = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');

/**
 * Seeds the labelled corpus into the current database (one fresh tenant),
 * plans every labelled capture as a dry run, and scores where facts went,
 * naming for each miss whether Kinote or the model is behind it.
 * Needs a migrated database behind `withTenantTx` (tests and the CLI use PGlite).
 */
export async function runRoutingEval(
  model: RoutingModel,
  embedder: EmbeddingProvider,
  opts: { onRoutingStart?: () => void } = {}
): Promise<RoutingEvalResult> {
  const corpus = JSON.parse(readFileSync(here('./corpus.json'), 'utf8')) as Corpus;
  const labelled = JSON.parse(readFileSync(here('./captures.json'), 'utf8')) as LabelledCapture[];

  const tenantId = randomUUID();
  const userId = randomUUID();
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: 'Eval', slug: `eval-${tenantId}` });
    await tx.insert(users).values({ id: userId, email: `${userId}@eval.local`, name: 'Evaluator', passwordHash: 'x' });
    await tx.insert(memberships).values({ tenantId, userId, role: 'owner' });
  });

  const titles = new Map<string, string>();
  for (const space of corpus.spaces) {
    const spaceId = randomUUID();
    await withTenantTx(tenantId, (tx) =>
      tx.insert(spaces).values({ id: spaceId, tenantId, name: space.name, slug: `s-${spaceId}`, createdBy: userId })
    );
    const seed = async (page: CorpusPage, parentId: string | null) => {
      const documentId = randomUUID();
      const versionId = randomUUID();
      const blocks = await markdownBlocks(page.markdown);
      await withTenantTx(tenantId, async (tx) => {
        await tx.insert(documents).values({ id: documentId, tenantId, spaceId, parentId, kind: 'page', title: page.title, createdByType: 'user', createdBy: userId });
        await tx.insert(versions).values({
          id: versionId, tenantId, documentId, number: 1, title: page.title, status: 'indexing',
          contentHash: `h-${versionId}`, reason: 'quiet', createdByType: 'user', createdBy: userId,
          markdown: page.markdown, blocks,
        });
        await tx
          .update(documents)
          .set({ latestVersionId: versionId })
          .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)));
        await tx.insert(pages).values({
          tenantId, documentId, spaceId, slug: `p-${documentId}`, ydocState: encodeBlocksYDoc(page.title, blocks),
        });
      });
      await indexVersion({ tenantId, versionId }, embedder);
      await buildPageCard({ tenantId, versionId }, model, embedder);
      await extractVersionEntities({ tenantId, versionId }, model, embedder);
      titles.set(documentId, page.title);
      titles.set(`text:${documentId}`, blocks.map((b) => comparable(blockText(b))).join('\n'));
      for (const child of page.children ?? []) await seed(child, documentId);
    };
    for (const page of space.pages) await seed(page, null);
  }

  const result: RoutingEvalResult = {
    facts: 0, placed: 0, hits: 0, hitRate: 0, needsHome: 0, wrongRemovals: 0, removalsAsReplace: 0, duplicates: 0,
    extraFacts: 0, misses: [], causes: { split: 0, shape: 0, retrieval: 0, engine: 0, model: 0, error: 0 },
    documents: 0, documentHits: 0, shapeMisses: 0,
  };
  type Planned = Awaited<ReturnType<typeof planCapture>>[number];
  type Got = { title: string | null; op: string };
  const opOf = (op: PlannedOp['op']): string => (op === 'insert_after' || op === 'create_page' ? 'insert' : op);
  const titleOf = (op: PlannedOp) => ('documentId' in op ? titles.get(op.documentId) ?? null : null);
  const gotOf = (p: Planned): Got => {
    if (p.plan.status === 'planned') {
      const op = p.plan.edits[0]?.edit.op;
      return { title: op ? titleOf(op) : null, op: op ? opOf(op.op) : 'needs_home' };
    }
    if (p.plan.status === 'already_known') return { title: titles.get(p.plan.documentId) ?? null, op: 'already_known' };
    return { title: null, op: 'needs_home' };
  };
  const show = (g: Got) => `${g.op} on ${g.title}`;
  const opsOf = (e: Expected) => (Array.isArray(e.op) ? e.op : [e.op]);
  const matches = (e: Expected, g: Got) => g.title === e.documentTitle && (opsOf(e) as string[]).includes(g.op);
  const label = (e: Expected) => `${opsOf(e).join(' or ')} on ${e.documentTitle}`;
  const checkEdits = (p: Planned) => {
    if (p.plan.status !== 'planned') return;
    for (const e of p.plan.edits) {
      if (e.edit.op.op === 'remove' && e.gate === null) result.wrongRemovals += 1;
      if (e.edit.op.op === 'replace' && e.gate === null && p.fact.kind === 'removal') result.removalsAsReplace += 1;
      const target = e.edit.op;
      if ((target.op === 'insert_after' || target.op === 'replace') && titles.get(`text:${target.documentId}`)?.split('\n').includes(comparable(target.markdown))) {
        result.duplicates += 1;
      }
    }
  };
  const miss = (m: RoutingMiss) => {
    result.misses.push(m);
    result.causes[m.cause] += 1;
  };

  // What the model was shown and proposed for each fact, by statement (facts are planned one at a time).
  type Call = { shown: string[]; proposed: Array<Got & { confidence: number }> };
  let calls = new Map<string, Call>();
  let shownForDocument: string[] = [];
  const recorder: RoutingModel = new Proxy(model, {
    get(target, key) {
      if (key === 'planEdits') {
        return async (input: Parameters<RoutingModel['planEdits']>[0]) => {
          const out = await target.planEdits(input);
          calls.set(input.fact.statement, {
            shown: input.candidates.map((c) => c.title),
            proposed: out.edits.map((e) => ({ title: titleOf(e.op), op: opOf(e.op.op), confidence: e.confidence })),
          });
          return out;
        };
      }
      if (key === 'placeDocument') {
        return async (input: Parameters<RoutingModel['placeDocument']>[0]) => {
          shownForDocument = input.candidates.map((c) => c.title);
          return target.placeDocument(input);
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  /** Why a labelled fact was not routed as labelled, given the calls that could have routed it. */
  const blame = (e: Expected, got: string, related: Call[], plans: Planned[]): Pick<RoutingMiss, 'cause' | 'detail'> => {
    const proposed = related.flatMap((c) => c.proposed);
    const proposedText = proposed.map((g) => `${show(g)} @${g.confidence.toFixed(2)}`).join('; ') || 'no edits';
    if (e.documentTitle !== null) {
      if (related.length === 0) {
        const asked = plans.find((p) => p.plan.status === 'question');
        return asked
          ? { cause: 'engine', detail: `the engine asked "${asked.plan.status === 'question' ? asked.plan.question : ''}" before the model saw it` }
          : { cause: 'retrieval', detail: 'no candidate page was found, so the model was never asked' };
      }
      const shown = [...new Set(related.flatMap((c) => c.shown))];
      if (!shown.includes(e.documentTitle)) {
        return { cause: 'retrieval', detail: `"${e.documentTitle}" was not among the pages shown: ${shown.join(', ')}` };
      }
      const right = proposed.find((g) => matches(e, g));
      if (right) {
        return {
          cause: 'engine',
          detail: `the model proposed ${show(right)} @${right.confidence.toFixed(2)}; the checks made it ${got} (floor ${ROUTING.apply}, margin ${ROUTING.margin})`,
        };
      }
    }
    return { cause: 'model', detail: `proposed ${proposedText}` };
  };

  opts.onRoutingStart?.();
  for (const item of labelled) {
    calls = new Map();
    shownForDocument = [];
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx.insert(captures).values({ tenantId, senderType: 'user', senderId: userId, channel: 'console', text: item.text }).returning()
    );
    try {
      // One split per capture: its shape decides the path, its facts are planned.
      const split = await splitCaptureText(item.text, recorder);
      const shape = decideShape('auto', split.shape);
      const facts = split.facts.map((fact, ordinal) => ({ ordinal, factId: null, fact, pinnedEntityIds: [] }));

      if (item.document) {
        result.documents += 1;
        result.facts += 1;
        if (shape !== 'document') {
          result.shapeMisses += 1;
          result.facts += item.expect.length;
          miss({ capture: item.text, fact: -1, expected: `a page under ${item.document.parent}`, got: 'updates', cause: 'shape', detail: `shape ${split.shape?.shape ?? 'none'} @${split.shape?.confidence ?? 0}` });
          for (const e of item.expect) miss({ capture: item.text, fact: e.fact, expected: label(e), got: 'not planned', cause: 'shape', detail: 'the capture was not taken as a document' });
          continue;
        }
        const title = split.shape?.title ?? '';
        const placement = await planDocument(
          { tenantId, captureId: row!.id, title, subject: split.shape?.subject ?? null, names: [...new Set(split.facts.flatMap((f) => f.names))] },
          { model: recorder, embedder }
        );
        const parent = placement.status === 'place' && placement.parentId ? titles.get(placement.parentId) ?? null : null;
        if (placement.status === 'place') result.placed += 1;
        else result.needsHome += 1;
        if (parent === item.document.parent) {
          result.hits += 1;
          result.documentHits += 1;
        } else {
          const shownHere = shownForDocument.includes(item.document.parent);
          miss({
            capture: item.text, fact: -1, expected: `a page under ${item.document.parent}`, got: `${placement.status} under ${parent}`,
            cause: shownHere ? 'model' : 'retrieval',
            detail: shownHere ? 'the parent was shown to the model' : `"${item.document.parent}" was not among the pages shown: ${shownForDocument.join(', ')}`,
          });
        }
        const planned = await planCapture({ tenantId, captureId: row!.id }, { model: recorder, embedder, facts, fromDocument: { pageId: null, title } });
        planned.forEach(checkEdits);
        const got = planned.map(gotOf);
        for (const e of item.expect) {
          result.facts += 1;
          result.placed += 1;
          if (got.some((g) => matches(e, g))) result.hits += 1;
          else {
            const gotText = got.map(show).join('; ');
            miss({ capture: item.text, fact: e.fact, expected: label(e), got: gotText, ...blame(e, gotText, [...calls.values()], planned) });
          }
        }
        continue;
      }

      if (shape === 'document') {
        result.shapeMisses += 1;
        miss({ capture: item.text, fact: -1, expected: 'updates', got: 'a document', cause: 'shape', detail: `shape document @${split.shape?.confidence ?? 0}` });
      }
      const planned = await planCapture({ tenantId, captureId: row!.id }, { model: recorder, embedder, facts });
      planned.forEach(checkEdits);
      for (const p of planned) {
        if (item.expect.some((e) => e.fact === p.ordinal)) continue;
        result.extraFacts += 1;
        miss({ capture: item.text, fact: p.ordinal, expected: '(no label)', got: show(gotOf(p)), cause: 'split', detail: `the split made ${planned.length} facts; this one is "${p.fact.statement}"` });
      }
      for (const e of item.expect) {
        result.facts += 1;
        const p = planned.find((q) => q.ordinal === e.fact);
        if (!p) {
          miss({ capture: item.text, fact: e.fact, expected: label(e), got: 'no such fact', cause: 'split', detail: `the split made ${planned.length} facts: ${planned.map((q) => `"${q.fact.statement}"`).join(', ')}` });
          continue;
        }
        const got = gotOf(p);
        if (got.op === 'needs_home') result.needsHome += 1;
        else result.placed += 1;
        if (matches(e, got)) result.hits += 1;
        else {
          const call = calls.get(p.fact.statement);
          miss({ capture: item.text, fact: e.fact, expected: label(e), got: show(got), ...blame(e, show(got), call ? [call] : [], [p]) });
        }
      }
    } catch (err) {
      // No usable answer (router_unavailable and the like): every label on this capture is a miss.
      const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      for (const e of item.expect) {
        result.facts += 1;
        miss({ capture: item.text, fact: e.fact, expected: label(e), got: 'error', cause: 'error', detail: reason });
      }
      if (item.document) {
        result.documents += 1;
        result.facts += 1;
      }
    }
  }
  result.hitRate = result.facts === 0 ? 0 : result.hits / result.facts;
  return result;
}
