import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  getDb,
  withTenantTx,
  tenants,
  users,
  memberships,
  invitations,
  agents,
  groups,
  spaces,
  spaceGrants,
  documents,
  pages,
  versions,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  CreateTenantRequestSchema,
  CreateSpaceRequestSchema,
  UpdateSpaceSettingsSchema,
  UpsertSpaceGrantSchema,
  InviteMemberRequestSchema,
  AcceptInvitationRequestSchema,
  AppError,
  type Space,
  type SpaceResponse,
  type TreeResponse,
  type SpaceRole,
  type CreateTenantResponse,
  type UpsertGrantResponse,
  type InviteMemberResponse,
  type AcceptInvitationResponse,
} from '@kinote/contracts';
import { sha256Hex } from '@kinote/shared';
import { fileAttention, pageAttention } from '../pages/badge.js';
import {
  requireSpaceRole,
  getReadableSpaceIds,
  isTenantAdmin,
  type Actor,
} from '@kinote/core';

/** A space row as the published Space (timestamps as ISO strings). */
export function toSpace(row: typeof spaces.$inferSelect): Space {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    reviewRequired: row.reviewRequired,
    quietSeconds: row.quietSeconds,
    humanProtectionSeconds: row.humanProtectionSeconds,
    allowSelfApproval: row.allowSelfApproval,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toSpaceResponse(row: typeof spaces.$inferSelect, myRole: SpaceRole): SpaceResponse {
  return { ...toSpace(row), myRole };
}

/**
 * Creates a tenant owned by `userId` (the signed-in session user) together
 * with its Inbox space. Never reads or writes `users`: the session already
 * proves the user exists. A taken slug violates tenants_slug_unique and
 * answers 409 slug_taken.
 */
export async function createTenantWithInbox(
  userId: string,
  input: unknown
): Promise<CreateTenantResponse> {
  const parsed = CreateTenantRequestSchema.parse(input);

  return getDb().transaction(async (tx) => {
    const tenantId = randomUUID();
    // Bootstrap path: the tenant row does not exist yet, so the tenant-scoped
    // RLS policy (WITH CHECK id = current_tenant_id()) only passes if the RLS
    // context is configured with the same pre-generated id before inserting.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);

    const [tenant] = await tx
      .insert(tenants)
      .values({ id: tenantId, name: parsed.name, slug: parsed.slug, plan: 'standard' })
      .returning();

    const inboxSpace = await withTenantTx(
      tenant.id,
      async (tenantTx) => {
        await tenantTx.insert(memberships).values({
          tenantId: tenant.id,
          userId,
          role: 'owner',
        });

        const [inbox] = await tenantTx
          .insert(spaces)
          .values({
            tenantId: tenant.id,
            name: 'Inbox',
            slug: 'inbox',
            kind: 'inbox',
            reviewRequired: false,
            quietSeconds: 120,
            humanProtectionSeconds: 300,
            allowSelfApproval: false,
            createdBy: userId,
          })
          .returning();

        await writeAuditEvent(tenantTx, {
          tenantId: tenant.id,
          type: 'tenant.created',
          actorType: 'user',
          actorId: userId,
          subjectType: 'tenant',
          subjectId: tenant.id,
          payload: { slug: tenant.slug },
        });

        await writeAuditEvent(tenantTx, {
          tenantId: tenant.id,
          type: 'space.created',
          actorType: 'system',
          actorId: userId,
          subjectType: 'space',
          subjectId: inbox.id,
          payload: { kind: 'inbox', slug: 'inbox' },
        });

        return inbox;
      },
      tx
    );

    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      membership: { role: 'owner' },
      inboxSpace: toSpace(inboxSpace),
    };
  });
}

export async function createSpace(actor: Actor, input: unknown): Promise<SpaceResponse> {
  const parsed = CreateSpaceRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    if (
      actor.principalType !== 'user' ||
      (actor.tenantRole !== 'owner' && actor.tenantRole !== 'admin')
    ) {
      throw new AppError('forbidden', 'Only tenant admins can create spaces.');
    }

    const [space] = await tx
      .insert(spaces)
      .values({
        tenantId: actor.tenantId,
        name: parsed.name,
        slug: parsed.slug,
        kind: 'normal',
        reviewRequired: parsed.review_required,
        quietSeconds: parsed.quiet_seconds,
        humanProtectionSeconds: parsed.human_protection_seconds,
        allowSelfApproval: parsed.allow_self_approval,
        createdBy: actor.principalId,
      })
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'space.created',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'space',
      subjectId: space.id,
      payload: { name: space.name, slug: space.slug, reviewRequired: space.reviewRequired },
    });

    return toSpaceResponse(space, 'admin');
  });
}

