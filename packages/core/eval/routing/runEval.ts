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
} from '@living-wiki/db';
import {
  blockText,
  buildPageCard,
  encodeBlocksYDoc,
  extractVersionEntities,
  indexVersion,
  markdownBlocks,
  planCapture,
  type EmbeddingProvider,
  type RoutingModel,
} from '../../src/index.js';

interface Corpus {
  spaces: Array<{ name: string; pages: Array<{ title: string; markdown: string }> }>;
}
type ExpectedOp = 'insert' | 'replace' | 'remove' | 'already_known' | 'needs_home';
interface LabelledCapture {
  text: string;
  expect: Array<{ fact: number; documentTitle: string | null; op: ExpectedOp }>;
}

export interface RoutingEvalResult {
  facts: number;
  /** Facts the engine gave a page (planned or already known). */
  placed: number;
  /** Placed facts on the expected page with the expected operation. */
  hits: number;
  hitRate: number;
  needsHome: number;
  /** Removals that would have applied without a person: must be 0 (R2). */
  wrongRemovals: number;
  /** Inserts or replaces whose text the target page already holds. */
  duplicates: number;
  misses: Array<{ capture: string; fact: number; expected: string; got: string }>;
}

const here = (name: string) => new URL(name, import.meta.url);
const comparable = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');

/**
 * Seeds the labelled corpus into the current database (one fresh tenant),
 * plans every labelled capture as a dry run, and scores where facts went.
 * Needs a migrated database behind `withTenantTx` (tests and the CLI use PGlite).
 */
export async function runRoutingEval(model: RoutingModel, embedder: EmbeddingProvider): Promise<RoutingEvalResult> {
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
    for (const page of space.pages) {
      const documentId = randomUUID();
      const versionId = randomUUID();
      const blocks = await markdownBlocks(page.markdown);
      await withTenantTx(tenantId, async (tx) => {
        await tx.insert(documents).values({ id: documentId, tenantId, spaceId, kind: 'page', title: page.title, createdByType: 'user', createdBy: userId });
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
    }
  }

  const result: RoutingEvalResult = { facts: 0, placed: 0, hits: 0, hitRate: 0, needsHome: 0, wrongRemovals: 0, duplicates: 0, misses: [] };
  for (const item of labelled) {
    const [row] = await withTenantTx(tenantId, (tx) =>
      tx.insert(captures).values({ tenantId, senderType: 'user', senderId: userId, channel: 'console', text: item.text }).returning()
    );
    const planned = await planCapture({ tenantId, captureId: row!.id }, { model, embedder });
    for (const p of planned) {
      result.facts += 1;
      const expected = item.expect.find((e) => e.fact === p.ordinal);
      let got: { title: string | null; op: ExpectedOp };
      if (p.plan.status === 'planned') {
        const first = p.plan.edits[0];
        const op = first?.edit.op;
        const docId = op && op.op !== 'create_page' ? op.documentId : null;
        got = {
          title: docId ? titles.get(docId) ?? null : null,
          op: !op ? 'needs_home' : op.op === 'insert_after' ? 'insert' : op.op === 'create_page' ? 'insert' : (op.op as ExpectedOp),
        };
        for (const e of p.plan.edits) {
          if (e.edit.op.op === 'remove' && e.gate === null) result.wrongRemovals += 1;
          const target = e.edit.op;
          if ((target.op === 'insert_after' || target.op === 'replace') && titles.get(`text:${target.documentId}`)?.split('\n').includes(comparable(target.markdown))) {
            result.duplicates += 1;
          }
        }
      } else if (p.plan.status === 'already_known') {
        got = { title: titles.get(p.plan.documentId) ?? null, op: 'already_known' };
      } else {
        got = { title: null, op: 'needs_home' };
      }
      if (got.op === 'needs_home') result.needsHome += 1;
      else result.placed += 1;
      const hit = expected && expected.documentTitle === got.title && expected.op === got.op;
      if (hit && got.op !== 'needs_home') result.hits += 1;
      if (!hit) {
        result.misses.push({
          capture: item.text,
          fact: p.ordinal,
          expected: expected ? `${expected.op} on ${expected.documentTitle}` : '(no label)',
          got: `${got.op} on ${got.title}`,
        });
      }
    }
  }
  result.hitRate = result.placed === 0 ? 0 : result.hits / result.placed;
  return result;
}
