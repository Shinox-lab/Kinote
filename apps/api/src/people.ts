import { and, eq, inArray } from 'drizzle-orm';
import { users, memberships, agents, sources, type DbTransaction } from '@kinote/db';

/** An actor as recorded on content: a user, an agent or a connector (a source), by id. */
export interface ActorRef {
  type: 'user' | 'agent' | 'connector';
  id: string;
}

/** Shown for a user who is not (or no longer) a member of the tenant. */
export const FORMER_MEMBER_NAME = 'Former member';
/** Shown for an agent that is not found in the tenant. */
export const UNKNOWN_AGENT_NAME = 'Agent';
/** Shown for a connector whose source is not found in the tenant (and the start of every source's name). */
export const SYSTEM_NAME = 'System';

/**
 * Display names for actors, keyed `"<type>:<id>"`, in two batched queries (one
 * for all users, one for all agents) and none for an empty list.
 *
 * Tenant-scoped: a user's name is returned only for a MEMBER of `tenantId`
 * (users are global, so the membership join is what keeps another tenant's
 * users private); any other user id is `Former member`. An agent is looked up
 * in the tenant only, and an unknown one is `Agent`. A connector is a source of
 * the tenant, shown as `System · {name}`; one this tenant does not have is
 * plain `System`. Every requested actor has an entry in the result.
 */
export async function resolveActorNames(
  tx: DbTransaction,
  tenantId: string,
  actors: ReadonlyArray<ActorRef>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const userIds = [...new Set(actors.filter((a) => a.type === 'user').map((a) => a.id))];
  const agentIds = [...new Set(actors.filter((a) => a.type === 'agent').map((a) => a.id))];
  const sourceIds = [...new Set(actors.filter((a) => a.type === 'connector').map((a) => a.id))];

  if (userIds.length > 0) {
    const rows = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId)))
      .where(inArray(users.id, userIds));
    const names = new Map(rows.map((r) => [r.id, r.name]));
    for (const id of userIds) result.set(`user:${id}`, names.get(id) ?? FORMER_MEMBER_NAME);
  }
  if (agentIds.length > 0) {
    const rows = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.tenantId, tenantId), inArray(agents.id, agentIds)));
    const names = new Map(rows.map((r) => [r.id, r.name]));
    for (const id of agentIds) result.set(`agent:${id}`, names.get(id) ?? UNKNOWN_AGENT_NAME);
  }
  if (sourceIds.length > 0) {
    const rows = await tx
      .select({ id: sources.id, name: sources.name })
      .from(sources)
      .where(and(eq(sources.tenantId, tenantId), inArray(sources.id, sourceIds)));
    const names = new Map(rows.map((r) => [r.id, r.name]));
    for (const id of sourceIds) {
      const name = names.get(id);
      result.set(`connector:${id}`, name ? `${SYSTEM_NAME} · ${name}` : SYSTEM_NAME);
    }
  }
  return result;
}