export async function getSpaceForActor(actor: Actor, spaceId: string): Promise<SpaceResponse> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { space, effectiveRole } = await requireSpaceRole(tx, actor, spaceId, 'viewer');
    return toSpaceResponse(space, effectiveRole);
  });
}

export async function listSpacesForActor(actor: Actor): Promise<SpaceResponse[]> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { readableSpaceIds } = await getReadableSpaceIds(tx, actor);
    const results: SpaceResponse[] = [];
    for (const spaceId of readableSpaceIds) {
      const { space, effectiveRole } = await requireSpaceRole(tx, actor, spaceId, 'viewer');
      results.push(toSpaceResponse(space, effectiveRole));
    }
    return results;
  });
}

export async function updateSpaceSettings(
  actor: Actor,
  spaceId: string,
  input: unknown
): Promise<Space> {
  const parsed = UpdateSpaceSettingsSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    await requireSpaceRole(tx, actor, spaceId, 'admin');

    const [updated] = await tx
      .update(spaces)
      .set({
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.review_required !== undefined ? { reviewRequired: parsed.review_required } : {}),
        ...(parsed.quiet_seconds !== undefined ? { quietSeconds: parsed.quiet_seconds } : {}),
        ...(parsed.human_protection_seconds !== undefined
          ? { humanProtectionSeconds: parsed.human_protection_seconds }
          : {}),
        ...(parsed.allow_self_approval !== undefined
          ? { allowSelfApproval: parsed.allow_self_approval }
          : {}),
      })
      .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, spaceId)))
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'space.settings_changed',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'space',
      subjectId: spaceId,
      payload: parsed,
    });

    return toSpace(updated);
  });
}

/**
 * The documents of a space as tree nodes (viewer or higher). `archived`
 * picks the archived documents (by title) instead of the live ones (by
 * `position`, then title; id last so the order is total). In the Inbox, the
 * one space with per-item visibility, everyone but a tenant owner or admin
 * sees only the documents they created.
 */
async function listTreeNodes(
  actor: Actor,
  spaceId: string,
  minimumRole: 'viewer' | 'admin',
  archived: boolean
): Promise<TreeResponse> {
  return withTenantTx(actor.tenantId, async (tx) => {
    // The archived list is a read: a tenant admin may open it on an archived space.
    const { space } = await requireSpaceRole(tx, actor, spaceId, minimumRole, {
      allowArchived: true,
    });

    // One query for the whole space: each page's latest version (highest
    // number, as the page badge reads it), its indexed version and its live
    // columns come along, so no page costs a query of its own.
    const latest = alias(versions, 'latest_version');
    const indexed = alias(versions, 'indexed_version');
    const rows = await tx
      .select({
        id: documents.id,
        parentId: documents.parentId,
        position: documents.position,
        kind: documents.kind,
        title: documents.title,
        icon: documents.icon,
        slug: pages.slug,
        liveChangedSinceSnapshot: pages.liveChangedSinceSnapshot,
        liveUpdatedAt: pages.liveUpdatedAt,
        agentChangedAt: pages.agentChangedAt,
        latestNumber: latest.number,
        latestStatus: latest.status,
        indexedNumber: indexed.number,
      })
      .from(documents)
      .leftJoin(
        pages,
        and(eq(pages.tenantId, documents.tenantId), eq(pages.documentId, documents.id))
      )
      .leftJoin(
        latest,
        and(
          eq(latest.tenantId, documents.tenantId),
          eq(latest.documentId, documents.id),
          sql`${latest.number} = (
            select max(v.number) from ${versions} v
            where v.tenant_id = ${documents.tenantId} and v.document_id = ${documents.id}
          )`
        )
      )
      .leftJoin(
        indexed,
        and(
          eq(indexed.tenantId, documents.tenantId),
          eq(indexed.id, documents.indexedVersionId)
        )
      )
      .where(
        and(
          eq(documents.tenantId, actor.tenantId),
          eq(documents.spaceId, space.id),
          archived ? isNotNull(documents.archivedAt) : isNull(documents.archivedAt),
          space.kind === 'inbox' && !isTenantAdmin(actor)
            ? and(
                eq(documents.createdByType, actor.principalType),
                eq(documents.createdBy, actor.principalId)
              )
            : undefined
        )
      )
      .orderBy(
        ...(archived
          ? [asc(documents.title), asc(documents.id)]
          : [asc(documents.position), asc(documents.title), asc(documents.id)])
      );

    const now = new Date();
    return {
      nodes: rows.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        position: r.position,
        kind: r.kind,
        title: r.title,
        icon: r.icon,
        slug: r.slug,
        // Archived documents carry no dot; a file's dot comes from its latest version alone.
        attention: archived
          ? null
          : r.kind === 'file'
            ? fileAttention({
                latestVersion:
                  r.latestNumber !== null && r.latestStatus !== null
                    ? { number: r.latestNumber, status: r.latestStatus, hasText: true }
                    : null,
              })
            : r.liveUpdatedAt === null
              ? null
              : pageAttention(
                  {
                    liveChangedSinceSnapshot: r.liveChangedSinceSnapshot ?? false,
                    liveUpdatedAt: r.liveUpdatedAt,
                    agentChangedAt: r.agentChangedAt,
                    spaceReviewRequired: space.reviewRequired,
                    latestVersion:
                      r.latestNumber !== null && r.latestStatus !== null
                        ? { number: r.latestNumber, status: r.latestStatus }
                        : null,
                    indexedVersion: r.indexedNumber !== null ? { number: r.indexedNumber } : null,
                  },
                  now
                ),
      })),
    };
  });
}

