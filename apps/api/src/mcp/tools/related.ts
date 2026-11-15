import { and, desc, eq, inArray, count } from 'drizzle-orm';
import { z } from 'zod';
import { documents, entityMentions, withTenantTx, type DbTransaction } from '@kinote/db';
import {
  entityDisplayNames,
  entityRelations,
  findEntities,
  getReadableSpaceIds,
  pagesForEntities,
  type Actor,
  type PlacementFilter,
} from '@kinote/core';
import { getPageConnections } from '../../routes/connections.js';
import { shortId } from '../format.js';
import { resolvePageRef, ToolError } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

const MENTIONS_SHOWN = 15;
const SHARED_SHOWN = 10;
const TOP_ENTITIES = 10;

/** The readable spaces with the Inbox removed: what the graph may follow. */
async function graphFilter(tx: DbTransaction, actor: Actor): Promise<{ f: PlacementFilter; inboxSpaceId: string }> {
  const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
  return { f: { tenantId: actor.tenantId, spaceIds: readableSpaceIds.filter((id) => id !== inboxSpaceId) }, inboxSpaceId };
}

async function titlesOf(tx: DbTransaction, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, ids)));
  return new Map(rows.map((r) => [r.id, r.title]));
}

const edgeWords = (type: string) => type.replaceAll('_', ' ');

async function byEntity(ctx: ToolContext, name: string, hops: 1 | 2): Promise<string> {
  const { actor } = ctx;
  return withTenantTx(actor.tenantId, async (tx) => {
    const { f } = await graphFilter(tx, actor);
    const [hit] = await findEntities(tx, f, name, 1);
    if (!hit) return `No "${name}" found in the spaces this agent can read. Try kinote_search.`;
    const relations = await entityRelations(tx, f, hit.entityId);
    const pages = (await pagesForEntities(tx, f, [hit.entityId], hops)).slice(0, MENTIONS_SHOWN);
    const titles = await titlesOf(tx, actor.tenantId, pages.map((p) => p.documentId));
    const viaIds = [...new Set(pages.flatMap((p) => (p.hops > 0 ? p.viaEntityIds.filter((id) => id !== hit.entityId) : [])))];
    const viaNames = await entityDisplayNames(tx, f, viaIds);
    ctx.touch(pages.map((p) => p.documentId));

    const lines = [`${hit.name} (${hit.kind})`];
    if (relations.length > 0) {
      lines.push('Relationships:');
      for (const r of relations) {
        lines.push(
          r.direction === 'out'
            ? `- ${hit.name} ${edgeWords(r.type)} ${r.otherName}`
            : `- ${r.otherName} ${edgeWords(r.type)} ${hit.name}`
        );
      }
    }
    if (pages.length > 0) {
      lines.push('Mentioned on:');
      for (const p of pages) {
        const via = p.hops > 0 ? p.viaEntityIds.map((id) => viaNames.get(id)).filter((n): n is string => !!n) : [];
        lines.push(`- ${titles.get(p.documentId) ?? 'Untitled'} (${shortId(p.documentId)})${via.length > 0 ? `, via ${via.join(', ')}` : ''}`);
      }
    }
    return lines.join('\n');
  });
}

async function byPage(ctx: ToolContext, ref: string): Promise<string> {
  const { actor } = ctx;
  const { doc, shared, inboxSpaceId } = await withTenantTx(actor.tenantId, async (tx) => {
    const d = await resolvePageRef(tx, actor, ref);
    const { f, inboxSpaceId } = await graphFilter(tx, actor);
    // The page's most mentioned entities, then other pages that mention them too.
    const top =
      f.spaceIds.length === 0
        ? []
        : await tx
            .select({ entityId: entityMentions.entityId, n: count() })
            .from(entityMentions)
            .where(and(eq(entityMentions.tenantId, actor.tenantId), eq(entityMentions.documentId, d.id), inArray(entityMentions.spaceId, f.spaceIds)))
            .groupBy(entityMentions.entityId)
            .orderBy(desc(count()), entityMentions.entityId)
            .limit(TOP_ENTITIES);
    const topIds = top.map((t) => t.entityId);
    const others = (await pagesForEntities(tx, f, topIds, 1)).filter((p) => p.hops === 0 && p.documentId !== d.id).slice(0, SHARED_SHOWN);
    const names = await entityDisplayNames(tx, f, topIds);
    const titles = await titlesOf(tx, actor.tenantId, others.map((o) => o.documentId));
    return {
      doc: d,
      inboxSpaceId,
      shared: others.map((o) => ({
        id: o.documentId,
        title: titles.get(o.documentId) ?? 'Untitled',
        names: o.viaEntityIds.map((id) => names.get(id)).filter((n): n is string => !!n),
      })),
    };
  });

  const connections =
    doc.kind === 'page' ? await getPageConnections(actor, doc.id) : { linkedFrom: [], updatedBy: [], updated: [] };
  // Leave Inbox items out of every group.
  const connectedIds = [...connections.linkedFrom, ...connections.updatedBy, ...connections.updated].map((c) => c.pageId);
  const inInbox = new Set(
    connectedIds.length === 0
      ? []
      : (
          await withTenantTx(actor.tenantId, (tx) =>
            tx
              .select({ id: documents.id })
              .from(documents)
              .where(and(eq(documents.tenantId, actor.tenantId), inArray(documents.id, connectedIds), eq(documents.spaceId, inboxSpaceId)))
          )
        ).map((r) => r.id)
  );
  const keep = <T extends { pageId: string }>(rows: T[]) => rows.filter((r) => !inInbox.has(r.pageId));
  const linkedFrom = keep(connections.linkedFrom);
  const updatedBy = keep(connections.updatedBy);
  const updated = keep(connections.updated);

  const lines: string[] = [];
  const group = (title: string, rows: string[]) => {
    if (rows.length > 0) lines.push(title, ...rows);
  };
  group('Links in:', linkedFrom.map((c) => `- ${c.title} (${shortId(c.pageId)}) · ${c.spaceName}`));
  group('Updated by captures:', updatedBy.map((c) => `- ${c.title} (${shortId(c.pageId)}) · ${c.spaceName}`));
  group('Updated:', updated.map((c) => `- ${c.title} (${shortId(c.pageId)}) · ${c.spaceName}, ${c.sections} ${c.sections === 1 ? 'section' : 'sections'}`));
  group('Shares entities:', shared.map((s) => `- ${s.title} (${shortId(s.id)}) — ${s.names.join(', ')}`));
  ctx.touch([doc.id, ...linkedFrom.map((c) => c.pageId), ...updatedBy.map((c) => c.pageId), ...updated.map((c) => c.pageId), ...shared.map((s) => s.id)]);
  if (lines.length === 0) return 'Nothing connects to this page yet.';
  return [`# ${doc.title} (${shortId(doc.id)})`, ...lines].join('\n');
}

export const relatedTool = defineTool({
  name: 'kinote_related',
  scope: 'read',
  limit: 'search',
  description:
    'What connects to a page or a named thing: relationships, pages that mention it, links in, and pages a capture updated. Check before editing a fact that may be written on several pages.',
  input: {
    page_id: z.string().max(64).optional(),
    entity: z.string().trim().min(1).max(200).optional().describe('A person, team, system or other named thing'),
    hops: z.union([z.literal(1), z.literal(2)]).optional(),
  },
  async run(args, ctx) {
    if ((args.page_id === undefined) === (args.entity === undefined)) throw new ToolError('Give page_id or entity, not both.');
    return args.entity !== undefined ? byEntity(ctx, args.entity, args.hops ?? 1) : byPage(ctx, args.page_id!);
  },
});
