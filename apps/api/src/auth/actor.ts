import type { FastifyRequest } from 'fastify';
import { and, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import { withTenantTx, agents, agentTokens, memberships, sources, sourceTokens, tenants } from '@kinote/db';
import { AppError, AGENT_SCOPES, type AgentScope } from '@kinote/contracts';
import type { Actor } from '@kinote/core';
import { TtlCache } from '../cache.js';
import { resolveSession } from './sessions.js';
import { parseSourceToken } from './sourceTokens.js';
import { parseAgentToken } from './agentTokens.js';

export type AuthMode = 'public' | 'session' | 'tenant' | 'source' | 'agent';

/**
 * Positive membership lookups only. A role change invalidates this process's
 * entry; another process may use the old role for at most this window.
 */
const ACTOR_CACHE_TTL_MS = 5_000;
const actorCache = new TtlCache<NonNullable<Actor['tenantRole']>>({
  ttlMs: ACTOR_CACHE_TTL_MS,
  maxEntries: 10_000,
});

/** Drops one user's cached tenant role after a membership change. */
export function invalidateActor(tenantId: string, userId: string): void {
  actorCache.delete(`${tenantId}:${userId.toLowerCase()}`);
}

/** Drops every cached role for a tenant (workspace deletion or demo reset). */
export function invalidateTenantActors(tenantId: string): void {
  actorCache.deletePrefix(`${tenantId}:`);
}

/** Test isolation: a new database must not be served entries from the old one. */
export function clearActorCache(): void {
  actorCache.clear();
}

export interface AuthSession {
  userId: string;
  token: string;
}

/**
 * Who a source token acts as: one source in one tenant, delivering into one space.
 * Never an `Actor`: it has no session, no membership and no role.
 */
export interface SourceActor {
  tenantId: string;
  sourceId: string;
  sourceName: string;
  trusted: boolean;
  targetSpaceId: string;
}

/**
 * The agent behind a request's bearer agent token (`auth: 'agent'` routes). The request's `actor` is
 * the agent itself (principal `agent`, with its owner); this carries what the token adds.
 */
export interface AgentAuth {
  agentId: string;
  agentName: string;
  tokenId: string;
  scopes: AgentScope[];
  tenantSlug: string;
  /** AI actions a day; null means the default. */
  dailyAiLimit: number | null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Who may call the route. Default: 'tenant'. 'source' is a bearer source token and 'agent' a bearer
     * agent token, never a session.
     */
    auth?: AuthMode;
    /** 'allow': a POST that only reads (search, a collab token) still works while the workspace is suspended. */
    whenSuspended?: 'allow';
  }
  interface FastifyRequest {
    /** Set for 'session' and 'tenant' routes. */
    authSession: AuthSession | null;
    /**
     * Set for 'tenant' routes (derived from the session and the membership row only) and for 'agent'
     * routes (the agent, carrying its owner).
     */
    actor: Actor | null;
    /** Set for 'agent' routes; derived from the agent token only. */
    agentAuth: AgentAuth | null;
    /** Set for 'source' routes; derived from the source token only. */
    sourceActor: SourceActor | null;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/** The request's valid session, or 401 unauthenticated. */
export async function requireSession(req: FastifyRequest): Promise<AuthSession> {
  const token = bearerToken(req);
  const session = token ? await resolveSession(token) : null;
  if (!token || !session) throw new AppError('unauthenticated');
  return { userId: session.userId, token };
}

/**
 * The actor for a tenant-scoped request: the session user, with the tenant
 * role read from their membership row in `x-tenant-id`. No membership (or a
 * missing/malformed tenant id) answers 404 tenant_not_found. Identity headers
 * such as x-principal-* and x-tenant-role are never read.
 */
export async function resolveActor(req: FastifyRequest): Promise<Actor> {
  const session = req.authSession ?? (await requireSession(req));
  const rawTenantId = req.headers['x-tenant-id'];
  if (typeof rawTenantId !== 'string' || !UUID_REGEX.test(rawTenantId)) {
    throw new AppError('tenant_not_found');
  }
  // Canonical form everywhere downstream (queries, audit rows, comparisons).
  return actorForUser(rawTenantId.toLowerCase(), session.userId);
}

/**
 * The member `userId` of `tenantId` as an actor, from their membership row
 * (cached briefly); `tenant_not_found` when they are not a member or the
 * tenant is deleted. Also used where no request carries a session, e.g. a
 * media link, which names the user it was issued to.
 */
export async function actorForUser(tenantId: string, userId: string): Promise<Actor> {
  const cacheKey = `${tenantId}:${userId.toLowerCase()}`;
  const cachedRole = actorCache.get(cacheKey);
  if (cachedRole) {
    return { tenantId, principalType: 'user', principalId: userId, tenantRole: cachedRole };
  }

  const membership = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          eq(tenants.id, tenantId),
          isNull(tenants.deletedAt)
        )
      );
    return row ?? null;
  });
  if (!membership) throw new AppError('tenant_not_found');
  actorCache.set(cacheKey, membership.role);
  return { tenantId, principalType: 'user', principalId: userId, tenantRole: membership.role };
}

const LAST_USED_EVERY_MS = 60_000;

