import { and, eq } from 'drizzle-orm';
import { spaces, spaceGrants, groupMembers } from '@living-wiki/db';
import type { DbTransaction } from '@living-wiki/db';
import { AppError, type ErrorCode } from '@living-wiki/contracts';

const ROLE_RANK = { viewer: 1, editor: 2, reviewer: 3, admin: 4 } as const;
export type SpaceRole = keyof typeof ROLE_RANK;

export interface Actor {
  tenantId: string;
  principalType: 'user' | 'agent';
  principalId: string;
  tenantRole?: 'owner' | 'admin' | 'member' | 'viewer';
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertValidUuid(id: string, notFoundError: ErrorCode = 'document_not_found') {
  if (!UUID_REGEX.test(id)) {
    throw new AppError(notFoundError, 'Resource not found.');
  }
}

export async function requireSpaceRole(
  tx: DbTransaction,
  actor: Actor,
  spaceId: string,
  minimumRole: SpaceRole
) {
  assertValidUuid(spaceId, 'space_not_found');

  // Always filter on tenant_id explicitly in addition to RLS
  const [space] = await tx
    .select()
    .from(spaces)
    .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, spaceId)));

  if (!space) {
    throw new AppError('space_not_found', 'Space not found.');
  }

  let effectiveRole: SpaceRole | null = null;

  // Tenant owners and admins act as space admins everywhere
  if (
    actor.principalType === 'user' &&
    (actor.tenantRole === 'owner' || actor.tenantRole === 'admin')
  ) {
    effectiveRole = 'admin';
  } else if (space.kind === 'inbox') {
    // Inbox is accessible to all tenant members/agents (item-level visibility applied in queries)
    effectiveRole = actor.tenantRole === 'viewer' ? 'viewer' : 'editor';
  } else {
    const groupsForActor = await tx
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.tenantId, actor.tenantId),
          eq(groupMembers.principalType, actor.principalType),
          eq(groupMembers.principalId, actor.principalId)
        )
      );

    const groupIds = groupsForActor.map((g) => g.groupId);
    const grants = await tx
      .select()
      .from(spaceGrants)
      .where(and(eq(spaceGrants.tenantId, actor.tenantId), eq(spaceGrants.spaceId, spaceId)));

    for (const grant of grants) {
      const matchesDirect =
        grant.principalType === actor.principalType && grant.principalId === actor.principalId;
      const matchesGroup = grant.principalType === 'group' && groupIds.includes(grant.principalId);

      if (matchesDirect || matchesGroup) {
        const candidate = grant.role as SpaceRole;
        if (!effectiveRole || ROLE_RANK[candidate] > ROLE_RANK[effectiveRole]) {
          effectiveRole = candidate;
        }
      }
    }
  }

  // Agents can hold viewer or editor, never reviewer or admin (S4)
  if (
    actor.principalType === 'agent' &&
    effectiveRole &&
    ROLE_RANK[effectiveRole] > ROLE_RANK.editor
  ) {
    effectiveRole = 'editor';
  }

  // Unreadable spaces return 404, never 403
  if (!effectiveRole) {
    throw new AppError('space_not_found', 'Space not found.');
  }

  // Readable space but insufficient role returns 403 forbidden
  if (ROLE_RANK[effectiveRole] < ROLE_RANK[minimumRole]) {
    throw new AppError('forbidden', 'You do not have permission to perform this action.');
  }

  return { space, effectiveRole };
}

export async function getReadableSpaceIds(
  tx: DbTransaction,
  actor: Actor
): Promise<{ readableSpaceIds: string[]; inboxSpaceId: string }> {
  const allSpaces = await tx
    .select()
    .from(spaces)
    .where(eq(spaces.tenantId, actor.tenantId));

  const inboxSpace = allSpaces.find((s) => s.kind === 'inbox');
  const inboxSpaceId = inboxSpace?.id ?? '00000000-0000-0000-0000-000000000000';

  if (
    actor.principalType === 'user' &&
    (actor.tenantRole === 'owner' || actor.tenantRole === 'admin')
  ) {
    return {
      readableSpaceIds: allSpaces.filter((s) => !s.archivedAt).map((s) => s.id),
      inboxSpaceId,
    };
  }

  const groupsForActor = await tx
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.tenantId, actor.tenantId),
        eq(groupMembers.principalType, actor.principalType),
        eq(groupMembers.principalId, actor.principalId)
      )
    );
  const groupIds = groupsForActor.map((g) => g.groupId);

  const allGrants = await tx
    .select()
    .from(spaceGrants)
    .where(eq(spaceGrants.tenantId, actor.tenantId));

  const readable = new Set<string>();
  if (inboxSpace) readable.add(inboxSpace.id);

  for (const grant of allGrants) {
    const matchesDirect =
      grant.principalType === actor.principalType && grant.principalId === actor.principalId;
    const matchesGroup = grant.principalType === 'group' && groupIds.includes(grant.principalId);
    if (matchesDirect || matchesGroup) {
      readable.add(grant.spaceId);
    }
  }

  return {
    readableSpaceIds: allSpaces
      .filter((s) => !s.archivedAt && readable.has(s.id))
      .map((s) => s.id),
    inboxSpaceId,
  };
}
