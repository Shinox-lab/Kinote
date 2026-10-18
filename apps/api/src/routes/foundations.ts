import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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
  AppError,
} from '@living-wiki/contracts';
import { requireSpaceRole, getReadableSpaceIds, type Actor } from '@living-wiki/core';

export async function createTenantWithInbox(input: unknown) {
  const parsed = CreateTenantRequestSchema.parse(input);

  return db.transaction(async (tx) => {
    const tenantId = randomUUID();
    // Bootstrap path: the tenant row does not exist yet, so the tenant-scoped
    // RLS policy (WITH CHECK id = current_tenant_id()) only passes if the RLS
    // context is configured with the same pre-generated id before inserting.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);

    let [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, parsed.owner_email));
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email: parsed.owner_email, name: parsed.owner_name })
        .returning();
    }

    const [tenant] = await tx
      .insert(tenants)
      .values({ id: tenantId, name: parsed.name, slug: parsed.slug, plan: 'standard' })
      .returning();

    // Activate RLS context for this new tenant inside the transaction
    await withTenantTx(
      tenant.id,
      async (tenantTx) => {
        await tenantTx.insert(memberships).values({
        tenantId: tenant.id,
        userId: user.id,
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
          createdBy: user.id,
        })
        .returning();

      await writeAuditEvent(tenantTx, {
        tenantId: tenant.id,
        type: 'tenant.created',
        actorType: 'user',
        actorId: user.id,
        subjectType: 'tenant',
        subjectId: tenant.id,
        payload: { slug: tenant.slug },
      });

      await writeAuditEvent(tenantTx, {
        tenantId: tenant.id,
        type: 'space.created',
        actorType: 'system',
        actorId: user.id,
        subjectType: 'space',
        subjectId: inbox.id,
        payload: { kind: 'inbox', slug: 'inbox' },
      });
      },
      tx,
    );

    const [inboxSpace] = await withTenantTx(
      tenant.id,
      (tenantTx) =>
        tenantTx
          .select()
          .from(spaces)
          .where(and(eq(spaces.tenantId, tenant.id), eq(spaces.kind, 'inbox'))),
      tx
    );

    return { tenant, owner: user, inboxSpace };
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

export async function inviteMember(
  actor: Actor,
  params: { email: string; name: string; role: 'admin' | 'member' | 'viewer' }
) {
  return withTenantTx(actor.tenantId, async (tx) => {
    if (
      actor.principalType !== 'user' ||
      (actor.tenantRole !== 'owner' && actor.tenantRole !== 'admin')
    ) {
      throw new AppError('forbidden', 'Only tenant admins can invite members.');
    }

    let [user] = await tx.select().from(users).where(eq(users.email, params.email));
    if (!user) {
      [user] = await tx
        .insert(users)
        .values({ email: params.email, name: params.name })
        .returning();
    }

    await tx.insert(invitations).values({
      tenantId: actor.tenantId,
      email: params.email,
      role: params.role,
      invitedBy: actor.principalId,
      acceptedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86400 * 1000),
    });

    await tx
      .insert(memberships)
      .values({
        tenantId: actor.tenantId,
        userId: user.id,
        role: params.role,
      })
      .onConflictDoUpdate({
        target: [memberships.tenantId, memberships.userId],
        set: { role: params.role },
      });

    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'member.invited',
      actorType: 'user',
      actorId: actor.principalId,
      subjectType: 'user',
      subjectId: user.id,
      payload: { email: params.email, role: params.role },
    });

    return user;
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
