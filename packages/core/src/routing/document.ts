import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenantTx, captures, documents, rowsOf, spaces, type DbTransaction } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import type { EmbeddingProvider } from '../embedding.js';
import type { DocumentPlacement, RoutingModel } from '../placement/model.js';
import { captureContext, captureParts, gatherCandidates, resolveNames, ROUTING, type Candidate, type Context } from './plan.js';

/** Where a document capture's page goes, or why it waits for a person (with parents to offer). */
export type DocumentPlan =
  | { status: 'place'; spaceId: string; parentId: string | null; title: string; confidence: number; reason: string }
  | {
      status: 'needs_home';
      reason: string;
      options: Array<{ pageId: string; title: string; spaceId: string; spaceName: string }>;
    };

/** Most parents offered when a document waits for a person. */
const MAX_OPTIONS = 3;

/**
 * Plans where a document capture's page goes (a dry run). A page scope is the
 * parent. Otherwise the model chooses among candidates found for the whole
 * note, seeing their page trees and earlier document corrections; the
 * placement must be in a space the sender can edit, reach the edit threshold
 * and be clearly ahead of a different parent. The title is made unique
 * among the parent's live children.
 */
export async function planDocument(
  params: { tenantId: string; captureId: string; title: string; subject: string | null; names: string[] },
  deps: { model: RoutingModel; embedder: EmbeddingProvider }
): Promise<DocumentPlan> {
  const { tenantId, captureId, title, subject, names } = params;
  const { capture, ctx } = await withTenantTx(tenantId, async (tx) => {
    const [capture] = await tx.select().from(captures).where(and(eq(captures.tenantId, tenantId), eq(captures.id, captureId)));
    if (!capture) throw new AppError('capture_not_found');
    return { capture, ctx: await captureContext(tx, tenantId, capture) };
  });

  if (capture.scopePageId) {
    const scope = capture.scopePageId;
    return withTenantTx(tenantId, async (tx) => {
      const [page] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, scope)));
      if (!page || page.kind !== 'page' || page.archivedAt || !ctx.editable.has(page.spaceId)) {
        return { status: 'needs_home', reason: "You can't add pages here.", options: [] };
      }
      return {
        status: 'place',
        spaceId: page.spaceId,
        parentId: page.id,
        title: await uniqueChildTitle(tx, tenantId, page.spaceId, page.id, title),
        confidence: 1,
        reason: 'Captured from this page.',
      };
    });
  }

  // Candidates for the whole note; a name two entities fit equally is skipped, never asked about.
  const text = captureParts(capture.text)[0] ?? capture.text;
  const resolved: string[] = [];
  for (const name of names) resolved.push(...(await resolveNames(tenantId, ctx, [name], [])).resolved);
  const [vector] = await deps.embedder.embed([text], 'query');
  const { candidates, examples, spaceNames } = await withTenantTx(tenantId, async (tx) => {
    const fact = { statement: text, kind: 'new' as const, names, date: null };
    const candidates = await gatherCandidates(tx, ctx, fact, vector!, resolved);
    const spaceIds = [...new Set([...candidates.values()].map((c) => c.spaceId))];
    const rows = await tx.select({ id: spaces.id, name: spaces.name }).from(spaces).where(eq(spaces.tenantId, tenantId));
    return {
      candidates,
      examples: await similarDocumentExamples(tx, tenantId, spaceIds, vector!),
      spaceNames: new Map(rows.map((r) => [r.id, r.name])),
    };
  });

  const { placements } = await deps.model.placeDocument({
    title,
    subject,
    text,
    candidates: [...candidates.values()].map((c) => c.card),
    examples,
    writableSpaces: ctx.writableSpaces,
  });

  return withTenantTx(tenantId, async (tx) => {
    const options = await parentOptions(tx, tenantId, ctx, candidates, placements, spaceNames);
    const best = [...placements].sort((a, b) => b.confidence - a.confidence)[0];
    if (best && !ctx.editable.has(best.spaceId) && ctx.filter.spaceIds.includes(best.spaceId)) {
      return { status: 'needs_home', reason: "The best place is in a space you can't edit.", options };
    }
    const valid: DocumentPlacement[] = [];
    for (const p of placements) {
      if (!ctx.editable.has(p.spaceId) || p.confidence < ROUTING.apply) continue;
      if (p.parentId !== null && !(await isParent(tx, tenantId, p.spaceId, p.parentId))) continue;
      valid.push(p);
    }
    valid.sort((a, b) => b.confidence - a.confidence);
    const [top, next] = valid;
    if (!top) return { status: 'needs_home', reason: 'No place fits this page well enough.', options };
    if (next && next.parentId !== top.parentId && top.confidence - next.confidence <= ROUTING.margin) {
      return { status: 'needs_home', reason: 'Two places fit this page about equally well.', options };
    }
    return {
      status: 'place',
      spaceId: top.spaceId,
      parentId: top.parentId,
      title: await uniqueChildTitle(tx, tenantId, top.spaceId, top.parentId, top.title),
      confidence: top.confidence,
      reason: top.reason,
    };
  });
}

