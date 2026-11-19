import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents, withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { ownerActorOf, type Actor } from '@kinote/core';
import { decideReviewItem, reviewItems, type ReviewPanelItem } from '../review/items.js';
import { resolvePageRef } from '../refs.js';
import { defineTool, type ToolContext } from '../tool.js';

/** The panel `kinote_review` shows. */
export const REVIEW_RESOURCE = 'ui://kinote/review';
const APP_ONLY = { ui: { visibility: ['app' as const] } };
const PANEL = 'Used by the Kinote review panel.';

const listInput = {
  page_id: z.string().max(64).optional().describe('Only what is waiting on this page'),
  mine_only: z.boolean().optional().describe('Only what this agent proposed'),
};

/** The agent's owner, who decides; an agent without one (it cannot happen for a token) is refused. */
function ownerOf(actor: Actor): Actor {
  const owner = ownerActorOf(actor);
  if (!owner) throw new AppError('forbidden');
  return owner;
}

/** Where the owner reviews in Kinote: a link, or the page's name without PUBLIC_URL. */
function reviewsPage(ctx: ToolContext): string {
  const base = ctx.deps.publicUrl?.replace(/\/+$/, '');
  return base ? `${base}/w/${encodeURIComponent(ctx.agent.tenantSlug)}/reviews` : 'its Reviews page.';
}

async function approveInClient(ctx: ToolContext): Promise<boolean> {
  const [row] = await withTenantTx(ctx.actor.tenantId, (tx) =>
    tx
      .select({ on: agents.approveInClient })
      .from(agents)
      .where(and(eq(agents.tenantId, ctx.actor.tenantId), eq(agents.id, ctx.agent.agentId)))
  );
  return row?.on ?? false;
}

async function listFor(ctx: ToolContext, args: { page_id?: string; mine_only?: boolean }) {
  const pageId = args.page_id ? (await withTenantTx(ctx.actor.tenantId, (tx) => resolvePageRef(tx, ctx.actor, args.page_id!))).id : undefined;
  const items = await reviewItems(ownerOf(ctx.actor), {
    ...(pageId ? { pageId } : {}),
    ...(args.mine_only ? { agentId: ctx.agent.agentId } : {}),
  });
  return { pageId: pageId ?? null, items };
}

function line(i: ReviewPanelItem): string {
  const what = i.kind === 'archive' ? `${i.reason ?? ''}` : i.reason ? i.reason : i.type === 'version' ? 'a new version of the page' : '';
  return `• ${i.kind} on "${i.page.title}" by ${i.proposer.name}${what ? ` — ${what}` : ''}${i.decidable ? '' : ` (${i.why_not})`}`;
}

export const reviewTool = defineTool({
  name: 'kinote_review',
  scope: 'read',
  limit: 'search',
  meta: { ui: { resourceUri: REVIEW_RESOURCE } },
  description:
    'Show your user what is waiting for their review (page versions, suggested edits, delete requests) in a Kinote panel where they approve or reject each. You get the list too. Narrow with page_id or mine_only.',
  input: listInput,
  async run(args, ctx) {
    const { pageId, items } = await listFor(ctx, args);
    const head = items.length === 0 ? 'Nothing is waiting for your user.' : `${items.length} waiting for your user:`;
    const text = [
      head,
      ...items.map(line),
      `Kinote opened a review panel for your user. If none is shown, they can review in Kinote: ${reviewsPage(ctx)}`,
    ].join('\n');
    return { text, structured: { page_id: pageId, mine_only: args.mine_only ?? false } };
  },
});

export const reviewListTool = defineTool({
  name: 'kinote_review_list',
  scope: 'read',
  limit: 'search',
  meta: APP_ONLY,
  description: `${PANEL} What is waiting for your user's review.`,
  input: listInput,
  async run(args, ctx) {
    const { items } = await listFor(ctx, args);
    const canDecide = await approveInClient(ctx);
    return { text: `${items.length} waiting.`, structured: { items, can_decide_here: canDecide, reviews_url: reviewsPage(ctx) } };
  },
});

export const reviewDecideTool = defineTool({
  name: 'kinote_review_decide',
  scope: 'edit',
  limit: 'edit',
  writes: true,
  meta: APP_ONLY,
  description: `${PANEL} Approves or rejects one item as your user.`,
  input: {
    type: z.enum(['version', 'suggestion']),
    id: z.string().uuid(),
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(300).optional(),
  },
  async run(args, ctx) {
    if (!(await approveInClient(ctx))) {
      const message = `Approve this in Kinote: ${reviewsPage(ctx)}`;
      return { text: message, structured: { ok: false, message } };
    }
    if (!ctx.deps.collab) throw new AppError('internal_error');
    const res = await decideReviewItem(
      ownerOf(ctx.actor),
      { type: args.type, id: args.id, decision: args.decision, ...(args.note ? { note: args.note } : {}) },
      ctx.deps.collab,
      { agentId: ctx.agent.agentId }
    );
    const text = res.ok ? `${args.decision === 'approve' ? 'Approved' : 'Rejected'}.` : res.message;
    return { text, structured: res };
  },
});

