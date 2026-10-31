import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  withTenantTx,
  users,
  memberships,
  groups,
  groupMembers,
  agents,
  spaceGrants,
  tenants,
  invitations,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  UpdateMemberRoleRequestSchema,
  CreateGroupRequestSchema,
  AddGroupMemberRequestSchema,
  AppError,
  type Member,
  type PendingInvitation,
  type Group,
  type GroupMember,
  type Grant,
  type TenantRole,
} from '@kinote/contracts';
import { requireSpaceRole, type Actor } from '@kinote/core';
import { principalExists } from './foundations.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tenant administration is for tenant owners and admins (users, never agents). */
export function requireTenantAdmin(actor: Actor): void {
  if (
    actor.principalType !== 'user' ||
    (actor.tenantRole !== 'owner' && actor.tenantRole !== 'admin')
  ) {
    throw new AppError('forbidden', 'Only tenant admins can do this.');
  }
}

/** A malformed id can never name a principal or group: answer like an unknown one. */
function principalUuid(id: string): string {
  if (!UUID_REGEX.test(id)) throw new AppError('principal_not_found');
  return id.toLowerCase();
}

async function loadMember(tx: DbTransaction, tenantId: string, userId: string): Promise<Member | null> {
  const [row] = await tx
    .select({
      userId: memberships.userId,
      email: users.email,
      name: users.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
  return row ?? null;
}

/**
 * Locks the tenant's owner memberships for the rest of the transaction and
 * returns how many there are. Two owners demoting or removing each other
 * concurrently serialise here, so the tenant can never end up without an owner.
 */
async function lockOwnerCount(tx: DbTransaction, tenantId: string): Promise<number> {
  const owners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner')))
    .for('update');
  return owners.length;
}

export async function listMembers(actor: Actor): Promise<Member[]> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, (tx) =>
    tx
      .select({
        userId: memberships.userId,
        email: users.email,
        name: users.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, actor.tenantId))
      .orderBy(asc(users.email))
  );
}

/**
 * Invitations nobody has accepted yet, newest first. Expired ones are listed
 * (flagged) so an admin can re-invite or revoke them; the token is never shown
 * again (only its hash is stored), so re-inviting is how a new link is made.
 */
export async function listInvitations(actor: Actor): Promise<PendingInvitation[]> {
  requireTenantAdmin(actor);
  const rows = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        invitedByName: users.name,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
      })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.tenantId, actor.tenantId), isNull(invitations.acceptedAt)))
      .orderBy(desc(invitations.createdAt))
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedByName: r.invitedByName ?? null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() <= now,
  }));
}

/** Deletes a pending invitation so its link stops working. An accepted one is history: 404 like an unknown id. */
export async function revokeInvitation(actor: Actor, rawId: string): Promise<void> {
  requireTenantAdmin(actor);
  if (!UUID_REGEX.test(rawId)) throw new AppError('invitation_not_found');
  const id = rawId.toLowerCase();
  await withTenantTx(actor.tenantId, async (tx) => {
    const [removed] = await tx
      .delete(invitations)
      .where(and(eq(invitations.tenantId, actor.tenantId), eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id, email: invitations.email });
    if (!removed) throw new AppError('invitation_not_found');
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'member.invitation_revoked',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'invitation',
      subjectId: removed.id,
      payload: { email: removed.email },
    });
  });
}

export async function changeMemberRole(
  actor: Actor,
  rawUserId: string,
  input: unknown
): Promise<Member> {
  requireTenantAdmin(actor);
  const userId = principalUuid(rawUserId);
  const { role: newRole } = UpdateMemberRoleRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const ownerCount = await lockOwnerCount(tx, actor.tenantId);
    const target = await loadMember(tx, actor.tenantId, userId);
    if (!target) throw new AppError('principal_not_found');

    const actorIsOwner = actor.tenantRole === 'owner';
    const oldRole: TenantRole = target.role;
    // Granting owner, and touching an owner at all, is for owners only.
    if (!actorIsOwner && (newRole === 'owner' || oldRole === 'owner')) {
      throw new AppError('forbidden', 'Only an owner can grant or change the owner role.');
    }
    if (oldRole === newRole) return target;
    if (oldRole === 'owner' && ownerCount <= 1) throw new AppError('last_owner');

    await tx
      .update(memberships)
      .set({ role: newRole })
      .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, userId)));

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'member.role_changed',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'user',
      subjectId: userId,
      payload: { oldRole, newRole },
    });

    return { ...target, role: newRole };
  });
}

export async function removeMember(actor: Actor, rawUserId: string): Promise<void> {
  requireTenantAdmin(actor);
  await dropMember(actor, principalUuid(rawUserId), 'member.removed');
}

/** The signed-in user leaves the workspace: the same cleanup as being removed, for anyone but its last owner. */
export async function leaveWorkspace(actor: Actor): Promise<void> {
  if (actor.principalType !== 'user') throw new AppError('forbidden', 'Only a person can leave a workspace.');
  await dropMember(actor, principalUuid(actor.principalId), 'member.left');
}