/** `GET /spaces/:id/tree`: the live documents of a space (viewer). */
export function getSpaceTree(actor: Actor, spaceId: string): Promise<TreeResponse> {
  return listTreeNodes(actor, spaceId, 'viewer', false);
}

/** `GET /spaces/:id/archived`: the archived documents of a space (space admin). */
export function getSpaceArchived(actor: Actor, spaceId: string): Promise<TreeResponse> {
  return listTreeNodes(actor, spaceId, 'admin', true);
}

/**
 * Archives a space (space admin). Order of answers: unreadable space 404
 * `space_not_found`; role below admin 403 `forbidden`; an already archived
 * space 409 `space_archived` (the gate: nothing but reads is allowed on an
 * archived space); the Inbox 403 `forbidden` (it can never be archived); any
 * non-archived document left 409 `has_children`. The space row is locked
 * first, so two archives run one after another.
 */
export async function archiveSpace(actor: Actor, spaceId: string): Promise<SpaceResponse> {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { effectiveRole } = await requireSpaceRole(tx, actor, spaceId, 'admin');

    // Re-read under the lock: a concurrent archive that committed first wins.
    const [locked] = await tx
      .select()
      .from(spaces)
      .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, spaceId)))
      .for('update');
    if (!locked) {
      throw new AppError('space_not_found');
    }
    if (locked.archivedAt) {
      throw new AppError('space_archived', 'Space is archived.');
    }
    if (locked.kind === 'inbox') {
      throw new AppError('forbidden', 'The Inbox cannot be archived.');
    }

    const [liveDocument] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, actor.tenantId),
          eq(documents.spaceId, spaceId),
          isNull(documents.archivedAt)
        )
      )
      .limit(1);
    if (liveDocument) {
      throw new AppError('has_children', 'Archive every document in this space before archiving it.');
    }

    const [updated] = await tx
      .update(spaces)
      .set({ archivedAt: new Date() })
      .where(and(eq(spaces.tenantId, actor.tenantId), eq(spaces.id, spaceId)))
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'space.archived',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'space',
      subjectId: spaceId,
      payload: { name: updated.name, slug: updated.slug },
    });

    // The role was resolved before the archive: afterwards the space is
    // invisible to anyone but tenant admins, a space admin included.
    return toSpaceResponse(updated, effectiveRole);
  });
}

/**
 * True when the grant's principal belongs to the actor's tenant: a user with a
 * membership row, a group of the tenant, or an agent of the tenant that is not
 * disabled. Every lookup filters on tenant_id explicitly (RLS is a second wall).
 */
export async function principalExists(
  tx: DbTransaction,
  tenantId: string,
  principalType: 'user' | 'group' | 'agent',
  principalId: string
): Promise<boolean> {
  if (principalType === 'user') {
    const [row] = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, principalId)));
    return row !== undefined;
  }
  if (principalType === 'group') {
    const [row] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.tenantId, tenantId), eq(groups.id, principalId)));
    return row !== undefined;
  }
  const [row] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.id, principalId), isNull(agents.disabledAt)));
  return row !== undefined;
}

/**
 * Grants a role in a space (space admin). The principal must belong to the
 * tenant (404 `principal_not_found` otherwise, also for another tenant's ids
 * and disabled agents). Agents may hold viewer or editor only (403). A grant
 * of editor (or higher) to a user whose tenant role is `viewer` is accepted
 * as given: `requireSpaceRole` caps that user at viewer when it is read, so
 * the grant takes effect if the tenant role is later raised.
 */
