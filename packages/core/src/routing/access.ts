import { and, eq } from 'drizzle-orm';
import { memberships, spaces, type DbTransaction } from '@kinote/db';
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
 * role, or an agent. A user who has left the tenant is `forbidden`.
 */
export async function senderActor(
  tx: DbTransaction,
  sender: { tenantId: string; type: 'user' | 'agent'; id: string }
): Promise<Actor> {
  if (sender.type === 'agent') return { tenantId: sender.tenantId, principalType: 'agent', principalId: sender.id };
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