/**
 * Deletes the actor's workspace (owners only). A demo workspace (plan 'demo', the demo content went into it) is
 * purged at once: every row of it goes (purge_demo_workspace, migration 0036). Any other is marked deleted_at, which
 * hides it from everyone (sign-in to it, the workspace list, invitations) while its data stays, and its slug is
 * freed for a new workspace. Its live editing sessions are closed by the route.
 */
export async function deleteWorkspace(actor: Actor): Promise<void> {
  if (actor.principalType !== 'user' || actor.tenantRole !== 'owner') {
    throw new AppError('forbidden', 'Only an owner can delete the workspace.');
  }
  await withTenantTx(actor.tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, actor.tenantId)).for('update');
    if (!tenant) throw new AppError('tenant_not_found');
    if (tenant.plan === 'demo') {
      await tx.execute(sql`SELECT purge_demo_workspace(${actor.tenantId}::uuid)`);
      return;
    }
    await tx
      .update(tenants)
      .set({ deletedAt: new Date(), slug: `deleted-${tenant.id}` })
      .where(eq(tenants.id, actor.tenantId));
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'tenant.deleted',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'tenant',
      subjectId: actor.tenantId,
      payload: { slug: tenant.slug, name: tenant.name },
    });
  });
}

async function dropMember(actor: Actor, userId: string, event: 'member.removed' | 'member.left'): Promise<void> {
  await withTenantTx(actor.tenantId, async (tx) => {
    const ownerCount = await lockOwnerCount(tx, actor.tenantId);
    const target = await loadMember(tx, actor.tenantId, userId);
    if (!target) throw new AppError('principal_not_found');

    if (target.role === 'owner') {
      if (actor.tenantRole !== 'owner') {
        throw new AppError('forbidden', 'Only an owner can remove an owner.');
      }
      if (ownerCount <= 1) throw new AppError('last_owner');
    }

    await tx
      .delete(spaceGrants)
      .where(
        and(
          eq(spaceGrants.tenantId, actor.tenantId),
          eq(spaceGrants.principalType, 'user'),
          eq(spaceGrants.principalId, userId)
        )
      );
    await tx
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.tenantId, actor.tenantId),
          eq(groupMembers.principalType, 'user'),
          eq(groupMembers.principalId, userId)
        )
      );
    await tx
      .delete(memberships)
      .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, userId)));

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: event,
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'user',
      subjectId: userId,
      payload: { role: target.role },
    });
  });
}

// --- Groups -------------------------------------------------------------------

export async function listGroups(actor: Actor): Promise<Group[]> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: groups.id,
        name: groups.name,
        memberCount: sql<number>`count(${groupMembers.principalId})::int`,
      })
      .from(groups)
      .leftJoin(
        groupMembers,
        and(eq(groupMembers.groupId, groups.id), eq(groupMembers.tenantId, groups.tenantId))
      )
      .where(eq(groups.tenantId, actor.tenantId))
      .groupBy(groups.id, groups.name)
      .orderBy(asc(groups.name));
    return rows;
  });
}

export async function createGroup(actor: Actor, input: unknown): Promise<Group> {
  requireTenantAdmin(actor);
  const { name } = CreateGroupRequestSchema.parse(input);
  // A taken name violates groups_tenant_name_idx; mapDbError answers 409 group_name_taken.
  return withTenantTx(actor.tenantId, async (tx) => {
    const [group] = await tx.insert(groups).values({ tenantId: actor.tenantId, name }).returning();
    return { id: group.id, name: group.name, memberCount: 0 };
  });
}

/** Who is in a group: people and agents with their names, sorted by name (tenant admins only). */
export async function listGroupMembers(actor: Actor, rawGroupId: string): Promise<GroupMember[]> {
  requireTenantAdmin(actor);
  const groupId = principalUuid(rawGroupId);
  return withTenantTx(actor.tenantId, async (tx) => {
    await requireGroup(tx, actor.tenantId, groupId);
    const rows = await tx
      .select({ principalType: groupMembers.principalType, principalId: groupMembers.principalId })
      .from(groupMembers)
      .where(and(eq(groupMembers.tenantId, actor.tenantId), eq(groupMembers.groupId, groupId)));
    const ids = (type: 'user' | 'agent') => rows.filter((r) => r.principalType === type).map((r) => r.principalId);
    const names = new Map<string, string>();
    if (ids('user').length > 0) {
      for (const u of await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids('user')))) {
        names.set(u.id, u.name);
      }
    }
    if (ids('agent').length > 0) {
      const found = await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.tenantId, actor.tenantId), inArray(agents.id, ids('agent'))));
      for (const a of found) names.set(a.id, a.name);
    }
    return rows
      .map((r) => ({ principalType: r.principalType as 'user' | 'agent', principalId: r.principalId, name: names.get(r.principalId) ?? 'Unknown' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

async function requireGroup(tx: DbTransaction, tenantId: string, groupId: string): Promise<void> {
  const [group] = await tx
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.tenantId, tenantId), eq(groups.id, groupId)));
  if (!group) throw new AppError('principal_not_found');
}

