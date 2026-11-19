import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { documents, spaces, withTenantTx, type DbTransaction } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { capturesAlwaysReviewed, pageSlug, takePageSnapshot, type Actor } from '@kinote/core';
import { createPage, movePage, restorePage } from '../../routes/pages.js';
import { shortId } from '../format.js';
import { resolvePageRef, resolveSpaceRef, ToolError } from '../refs.js';
import { defineTool } from '../tool.js';

/** Where `under` points: a page (the new place is its child) or a space (its top level). */
interface Place {
  spaceId: string;
  parentId: string | null;
  /** `"<page title>"` or `the top of <space>`. */
  label: string;
}

const topOf = (spaceName: string) => `the top of ${spaceName}`;

/** A page ref first, then a space name or id; a miss is the space refusal (it lists the readable spaces). */
export async function resolvePlace(tx: DbTransaction, actor: Actor, under: string): Promise<Place> {
  try {
    const doc = await resolvePageRef(tx, actor, under);
    return { spaceId: doc.spaceId, parentId: doc.id, label: `"${doc.title}"` };
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
  }
  const space = await resolveSpaceRef(tx, actor, under);
  return { spaceId: space.id, parentId: null, label: topOf(space.name) };
}

/** Where a document now is, as a label. */
async function placeOf(tx: DbTransaction, tenantId: string, doc: { spaceId: string; parentId: string | null }): Promise<string> {
  if (doc.parentId) {
    const [parent] = await tx
      .select({ title: documents.title })
      .from(documents)
      .where(and(eq(documents.tenantId, tenantId), eq(documents.id, doc.parentId)));
    if (parent) return `"${parent.title}"`;
  }
  const [space] = await tx.select({ name: spaces.name }).from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.id, doc.spaceId)));
  return topOf(space?.name ?? 'its space');
}

/** One plain sentence for a refusal from the page routes; anything else is rethrown. */
function refusal(err: unknown, forbidden: string): never {
  if (err instanceof AppError) {
    const text: Record<string, string> = {
      forbidden,
      parent_cycle: "A page can't go inside itself or its own sub-pages.",
      parent_not_found: 'No page there that this agent can read. Use kinote_browse to find it.',
      page_not_found: 'No page there that this agent can read. Use kinote_browse to find it.',
      slug_taken: 'A page with the same address is already there.',
      page_archived: 'The page is deleted. Restore it first with kinote_restore.',
      space_archived: 'That space is archived.',
    };
    if (text[err.code]) throw new ToolError(text[err.code]!);
  }
  throw err;
}

export const createTool = defineTool({
  name: 'kinote_create',
  scope: 'edit',
  limit: 'edit',
  writes: true,
  description:
    'Create a page at an exact place: under a page (its id) or at the top of a space (its name). Use kinote_capture instead to let Kinote decide where text belongs. The page waits for review where edits do.',
  input: {
    title: z.string().trim().min(1).max(200),
    under: z.string().min(1).max(200).describe('A page ID (the new page goes under it) or a space name or ID (its top level)'),
    markdown: z.string().max(1_000_000).default(''),
  },
  async run(args, ctx) {
    const { actor, agent } = ctx;
    const place = await withTenantTx(actor.tenantId, (tx) => resolvePlace(tx, actor, args.under));
    const page = await createPage(actor, {
      space_id: place.spaceId,
      parent_id: place.parentId,
      title: args.title,
      slug: pageSlug(args.title, randomBytes(4).toString('hex')),
      markdown: args.markdown,
    }).catch((err) => refusal(err, 'no edit access: a person can add pages there'));
    ctx.touch([page.id]);
    const forceReview = await withTenantTx(actor.tenantId, (tx) =>
      capturesAlwaysReviewed(tx, { tenantId: actor.tenantId, type: 'agent', id: agent.agentId })
    );
    const version = await takePageSnapshot({
      tenantId: actor.tenantId,
      pageId: page.id,
      reason: 'agent',
      actorType: 'agent',
      actorId: agent.agentId,
      manual: false,
      forceReview,
    });
    const detail = version?.status === 'pending_review' ? 'waiting for review' : 'indexing';
    return `Created "${page.title}" (${shortId(page.id)}) under ${place.label} — ${detail}.`;
  },
});

export const moveTool = defineTool({
  name: 'kinote_move',
  scope: 'edit',
  limit: 'edit',
  writes: true,
  description:
    'Move a page (its id) under another page (its id) or to the top of a space (its name). Moving to a space that needs review sends the page back to review.',
  input: {
    page_id: z.string().min(1).max(64),
    under: z.string().min(1).max(200).describe('A page ID or a space name or ID'),
  },
  async run(args, ctx) {
    const { actor } = ctx;
    const { doc, place } = await withTenantTx(actor.tenantId, async (tx) => ({
      doc: await resolvePageRef(tx, actor, args.page_id),
      place: await resolvePlace(tx, actor, args.under),
    }));
    ctx.touch([doc.id]);
    const moved = await movePage(actor, doc.id, { target_space_id: place.spaceId, target_parent_id: place.parentId }).catch((err) =>
      refusal(err, 'no edit access: a person can move it')
    );
    const back = doc.indexedVersionId !== null && moved.indexedVersionId === null;
    return `Moved "${doc.title}" under ${place.label}.${back ? ' It waits for review again.' : ''}`;
  },
});

export const restoreTool = defineTool({
  name: 'kinote_restore',
  scope: 'edit',
  limit: 'edit',
  writes: true,
  description:
    'Bring back a deleted (archived) page by its id; kinote_browse with archived lists them. It returns under its old parent, or at the top of its space if that is gone, and waits for review before it is searchable.',
  input: {
    page_id: z.string().min(1).max(64),
  },
  async run(args, ctx) {
    const { actor } = ctx;
    const doc = await withTenantTx(actor.tenantId, (tx) => resolvePageRef(tx, actor, args.page_id, { archived: true }));
    ctx.touch([doc.id]);
    const restored = await restorePage(actor, doc.id).catch((err) => refusal(err, 'no edit access: a person can restore it'));
    const label = await withTenantTx(actor.tenantId, (tx) => placeOf(tx, actor.tenantId, restored));
    return `Restored "${restored.title}" under ${label}. It waits for review before it is searchable again.`;
  },
});

export const TREE_TOOLS = [createTool, moveTool, restoreTool] as const;