export async function upsertSpaceGrant(
  actor: Actor,
  spaceId: string,
  input: unknown
): Promise<UpsertGrantResponse> {
  const parsed = UpsertSpaceGrantSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    await requireSpaceRole(tx, actor, spaceId, 'admin');

    if (
      parsed.principal_type === 'agent' &&
      (parsed.role === 'reviewer' || parsed.role === 'admin')
    ) {
      throw new AppError('forbidden', 'Agents can hold viewer or editor roles, never reviewer or admin.');
    }

    if (!(await principalExists(tx, actor.tenantId, parsed.principal_type, parsed.principal_id))) {
      throw new AppError('principal_not_found');
    }

    const [grant] = await tx
      .insert(spaceGrants)
      .values({
        tenantId: actor.tenantId,
        spaceId,
        principalType: parsed.principal_type,
        principalId: parsed.principal_id,
        role: parsed.role,
      })
      .onConflictDoUpdate({
        target: [
          spaceGrants.tenantId,
          spaceGrants.spaceId,
          spaceGrants.principalType,
          spaceGrants.principalId,
        ],
        set: { role: parsed.role },
      })
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'space.grant_changed',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'space',
      subjectId: spaceId,
      payload: parsed,
    });

    return {
      spaceId: grant.spaceId,
      principalType: grant.principalType,
      principalId: grant.principalId,
      role: grant.role,
    };
  });
}

const INVITATION_TTL_MS = 7 * 86400 * 1000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Invites an email to the tenant. Never touches `users` and creates no
 * membership: the invitee must accept with the returned token while signed in
 * as the account with that email. Only the sha256 of the token secret is
 * stored. A pending invitation for the same email is replaced (its old token
 * stops working).
 */
export async function inviteMember(actor: Actor, input: unknown): Promise<InviteMemberResponse> {
  // Authorization first: a non-admin gets 403 whatever the body looks like.
  if (
    actor.principalType !== 'user' ||
    (actor.tenantRole !== 'owner' && actor.tenantRole !== 'admin')
  ) {
    throw new AppError('forbidden', 'Only tenant admins can invite members.');
  }
  const parsed = InviteMemberRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    // Replace-in-place for a pending invitation (the partial unique index
    // decides, so concurrent re-invites cannot fail with a raw 500); the old
    // token's hash is overwritten and therefore stops working.
    const [invitation] = await tx
      .insert(invitations)
      .values({
        tenantId: actor.tenantId,
        email: parsed.email,
        role: parsed.role,
        invitedBy: actor.principalId,
        tokenHash: sha256Hex(secret),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [invitations.tenantId, invitations.email],
        targetWhere: isNull(invitations.acceptedAt),
        set: {
          role: parsed.role,
          invitedBy: actor.principalId,
          tokenHash: sha256Hex(secret),
          expiresAt,
        },
      })
      .returning();

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'member.invited',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'invitation',
      subjectId: invitation.id,
      payload: { email: invitation.email, role: invitation.role },
    });

    return {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
      },
      acceptToken: `${actor.tenantId}.${secret}`,
    };
  });
}

/** Splits "{tenantId}.{secret}"; null for anything malformed. */
function parseAcceptToken(token: string): { tenantId: string; secret: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const tenantId = parts[0].toLowerCase();
  const secret = parts[1];
  if (!UUID_REGEX.test(tenantId) || secret.length === 0) return null;
  return { tenantId, secret };
}

/**
 * The signed-in user accepts an invitation. The token must belong to a pending,
 * unexpired invitation whose email equals the user's email (case-insensitive);
 * anything else answers 404 invitation_invalid and changes nothing. An existing
 * membership keeps its role.
 */
export async function acceptInvitation(
  userId: string,
  input: unknown
): Promise<AcceptInvitationResponse> {
  const { token } = AcceptInvitationRequestSchema.parse(input);
  const invalid = () => new AppError('invitation_invalid');
  const parsedToken = parseAcceptToken(token);
  if (!parsedToken) throw invalid();
  const { tenantId, secret } = parsedToken;

  return withTenantTx(tenantId, async (tx) => {
    // Claim the invitation atomically before anything else: only one
    // concurrent accept can flip accepted_at from NULL. A failure below (wrong
    // email) throws and rolls this claim back with the transaction, so a wrong
    // user never consumes the token.
    const [invitation] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.tokenHash, sha256Hex(secret)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date())
        )
      )
      .returning();
    if (!invitation) throw invalid();

    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) throw invalid();

    const [tenant] = await tx
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.id, tenantId), isNull(tenants.deletedAt)));
    if (!tenant) throw invalid();

    await tx
      .insert(memberships)
      .values({ tenantId, userId, role: invitation.role })
      .onConflictDoNothing({ target: [memberships.tenantId, memberships.userId] });
    const [membership] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));

    await writeAuditEvent(tx, {
      tenantId,
      type: 'member.joined',
      actorType: 'user',
      actorId: userId,
      subjectType: 'invitation',
      subjectId: invitation.id,
      payload: { role: membership.role },
    });

    return { tenant, role: membership.role };
  });
}
