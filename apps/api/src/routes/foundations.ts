import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  db,
  withTenantTx,
  tenants,
  users,
  memberships,
  invitations,
  groups,
  groupMembers,
  spaces,
  spaceGrants,
  writeAuditEvent,
} from '@living-wiki/db';
import {
  CreateTenantRequestSchema,
  CreateSpaceRequestSchema,
  UpdateSpaceSettingsSchema,
  UpsertSpaceGrantSchema,
  InviteMemberRequestSchema,
  AcceptInvitationRequestSchema,
  AppError,
  type InviteMemberResponse,
  type AcceptInvitationResponse,
} from '@living-wiki/contracts';
import { sha256Hex } from '@living-wiki/shared';
import { requireSpaceRole, getReadableSpaceIds, type Actor } from '@living-wiki/core';

/**
 * Creates a tenant owned by `userId` (the signed-in session user) together
 * with its Inbox space. Never reads or writes `users`: the session already
 * proves the user exists. A taken slug violates tenants_slug_unique and
 * answers 409 slug_taken.
 */
export async function createTenantWithInbox(userId: string, input: unknown) {
  const parsed = CreateTenantRequestSchema.parse(input);

  return db.transaction(async (tx) => {
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

    return { tenant, membership: { role: 'owner' as const }, inboxSpace };
  });
}

export async function createSpace(actor: Actor, input: unknown) {
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

    return { ...space, myRole: 'admin' as const };
  });
}

export async function getSpaceForActor(actor: Actor, spaceId: string) {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { space, effectiveRole } = await requireSpaceRole(tx, actor, spaceId, 'viewer');
    return { ...space, myRole: effectiveRole };
  });
}

export async function listSpacesForActor(actor: Actor) {
  return withTenantTx(actor.tenantId, async (tx) => {
    const { readableSpaceIds } = await getReadableSpaceIds(tx, actor);
    const results = [];
    for (const spaceId of readableSpaceIds) {
      const { space, effectiveRole } = await requireSpaceRole(tx, actor, spaceId, 'viewer');
      results.push({ ...space, myRole: effectiveRole });
    }
    return results;
  });
}

export async function updateSpaceSettings(actor: Actor, spaceId: string, input: unknown) {
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

    return updated;
  });
}

export async function upsertSpaceGrant(actor: Actor, spaceId: string, input: unknown) {
  const parsed = UpsertSpaceGrantSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    await requireSpaceRole(tx, actor, spaceId, 'admin');

    if (
      parsed.principal_type === 'agent' &&
      (parsed.role === 'reviewer' || parsed.role === 'admin')
    ) {
      throw new AppError('forbidden', 'Agents can hold viewer or editor roles, never reviewer or admin.');
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

    return grant;
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
  const parsed = InviteMemberRequestSchema.parse(input);

  return withTenantTx(actor.tenantId, async (tx) => {
    if (
      actor.principalType !== 'user' ||
      (actor.tenantRole !== 'owner' && actor.tenantRole !== 'admin')
    ) {
      throw new AppError('forbidden', 'Only tenant admins can invite members.');
    }

    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    await tx
      .delete(invitations)
      .where(
        and(
          eq(invitations.tenantId, actor.tenantId),
          eq(invitations.email, parsed.email),
          isNull(invitations.acceptedAt)
        )
      );

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
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.tokenHash, sha256Hex(secret)),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, new Date())
        )
      );
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

    await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invitations.tenantId, tenantId), eq(invitations.id, invitation.id)));

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

export async function createGroupAndAddMembers(
  actor: Actor,
  name: string,
  members: Array<{ principalType: 'user' | 'agent'; principalId: string }>
) {
  return withTenantTx(actor.tenantId, async (tx) => {
    const [group] = await tx
      .insert(groups)
      .values({ tenantId: actor.tenantId, name })
      .returning();

    for (const m of members) {
      await tx.insert(groupMembers).values({
        tenantId: actor.tenantId,
        groupId: group.id,
        principalType: m.principalType,
        principalId: m.principalId,
      });
    }
    return group;
  });
}
