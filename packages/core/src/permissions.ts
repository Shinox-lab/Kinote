import { and, eq } from 'drizzle-orm';
import { spaces, spaceGrants, groupMembers } from '@living-wiki/db';
import type { DbTransaction, DocumentRow } from '@living-wiki/db';
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
    throw new AppError(notFoundError);
  }
}

export type SpaceRow = typeof spaces.$inferSelect;

export interface SpaceAccess {
  space: SpaceRow;
  effectiveRole: SpaceRole;
}

export interface SpaceRoleOptions {
  /**
   * Lets a tenant owner/admin act above `viewer` on an archived space (the
   * space archive/restore routes). Without it such a request is 409
   * `space_archived`. Never makes an archived space visible to a non-admin.
   */
  allowArchived?: boolean;
}

export interface DocumentRoleOptions extends SpaceRoleOptions {
  /** The 404 code answered when the actor may not see the document (default `document_not_found`). */
  notFound?: ErrorCode;
}

function isTenantAdmin(actor: Actor): boolean {
  return (
    actor.principalType === 'user' &&
    (actor.tenantRole === 'owner' || actor.tenantRole === 'admin')
  );
}

/**
 * Loads the space and the actor's effective role in it, or throws 404
 * `space_not_found` when the actor cannot read it (another tenant, unknown,
 * no grant, or archived for a non-admin). Does not compare against a
 * minimum role: see `checkMinimumRole`.
 */
async function resolveSpaceAccess(
  tx: DbTransaction,
  actor: Actor,
  spaceId: string
): Promise<SpaceAccess> {
  assertValidUuid(spaceId, 'space_not_found');

  // Always filter on tenant_id explicitly in addition to RLS
  const [space] = await tx
    .select()
    .from(spaces)
    .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, spaceId)));

  if (!space) {
    throw new AppError('space_not_found');
  }

  const tenantAdmin = isTenantAdmin(actor);

  // An archived space is invisible to everyone but tenant owners and admins.
  if (space.archivedAt && !tenantAdmin) {
    throw new AppError('space_not_found');
  }

  let effectiveRole: SpaceRole | null = null;

  // Tenant owners and admins act as space admins everywhere
  if (tenantAdmin) {
    effectiveRole = 'admin';
  } else if (space.kind === 'inbox') {
    // Every tenant member and agent may use the Inbox. Item-level visibility
    // (creator or tenant admin only) is applied by `requireDocumentRole` and
    // in search via `chunks.inbox_owner`.
    effectiveRole = 'editor';
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

  // Unreadable spaces return 404, never 403
  if (!effectiveRole) {
    throw new AppError('space_not_found');
  }

  // A user whose tenant role is `viewer` is read-only in every space, the
  // Inbox included, whatever their grants say (a grant of editor to such a
  // user is accepted and capped here). Agents have no tenant role.
  if (actor.principalType === 'user' && actor.tenantRole === 'viewer') {
    effectiveRole = 'viewer';
  }

  // Agents can hold viewer or editor, never reviewer or admin (S4)
  if (actor.principalType === 'agent' && ROLE_RANK[effectiveRole] > ROLE_RANK.editor) {
    effectiveRole = 'editor';
  }

  return { space, effectiveRole };
}

/**
 * The minimum-role half of the gate, for a space the actor can read: an
 * archived space accepts only reads (409 `space_archived` unless
 * `allowArchived`), and a role below the minimum is 403 `forbidden`.
 */
function checkMinimumRole(access: SpaceAccess, minimumRole: SpaceRole, opts: SpaceRoleOptions) {
  if (
    access.space.archivedAt &&
    ROLE_RANK[minimumRole] > ROLE_RANK.viewer &&
    !opts.allowArchived
  ) {
    throw new AppError('space_archived', 'Space is archived.');
  }

  // Readable space but insufficient role returns 403 forbidden
  if (ROLE_RANK[access.effectiveRole] < ROLE_RANK[minimumRole]) {
    throw new AppError('forbidden', 'You do not have permission to perform this action.');
  }
}

/**
 * The permission gate for space-level operations. 404 `space_not_found` when
 * the actor cannot read the space (never 403); 409 `space_archived` for a
 * change to an archived space; 403 `forbidden` when the role is too low.
 * Document-level operations use `requireDocumentRole` instead.
 */
export async function requireSpaceRole(
  tx: DbTransaction,
  actor: Actor,
  spaceId: string,
  minimumRole: SpaceRole,
  opts: SpaceRoleOptions = {}
): Promise<SpaceAccess> {
  const access = await resolveSpaceAccess(tx, actor, spaceId);
  checkMinimumRole(access, minimumRole, opts);
  return access;
}

/**
 * The permission gate for one document: the space gate plus the Inbox's
 * per-item rule (the one written exception to "access belongs to the space"):
 * an Inbox document is visible only to its creator and to tenant owners and
 * admins. Anything the actor cannot see answers `opts.notFound` (404), also
 * when the space itself is unreadable, so a document's existence never leaks
 * through a different code; only then are the archive (409) and role (403)
 * checks applied.
 */
export async function requireDocumentRole(
  tx: DbTransaction,
  actor: Actor,
  doc: Pick<DocumentRow, 'id' | 'spaceId' | 'createdByType' | 'createdBy'>,
  minimumRole: SpaceRole,
  opts: DocumentRoleOptions = {}
): Promise<SpaceAccess> {
  const notFound = opts.notFound ?? 'document_not_found';

  let access: SpaceAccess;
  try {
    access = await resolveSpaceAccess(tx, actor, doc.spaceId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'space_not_found') {
      throw new AppError(notFound);
    }
    throw err;
  }

  if (access.space.kind === 'inbox' && !isTenantAdmin(actor)) {
    const isCreator =
      doc.createdByType === actor.principalType && doc.createdBy === actor.principalId;
    if (!isCreator) {
      throw new AppError(notFound);
    }
  }

  checkMinimumRole(access, minimumRole, opts);
  return access;
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

  if (isTenantAdmin(actor)) {
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
