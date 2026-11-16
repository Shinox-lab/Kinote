import { suggestions, withTenantTx, writeAuditEvent, type DocumentRow } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { capturesAlwaysReviewed, readLiveBlocks, takePageSnapshot, type Actor } from '@kinote/core';
import { documentName, type CollabClient } from '@kinote/shared';
import { CHANGED, GONE, planBlockEdits, type AgentEdit, type EditOutcome } from './plan.js';

/** What a suggestion's reason says when an agent proposed it. */
const reasonOf = (agentName: string, detail: string) => `Proposed by ${agentName} with kinote_edit (${detail}).`;

/**
 * Runs one `kinote_edit` call on a page the agent can read: plans every edit against the live page, applies the
 * applicable ones in one collab change made as the agent (then snapshots, review following the space and the
 * agent's "always review"), writes suggestions for the rest naming the agent, and audits the call. Returns one
 * outcome per edit, in order.
 */
export async function runAgentEdits(
  ctx: { actor: Actor; agentId: string; agentName: string; collab: CollabClient; now?: Date },
  doc: DocumentRow,
  edits: AgentEdit[]
): Promise<{ outcomes: EditOutcome[]; versionId: string | null }> {
  const { actor, agentId, collab } = ctx;
  const tenantId = actor.tenantId;
  const now = ctx.now ?? new Date();
  // What people typed is stored first, so the plan compares live text.
  await collab.flush(documentName(tenantId, doc.id));
  const plan = await withTenantTx(tenantId, async (tx) => {
    const live = await readLiveBlocks(tx, tenantId, doc.id);
    return planBlockEdits(tx, actor, doc, live?.blocks ?? [], edits, now);
  });

  let versionId: string | null = null;
  if (plan.apply.length > 0) {
    let refusedAll: string | null = null;
    try {
      await collab.applyBlockOps({ tenantId, pageId: doc.id, actor: { type: 'agent', id: agentId }, source: 'agent', ops: plan.apply.map((a) => a.op) });
    } catch (err) {
      // Someone changed or removed an addressed block between our read and the apply: nothing was applied.
      if (err instanceof AppError && err.code === 'block_changed') refusedAll = CHANGED;
      else if (err instanceof AppError && err.code === 'block_not_found') refusedAll = GONE;
      else throw err;
    }
    if (refusedAll) {
      for (const { index } of plan.apply) plan.outcomes[index] = { ...plan.outcomes[index]!, result: 'refused', detail: refusedAll };
    } else {
      await collab.flush(documentName(tenantId, doc.id));
      const forceReview = await withTenantTx(tenantId, (tx) => capturesAlwaysReviewed(tx, { tenantId, type: 'agent', id: agentId }));
      const version = await takePageSnapshot({ tenantId, pageId: doc.id, reason: 'agent', actorType: 'agent', actorId: agentId, manual: false, forceReview });
      versionId = version?.id ?? null;
      const detail = version?.status === 'pending_review' ? 'waiting for review' : 'indexing';
      for (const { index } of plan.apply) plan.outcomes[index] = { ...plan.outcomes[index]!, detail };
    }
  }

  const outcomes = plan.outcomes.map((o, i) => o ?? { label: `edit ${i + 1}`, result: 'refused' as const, detail: 'not understood' });
  await withTenantTx(tenantId, async (tx) => {
    if (plan.suggest.length > 0) {
      await tx.insert(suggestions).values(
        plan.suggest.map(({ index, draft }) => ({
          tenantId,
          documentId: doc.id,
          spaceId: doc.spaceId,
          ...draft,
          reason: reasonOf(ctx.agentName, outcomes[index]!.detail),
          proposedByType: 'agent' as const,
          proposedBy: agentId,
        }))
      );
    }
    const count = (r: EditOutcome['result']) => outcomes.filter((o) => o.result === r).length;
    await writeAuditEvent(tx, {
      tenantId,
      type: 'agent.edit',
      actorType: 'agent',
      actorId: agentId,
      subjectType: 'page',
      subjectId: doc.id,
      payload: { applied: count('applied'), suggested: count('suggested'), refused: count('refused'), versionId },
    });
  });
  return { outcomes, versionId };
}