export async function addGroupMember(
  actor: Actor,
  rawGroupId: string,
  input: unknown
): Promise<{ groupId: string; principalType: 'user' | 'agent'; principalId: string }> {
  requireTenantAdmin(actor);
  const groupId = principalUuid(rawGroupId);
  const parsed = AddGroupMemberRequestSchema.parse(input);
  const principalId = parsed.principal_id.toLowerCase();

  return withTenantTx(actor.tenantId, async (tx) => {
    await requireGroup(tx, actor.tenantId, groupId);
    if (!(await principalExists(tx, actor.tenantId, parsed.principal_type, principalId))) {
      throw new AppError('principal_not_found');
    }
    await tx
      .insert(groupMembers)
      .values({
        tenantId: actor.tenantId,
        groupId,
        principalType: parsed.principal_type,
        principalId,
      })
      .onConflictDoNothing();
    return { groupId, principalType: parsed.principal_type, principalId };
  });
}

export async function removeGroupMember(
  actor: Actor,
  rawGroupId: string,
  rawType: string,
  rawPrincipalId: string
): Promise<void> {
  requireTenantAdmin(actor);
  const groupId = principalUuid(rawGroupId);
  if (rawType !== 'user' && rawType !== 'agent') throw new AppError('principal_not_found');
  const principalId = principalUuid(rawPrincipalId);

  await withTenantTx(actor.tenantId, async (tx) => {
    await requireGroup(tx, actor.tenantId, groupId);
    await tx
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.tenantId, actor.tenantId),
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.principalType, rawType),
          eq(groupMembers.principalId, principalId)
        )
      );
  });
}

// --- Space grants -------------------------------------------------------------

export async function listSpaceGrants(actor: Actor, spaceId: string): Promise<Grant[]> {
  return withTenantTx(actor.tenantId, async (tx) => {
    await requireSpaceRole(tx, actor, spaceId, 'admin');
    const rows = await tx
      .select({
        principalType: spaceGrants.principalType,
        principalId: spaceGrants.principalId,
        role: spaceGrants.role,
      })
      .from(spaceGrants)
      .where(and(eq(spaceGrants.tenantId, actor.tenantId), eq(spaceGrants.spaceId, spaceId)));

    const idsOf = (type: string) =>
      rows.filter((r) => r.principalType === type).map((r) => r.principalId);
    const names = new Map<string, string>();
    const userIds = idsOf('user');
    if (userIds.length > 0) {
      const found = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.tenantId, actor.tenantId))
        )
        .where(inArray(users.id, userIds));
      for (const r of found) names.set(`user:${r.id}`, r.name);
    }
    const groupIds = idsOf('group');
    if (groupIds.length > 0) {
      const found = await tx
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(and(eq(groups.tenantId, actor.tenantId), inArray(groups.id, groupIds)));
      for (const r of found) names.set(`group:${r.id}`, r.name);
    }
    const agentIds = idsOf('agent');
    if (agentIds.length > 0) {
      const found = await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.tenantId, actor.tenantId), inArray(agents.id, agentIds)));
      for (const r of found) names.set(`agent:${r.id}`, r.name);
    }

    return rows
      .map((r) => ({
        principalType: r.principalType,
        principalId: r.principalId,
        principalName: names.get(`${r.principalType}:${r.principalId}`) ?? '',
        role: r.role,
      }))
      .sort(
        (a, b) =>
          a.principalType.localeCompare(b.principalType) ||
          a.principalName.localeCompare(b.principalName)
      );
  });
}

export async function deleteSpaceGrant(
  actor: Actor,
  spaceId: string,
  rawType: string,
  rawPrincipalId: string
): Promise<void> {
  await withTenantTx(actor.tenantId, async (tx) => {
    await requireSpaceRole(tx, actor, spaceId, 'admin');
    if (rawType !== 'user' && rawType !== 'agent' && rawType !== 'group') {
      throw new AppError('principal_not_found');
    }
    const principalId = principalUuid(rawPrincipalId);

    const removed = await tx
      .delete(spaceGrants)
      .where(
        and(
          eq(spaceGrants.tenantId, actor.tenantId),
          eq(spaceGrants.spaceId, spaceId),
          eq(spaceGrants.principalType, rawType),
          eq(spaceGrants.principalId, principalId)
        )
      )
      .returning({ principalId: spaceGrants.principalId });
    if (removed.length === 0) throw new AppError('principal_not_found');

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'space.grant_changed',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'space',
      subjectId: spaceId,
      payload: { removed: true, principalType: rawType, principalId },
    });
  });
}
