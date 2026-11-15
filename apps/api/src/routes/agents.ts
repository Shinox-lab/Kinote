import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  agents,
  agentTokens,
  memberships,
  spaceGrants,
  spaces,
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
  type Agent,
  type AgentScope,
  type AgentToken,
  type IssueAgentTokenResponse,
} from '@kinote/contracts';
import { assertValidUuid, type Actor } from '@kinote/core';
import { mintAgentToken } from '../auth/agentTokens.js';
import { requireTenantAdmin } from './admin.js';

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
  expiresAt: r.expiresAt?.toISOString() ?? null,
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

const snapshot = (a: AgentRow) => ({ name: a.name, disabled: a.disabledAt !== null, dailyAiLimit: a.dailyAiLimit });

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
