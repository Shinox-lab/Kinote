import { and, eq } from 'drizzle-orm';
import { agents, memberships, spaces, type DbTransaction } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { requireSpaceRole, type Actor } from '../permissions.js';

/** What a capture's sender may see and change, Inbox left out of both (R17). */
export interface SenderAccess {
  actor: Actor;
  readable: string[];
  editable: string[];
}

/**
 * The actor a capture's sender acts as: a user with their current tenant
 * role, or an agent carrying its owner (so it never reaches more than they
 * can now). A user who has left the tenant is `forbidden`; so is an agent
 * that is disabled, not an external agent, or whose owner has left.
 */
export async function senderActor(
  tx: DbTransaction,
  sender: { tenantId: string; type: 'user' | 'agent'; id: string }
): Promise<Actor> {
  if (sender.type === 'agent') {
    const [agent] = await tx
      .select({ kind: agents.kind, disabledAt: agents.disabledAt, createdBy: agents.createdBy, ownerRole: memberships.role })
      .from(agents)
      .leftJoin(memberships, and(eq(memberships.tenantId, agents.tenantId), eq(memberships.userId, agents.createdBy)))
      .where(and(eq(agents.tenantId, sender.tenantId), eq(agents.id, sender.id)));
    if (!agent || agent.kind !== 'external' || agent.disabledAt || !agent.ownerRole) throw new AppError('forbidden');
    return {
      tenantId: sender.tenantId,
      principalType: 'agent',
      principalId: sender.id,
      owner: { userId: agent.createdBy, tenantRole: agent.ownerRole },
    };
  }
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.tenantId, sender.tenantId), eq(memberships.userId, sender.id)));
  if (!row) throw new AppError('forbidden');
  return { tenantId: sender.tenantId, principalType: 'user', principalId: sender.id, tenantRole: row.role };
}

/**
 * The non-Inbox spaces `actor` can read, and the ones it can edit (editor or
 * above, not archived). Each space goes through the same gate as every route
 * (R8: the engine never widens anyone's access).
 */
export async function senderAccess(tx: DbTransaction, actor: Actor): Promise<SenderAccess> {
  const rows = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.kind, 'normal')));
  const readable: string[] = [];
  const editable: string[] = [];
  for (const { id } of rows) {
    try {
      const { space, effectiveRole } = await requireSpaceRole(tx, actor, id, 'viewer');
      readable.push(id);
      if (!space.archivedAt && effectiveRole !== 'viewer') editable.push(id);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'space_not_found') throw err;
    }
  }
  return { actor, readable, editable };
}

/** Whether a capture's changes are held for review whatever the space says: its sender is an "always review" agent. */
export async function capturesAlwaysReviewed(tx: DbTransaction, sender: { tenantId: string; type: 'user' | 'agent'; id: string }) {
  if (sender.type !== 'agent') return false;
  const [agent] = await tx
    .select({ alwaysReview: agents.alwaysReview })
    .from(agents)
    .where(and(eq(agents.tenantId, sender.tenantId), eq(agents.id, sender.id)));
  return agent?.alwaysReview ?? false;
}