/** A live page outside the Inbox, in `spaceId`. */
async function isParent(tx: DbTransaction, tenantId: string, spaceId: string, pageId: string): Promise<boolean> {
  const [doc] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, pageId)));
  return !!doc && doc.kind === 'page' && !doc.archivedAt && doc.spaceId === spaceId;
}

/** Up to 3 parents to offer: the model's placements first, then candidates with children; editable spaces only. */
async function parentOptions(
  tx: DbTransaction,
  tenantId: string,
  ctx: Context,
  candidates: Map<string, Candidate>,
  placements: DocumentPlacement[],
  spaceNames: Map<string, string>
) {
  const ids: string[] = [];
  for (const p of placements) if (p.parentId) ids.push(p.parentId);
  for (const c of candidates.values()) if (c.card.children.length > 0) ids.push(c.card.documentId);
  const out: DocumentPlan & { status: 'needs_home' } = { status: 'needs_home', reason: '', options: [] };
  for (const id of new Set(ids)) {
    if (out.options.length >= MAX_OPTIONS) break;
    const [doc] = await tx.select().from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, id)));
    if (!doc || doc.kind !== 'page' || doc.archivedAt || !ctx.editable.has(doc.spaceId)) continue;
    out.options.push({ pageId: doc.id, title: doc.title, spaceId: doc.spaceId, spaceName: spaceNames.get(doc.spaceId) ?? '' });
  }
  return out.options;
}

/** `title`, or `title (2)`, `title (3)`, … when a live page under the same parent already has it (any case). */
export async function uniqueChildTitle(
  tx: DbTransaction,
  tenantId: string,
  spaceId: string,
  parentId: string | null,
  title: string
): Promise<string> {
  const rows = await tx
    .select({ title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.spaceId, spaceId),
        parentId === null ? isNull(documents.parentId) : eq(documents.parentId, parentId),
        isNull(documents.archivedAt)
      )
    );
  const taken = new Set(rows.map((r) => r.title.trim().toLowerCase()));
  if (!taken.has(title.trim().toLowerCase())) return title;
  for (let n = 2; ; n++) {
    const candidate = `${title} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Up to 5 document corrections in `spaceIds` most similar to the note. */
export async function similarDocumentExamples(tx: DbTransaction, tenantId: string, spaceIds: string[], vector: number[]) {
  if (spaceIds.length === 0) return [];
  const literal = `[${vector.join(',')}]`;
  const rows = rowsOf<{ statement: string; title: string }>(
    await tx.execute(sql`
      SELECT e.statement, d.title
        FROM routing_examples e
        JOIN documents d ON d.tenant_id = e.tenant_id AND d.id = e.chosen_document_id
       WHERE e.tenant_id = ${tenantId}::uuid AND e.kind = 'document' AND e.space_id = ANY(${sql.param(spaceIds)}::uuid[])
       ORDER BY e.statement_embedding <=> ${literal}::halfvec
       LIMIT 5`)
  );
  return rows.map((r) => ({ statement: r.statement, chosenTitle: r.title }));
}
