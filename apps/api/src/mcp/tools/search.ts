import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { documents, pageCards, spaces, withTenantTx } from '@kinote/db';
import type { SearchPassage } from '@kinote/contracts';
import { getReadableSpaceIds, keywordSearchWiki, searchPageCards, searchWiki } from '@kinote/core';
import { contentBlock, dataBlock, MAX_RESULT_TOKENS, pageLink, shortId } from '../format.js';
import { resolveSpaceRef, ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

const KEYWORD_NOTE = 'Keyword-only results: meaning search is unavailable right now.';
const MAX_PER_PAGE = 2;

const noMatch = (what: 'passages' | 'pages', query: string) =>
  `No ${what} match "${query}" in the spaces this agent can read. Try other words, or call kinote_browse to see what exists.`;

const updatedOf = (p: SearchPassage) => /updated (\d{4}-\d{2}-\d{2})\)$/.exec(p.citeAs)?.[1] ?? '';

function passageEntry(n: number, p: SearchPassage, ctx: ToolContext): string {
  const where =
    p.documentKind === 'file'
      ? p.pageFrom !== null
        ? p.pageTo !== null && p.pageTo !== p.pageFrom
          ? ` › pages ${p.pageFrom}-${p.pageTo}`
          : ` › page ${p.pageFrom}`
        : ''
      : p.headingPath.length > 0
        ? ` › ${p.headingPath.join(' › ')}`
        : '';
  const link = pageLink(ctx.agent, ctx.deps.publicUrl, p.documentId, p.documentKind);
  // The server's line holds ids, version and link; the title and headings are the page's own text.
  const lines = [`${n}. ${shortId(p.documentId)}, v${p.versionNumber}, updated ${updatedOf(p)}${link ? `  ${link}` : ''}`];
  if (p.documentKind === 'page' && p.blockIds.length > 0) lines.push(`   blocks: ${p.blockIds.map(shortId).join(', ')}`);
  lines.push(contentBlock(shortId(p.documentId), `# ${p.versionTitle}${where}\n\n${p.text}`));
  return lines.join('\n');
}

async function embedQuery(ctx: ToolContext, query: string): Promise<number[] | null> {
  try {
    const [v] = await ctx.deps.embeddingProvider.embed([query], 'query');
    return v ?? null;
  } catch (err) {
    ctx.log.warn({ err }, 'mcp search: query embedding failed');
    return null;
  }
}

async function findPassages(ctx: ToolContext, query: string, spaceRef: string | undefined, limit: number): Promise<string> {
  const { actor, deps } = ctx;
  const vector = await embedQuery(ctx, query);
  const hits = await withTenantTx(actor.tenantId, async (tx) => {
    const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
    const spaceIds = spaceRef === undefined ? readableSpaceIds : [(await resolveSpaceRef(tx, actor, spaceRef)).id];
    if (vector === null) {
      return keywordSearchWiki(tx, actor, spaceIds, inboxSpaceId, query, limit, { maxPerDocument: MAX_PER_PAGE });
    }
    return searchWiki(tx, actor, spaceIds, inboxSpaceId, query, vector, limit, deps.embeddingProvider.model, {
      maxPerDocument: MAX_PER_PAGE,
      maxVectorDistance: deps.searchMaxDistance,
    });
  });
  const lead = vector === null ? `${KEYWORD_NOTE}\n` : '';
  if (hits.length === 0) return `${lead}${noMatch('passages', query)}`;
  // Whole passages only: stop before the one that would pass the cap, and say how many were left out.
  const budget = MAX_RESULT_TOKENS * 4 - lead.length - 200;
  const entries: string[] = [];
  let used = 0;
  for (const [i, h] of hits.entries()) {
    const entry = passageEntry(i + 1, h, ctx);
    if (entries.length > 0 && used + entry.length + 2 > budget) break;
    entries.push(entry);
    used += entry.length + 2;
  }
  ctx.touch(hits.slice(0, entries.length).map((h) => h.documentId));
  const left = hits.length - entries.length;
  const note =
    left > 0
      ? `\n${left} more ${left === 1 ? 'passage' : 'passages'} left out to stay under 6,000 tokens. Lower limit or narrow the query to see them.`
      : '';
  return `${lead}${entries.join('\n\n')}${note}`;
}

async function findPages(ctx: ToolContext, query: string, spaceRef: string | undefined, limit: number): Promise<string> {
  const { actor, deps } = ctx;
  const vector = await embedQuery(ctx, query);
  if (vector === null) {
    throw new ToolError('Meaning search is unavailable right now. Try find "passages", which falls back to keyword search.');
  }
  const rows = await withTenantTx(actor.tenantId, async (tx) => {
    const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
    const spaceIds =
      spaceRef === undefined ? readableSpaceIds.filter((id) => id !== inboxSpaceId) : [(await resolveSpaceRef(tx, actor, spaceRef)).id];
    const cards = (await searchPageCards(tx, { tenantId: actor.tenantId, spaceIds }, vector, limit * 2)).filter(
      (c) => c.distance <= deps.searchMaxDistance
    );
    if (cards.length === 0) return [];
    const ids = cards.map((c) => c.documentId);
    const details = await tx
      .select({ id: documents.id, title: documents.title, space: spaces.name, summary: pageCards.summary })
      .from(documents)
      .innerJoin(spaces, and(eq(spaces.tenantId, documents.tenantId), eq(spaces.id, documents.spaceId)))
      .innerJoin(pageCards, and(eq(pageCards.tenantId, documents.tenantId), eq(pageCards.documentId, documents.id)))
      .where(and(eq(documents.tenantId, actor.tenantId), inArray(documents.id, ids), isNull(documents.archivedAt)));
    const byId = new Map(details.map((d) => [d.id, d]));
    return cards.flatMap((c) => byId.get(c.documentId) ?? []).slice(0, limit);
  });
  ctx.touch(rows.map((r) => r.id));
  if (rows.length === 0) return noMatch('pages', query);
  return dataBlock(
    'results',
    rows
      .map((r, i) => {
        const link = pageLink(ctx.agent, deps.publicUrl, r.id);
        return `${i + 1}. ${r.title} (${shortId(r.id)}, ${r.space}) — ${r.summary.replace(/\s+/g, ' ').trim()}${link ? `  ${link}` : ''}`;
      })
      .join('\n')
  );
}

export const searchTool = defineTool({
  name: 'kinote_search',
  annotations: { title: 'Search the wiki', readOnlyHint: true, openWorldHint: false },
  scope: 'read',
  limit: 'search',
  description:
    'Search the wiki. find "passages" (default) returns the matching text with its page, section and block IDs; find "pages" returns the pages that are about the query. Only approved, indexed content.',
  input: {
    query: z.string().trim().min(1).max(500),
    find: z.enum(['passages', 'pages']).optional(),
    space: z.string().max(200).optional().describe('A space name or ID'),
    limit: z.number().int().min(1).max(10).optional().describe('1 to 10, default 5'),
  },
  async run(args, ctx) {
    const limit = args.limit ?? 5;
    return args.find === 'pages'
      ? findPages(ctx, args.query, args.space, limit)
      : findPassages(ctx, args.query, args.space, limit);
  },
});
