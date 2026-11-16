import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  agents,
  acquireRoutingLease,
  agentTokens,
  releaseRoutingLease,
  captureFacts,
  captures,
  memberships,
  spaceGrants,
  spaces,
  tenants,
  users,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  AppError,
  CreateAgentRequestSchema,
  DEFAULT_AGENT_TOKEN_DAYS,
  IssueAgentTokenRequestSchema,
  UpdateAgentRequestSchema,
  UpdateAgentSettingsRequestSchema,
  StopAgentRequestSchema,
  type StopAgentResponse,
  type Agent,
  type AgentSettings,
  type AgentScope,
  type AgentToken,
  type IssueAgentTokenResponse,
} from '@kinote/contracts';
import { assertValidUuid, type Actor } from '@kinote/core';
import { mintAgentToken } from '../auth/agentTokens.js';
import { requireTenantAdmin } from './admin.js';
import { undoCapture } from './captureChanges.js';
import type { CollabClient } from '@kinote/shared';

type AgentRow = typeof agents.$inferSelect;
type TokenRow = typeof agentTokens.$inferSelect;

const DAY_MS = 86_400_000;

const toToken = (r: TokenRow): AgentToken => ({
  id: r.id,
  name: r.name,
  prefix: r.tokenPrefix,
  scopes: r.scopes as AgentScope[],
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  // A browser sign-in's access token lasts an hour and renews itself; the sign-in ends when its refresh does.
  expiresAt: (r.refreshExpiresAt ?? r.expiresAt)?.toISOString() ?? null,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});

async function loadAgent(tx: DbTransaction, tenantId: string, agentId: string, lock = false): Promise<AgentRow> {
  assertValidUuid(agentId, 'agent_not_found');
  const query = tx
    .select()
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.id, agentId), eq(agents.kind, 'external')));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('agent_not_found');
  return row;
}

/** The admin-facing view of external agents (newest first; built-in ones such as the routing engine are not listed): owner, space grants and tokens (newest first). */
async function viewAgents(tx: DbTransaction, tenantId: string, only?: string): Promise<Agent[]> {
  const rows = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.kind, 'external'), only ? eq(agents.id, only) : undefined))
    .orderBy(desc(agents.createdAt), desc(agents.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const ownerIds = [...new Set(rows.map((r) => r.createdBy))];
  const people = await tx
    .select({ id: users.id, name: users.name, role: memberships.role })
    .from(users)
    .leftJoin(memberships, and(eq(memberships.tenantId, tenantId), eq(memberships.userId, users.id)))
    .where(inArray(users.id, ownerIds));
  const owners = new Map(people.map((p) => [p.id, { id: p.id, name: p.name, role: p.role ?? null }]));

  const grants = await tx
    .select({ principalId: spaceGrants.principalId, spaceId: spaceGrants.spaceId, role: spaceGrants.role, spaceName: spaces.name })
    .from(spaceGrants)
    .innerJoin(spaces, and(eq(spaces.tenantId, spaceGrants.tenantId), eq(spaces.id, spaceGrants.spaceId)))
    .where(
      and(eq(spaceGrants.tenantId, tenantId), eq(spaceGrants.principalType, 'agent'), inArray(spaceGrants.principalId, ids))
    )
    .orderBy(spaces.name);

  const tokens = await tx
    .select()
    .from(agentTokens)
    .where(and(eq(agentTokens.tenantId, tenantId), inArray(agentTokens.agentId, ids)))
    .orderBy(desc(agentTokens.createdAt), desc(agentTokens.id));

  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    owner: owners.get(a.createdBy) ?? { id: a.createdBy, name: 'Someone who left', role: null },
    createdAt: a.createdAt.toISOString(),
    disabledAt: a.disabledAt?.toISOString() ?? null,
    dailyAiLimit: a.dailyAiLimit,
    alwaysReview: a.alwaysReview,
    grants: grants
      .filter((g) => g.principalId === a.id && (g.role === 'viewer' || g.role === 'editor'))
      .map((g) => ({ spaceId: g.spaceId, spaceName: g.spaceName, role: g.role as 'viewer' | 'editor' })),
    tokens: tokens.filter((t) => t.agentId === a.id).map(toToken),
  }));
}

/** GET /api/v1/agents (tenant admin). */
export async function listAgents(actor: Actor): Promise<Agent[]> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, (tx) => viewAgents(tx, actor.tenantId));
}