/**
 * The source behind a request's bearer source token. The token carries its tenant id, so the
 * lookup runs inside that tenant's transaction (row level security stays on); the row is found
 * by the token's hash. Every failure, whatever its cause, is the same 401: a malformed token, an
 * unknown tenant or hash, a revoked, expired or paused one, a deleted tenant. `last_used_at`
 * is moved at most once a minute.
 */
export async function resolveSourceActor(req: FastifyRequest): Promise<SourceActor> {
  const raw = bearerToken(req);
  const parsed = raw ? parseSourceToken(raw) : null;
  if (!parsed) throw new AppError('unauthenticated');
  const now = new Date();
  const found = await withTenantTx(parsed.tenantId, async (tx) => {
    const [row] = await tx
      .select({ token: sourceTokens, source: sources })
      .from(sourceTokens)
      .innerJoin(
        sources,
        and(eq(sources.tenantId, sourceTokens.tenantId), eq(sources.id, sourceTokens.sourceId))
      )
      .innerJoin(tenants, eq(tenants.id, sourceTokens.tenantId))
      .where(
        and(
          eq(sourceTokens.tenantId, parsed.tenantId),
          eq(sourceTokens.tokenHash, parsed.hash),
          isNull(tenants.deletedAt)
        )
      );
    if (!row) return null;
    const { token, source } = row;
    if (token.revokedAt || (token.expiresAt && token.expiresAt <= now) || source.status !== 'active') {
      return null;
    }
    await tx
      .update(sourceTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(sourceTokens.tenantId, parsed.tenantId),
          eq(sourceTokens.id, token.id),
          or(isNull(sourceTokens.lastUsedAt), lt(sourceTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS)))
        )
      );
    return source;
  });
  if (!found) throw new AppError('unauthenticated');
  return {
    tenantId: parsed.tenantId,
    sourceId: found.id,
    sourceName: found.name,
    trusted: found.trusted,
    targetSpaceId: found.targetSpaceId,
  };
}

/**
 * The agent behind a request's bearer agent token, as an actor that carries its owner. The token
 * carries its tenant id, so the lookup runs inside that tenant's transaction (row level security
 * stays on). Every failure is the same 401: a malformed token, an unknown tenant or hash, a revoked
 * or expired token, a disabled agent, an owner who is no longer a member, a deleted tenant. The
 * owner's role is read on every call, never cached, so a demotion takes effect on the next call.
 * `last_used_at` is moved at most once a minute.
 */
export async function resolveAgentActor(req: FastifyRequest): Promise<{ actor: Actor; agent: AgentAuth }> {
  const raw = bearerToken(req);
  const parsed = raw ? parseAgentToken(raw) : null;
  if (!parsed) throw new AppError('unauthenticated');
  const found = await agentActorWhere(parsed.tenantId, eq(agentTokens.tokenHash, parsed.hash), new Date());
  if (!found) throw new AppError('unauthenticated');
  return found;
}

/**
 * The agent behind an agent token row, by its id: what a signed agent link carries. The same checks as a
 * bearer token (not revoked or expired, agent not disabled, owner still a member, tenant not deleted); null
 * when any fails.
 */
export async function agentActorByTokenId(
  tenantId: string,
  tokenId: string,
  now: Date = new Date()
): Promise<{ actor: Actor; agent: AgentAuth } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tokenId)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) return null;
  return agentActorWhere(tenantId, eq(agentTokens.id, tokenId), now);
}

async function agentActorWhere(
  tenantId: string,
  which: SQL,
  now: Date
): Promise<{ actor: Actor; agent: AgentAuth } | null> {
  const found = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select({ token: agentTokens, agent: agents, slug: tenants.slug, ownerRole: memberships.role })
      .from(agentTokens)
      .innerJoin(agents, and(eq(agents.tenantId, agentTokens.tenantId), eq(agents.id, agentTokens.agentId)))
      .innerJoin(tenants, eq(tenants.id, agentTokens.tenantId))
      .leftJoin(memberships, and(eq(memberships.tenantId, agents.tenantId), eq(memberships.userId, agents.createdBy)))
      .where(and(eq(agentTokens.tenantId, tenantId), which, isNull(tenants.deletedAt)));
    if (!row) return null;
    const { token, agent, ownerRole } = row;
    if (token.revokedAt || (token.expiresAt && token.expiresAt <= now) || agent.disabledAt || !ownerRole) {
      return null;
    }
    await tx
      .update(agentTokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(agentTokens.tenantId, tenantId),
          eq(agentTokens.id, token.id),
          or(isNull(agentTokens.lastUsedAt), lt(agentTokens.lastUsedAt, new Date(now.getTime() - LAST_USED_EVERY_MS)))
        )
      );
    return { ...row, ownerRole };
  });
  if (!found) return null;
  const known = new Set<string>(AGENT_SCOPES);
  return {
    actor: {
      tenantId,
      principalType: 'agent',
      principalId: found.agent.id,
      owner: { userId: found.agent.createdBy, tenantRole: found.ownerRole },
    },
    agent: {
      agentId: found.agent.id,
      agentName: found.agent.name,
      tokenId: found.token.id,
      scopes: found.token.scopes.filter((s): s is AgentScope => known.has(s)),
      tenantSlug: found.slug,
      dailyAiLimit: found.agent.dailyAiLimit,
    },
  };
}