/** POST /api/v1/agents (tenant admin): a new agent owned by the caller, with no grants and no tokens. */
export async function createAgent(actor: Actor, input: unknown): Promise<Agent> {
  requireTenantAdmin(actor);
  const body = CreateAgentRequestSchema.parse(input);
  return withTenantTx(actor.tenantId, async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        tenantId: actor.tenantId,
        name: body.name,
        kind: 'external',
        createdBy: actor.principalId,
        dailyAiLimit: body.daily_ai_limit ?? null,
      })
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'agent.created',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'agent',
      subjectId: row!.id,
      payload: { name: row!.name, dailyAiLimit: row!.dailyAiLimit },
    });
    return (await viewAgents(tx, actor.tenantId, row!.id))[0]!;
  });
}

const snapshot = (a: AgentRow) => ({
  name: a.name,
  disabled: a.disabledAt !== null,
  dailyAiLimit: a.dailyAiLimit,
  alwaysReview: a.alwaysReview,
});

/** PATCH /api/v1/agents/:id (tenant admin): name, disabled, daily AI limit (null: the default). */
export async function updateAgent(actor: Actor, agentId: string, input: unknown): Promise<Agent> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const before = await loadAgent(tx, actor.tenantId, agentId, true);
    const body = UpdateAgentRequestSchema.parse(input);
    const disabledAt =
      body.disabled === undefined ? undefined : body.disabled ? (before.disabledAt ?? new Date()) : null;
    const [after] = await tx
      .update(agents)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(disabledAt !== undefined ? { disabledAt } : {}),
        ...(body.daily_ai_limit !== undefined ? { dailyAiLimit: body.daily_ai_limit } : {}),
        ...(body.always_review !== undefined ? { alwaysReview: body.always_review } : {}),
      })
      .where(and(eq(agents.tenantId, actor.tenantId), eq(agents.id, before.id)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'agent.updated',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'agent',
      subjectId: before.id,
      payload: { before: snapshot(before), after: snapshot(after!) },
    });
    return (await viewAgents(tx, actor.tenantId, before.id))[0]!;
  });
}

/** POST /api/v1/agents/:id/tokens (tenant admin): the secret is in this reply and nowhere else, ever. */
export async function issueAgentToken(actor: Actor, agentId: string, input: unknown): Promise<IssueAgentTokenResponse> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const agent = await loadAgent(tx, actor.tenantId, agentId);
    const body = IssueAgentTokenRequestSchema.parse(input);
    const minted = mintAgentToken(actor.tenantId);
    const [row] = await tx
      .insert(agentTokens)
      .values({
        tenantId: actor.tenantId,
        agentId: agent.id,
        name: body.name,
        scopes: body.scopes,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
        expiresAt: new Date(Date.now() + (body.expires_in_days ?? DEFAULT_AGENT_TOKEN_DAYS) * DAY_MS),
        createdBy: actor.principalId,
      })
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'agent.token_issued',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'agent',
      subjectId: agent.id,
      payload: { tokenId: row!.id, name: row!.name, scopes: row!.scopes },
    });
    return { token: minted.token, info: toToken(row!) };
  });
}

/** DELETE /api/v1/agents/:id/tokens/:tokenId (tenant admin): revokes; repeating it changes nothing. */
export async function revokeAgentToken(actor: Actor, agentId: string, tokenId: string): Promise<AgentToken> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const agent = await loadAgent(tx, actor.tenantId, agentId);
    assertValidUuid(tokenId, 'agent_not_found');
    const [token] = await tx
      .select()
      .from(agentTokens)
      .where(and(eq(agentTokens.tenantId, actor.tenantId), eq(agentTokens.agentId, agent.id), eq(agentTokens.id, tokenId)))
      .for('update');
    if (!token) throw new AppError('agent_not_found');
    if (token.revokedAt) return toToken(token);
    const [revoked] = await tx
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.tenantId, actor.tenantId), eq(agentTokens.id, token.id)))
      .returning();
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'agent.token_revoked',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'agent',
      subjectId: agent.id,
      payload: { tokenId: token.id, name: token.name },
    });
    return toToken(revoked!);
  });
}

/** GET /api/v1/agents/settings: the workspace's settings for agents (tenant admins). */
export async function getAgentSettings(actor: Actor): Promise<AgentSettings> {
  requireTenantAdmin(actor);
  return withTenantTx(actor.tenantId, async (tx) => {
    const [row] = await tx.select({ agentsMayAnswer: tenants.agentsMayAnswer }).from(tenants).where(eq(tenants.id, actor.tenantId));
    return { agentsMayAnswer: row?.agentsMayAnswer ?? false };
  });
}

/** PATCH /api/v1/agents/settings: whether agents may answer routing questions themselves. */
export async function updateAgentSettings(actor: Actor, input: unknown): Promise<AgentSettings> {
  requireTenantAdmin(actor);
  const parsed = UpdateAgentSettingsRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed');
  return withTenantTx(actor.tenantId, async (tx) => {
    const [row] = await tx
      .update(tenants)
      .set({ agentsMayAnswer: parsed.data.agents_may_answer })
      .where(eq(tenants.id, actor.tenantId))
      .returning({ agentsMayAnswer: tenants.agentsMayAnswer });
    await writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'agent.updated',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'tenant',
      subjectId: actor.tenantId,
      payload: { agentsMayAnswer: row!.agentsMayAnswer },
    });
    return { agentsMayAnswer: row!.agentsMayAnswer };
  });
}

/**
 * POST /api/v1/agents/:id/stop: disables the agent, then, oldest first, undoes every capture it sent at or after
 * `since` (changes a person edited since are left), and cancels its previews and captures not yet routed.
 */
export async function stopAgent(actor: Actor, agentId: string, input: unknown, collab?: CollabClient): Promise<StopAgentResponse> {
  requireTenantAdmin(actor);
  const parsed = StopAgentRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation_failed');
  const since = new Date(parsed.data.since);
  const agent = await updateAgent(actor, agentId, { disabled: true });
  // Hold the tenant's routing lease while undoing, so no routing run is part-way through one of its captures:
  // a run that started earlier finishes first; a later one sees the agent disabled and files nothing.
  const holder = `stop:${randomUUID()}`;
  const until = Date.now() + STOP_WAIT_MS;
  while (!(await withTenantTx(actor.tenantId, (tx) => acquireRoutingLease(tx, actor.tenantId, holder, STOP_LEASE_SECONDS)))) {
    if (Date.now() > until) throw new AppError('router_unavailable', 'Routing is busy. The agent is disabled; try Stop and undo again in a minute.');
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return await undoAgentCaptures(actor, agent, since, collab);
  } finally {
    await withTenantTx(actor.tenantId, (tx) => releaseRoutingLease(tx, actor.tenantId, holder));
  }
}

/** Waiting for a routing run to finish before stopping an agent, at most. */
const STOP_WAIT_MS = 60_000;
const STOP_LEASE_SECONDS = 120;

async function undoAgentCaptures(actor: Actor, agent: Agent, since: Date, collab?: CollabClient): Promise<StopAgentResponse> {
  const rows = await withTenantTx(actor.tenantId, (tx) =>
    tx
      .select({ id: captures.id, status: captures.status })
      .from(captures)
      .where(
        and(
          eq(captures.tenantId, actor.tenantId),
          eq(captures.senderType, 'agent'),
          eq(captures.senderId, agent.id),
          gte(captures.createdAt, since)
        )
      )
      .orderBy(asc(captures.createdAt))
  );
  let undone = 0;
  let changedSince = 0;
  for (const row of rows) {
    // A capture left 'routing' by a run that died may have filed part of itself: undone too, then cancelled.
    if (row.status === 'done' || row.status === 'waiting_for_answer' || row.status === 'routing') {
      const r = await undoCapture(actor, row.id, collab);
      undone += r.undone.length;
      changedSince += r.changedSince.length;
    }
    if (row.status === 'queued' || row.status === 'routing' || row.status === 'previewed') {
      // Not filed yet: nothing to undo, and nothing of it will be (routing skips a cancelled capture).
      await withTenantTx(actor.tenantId, async (tx) => {
        await tx
          .update(captureFacts)
          .set({ outcome: 'dismissed', reason: 'The agent was stopped.' })
          .where(and(eq(captureFacts.tenantId, actor.tenantId), eq(captureFacts.captureId, row.id), eq(captureFacts.outcome, 'pending')));
        await tx
          .update(captures)
          .set({ status: 'cancelled', finishedAt: new Date() })
          .where(and(eq(captures.tenantId, actor.tenantId), eq(captures.id, row.id), inArray(captures.status, ['queued', 'routing', 'previewed'])));
      });
    }
  }
  await withTenantTx(actor.tenantId, (tx) =>
    writeAuditEvent(tx, {
      tenantId: actor.tenantId,
      type: 'agent.stopped',
      actorType: actor.principalType,
      actorId: actor.principalId,
      subjectType: 'agent',
      subjectId: agent.id,
      payload: { since: since.toISOString(), captures: rows.length, undone, changedSince },
    })
  );
  return { agent, undone, changedSince, captures: rows.length };
}
