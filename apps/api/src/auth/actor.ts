import type { FastifyRequest } from 'fastify';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { withTenantTx, memberships, sources, sourceTokens, tenants } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import type { Actor } from '@living-wiki/core';
import { resolveSession } from './sessions.js';
import { parseSourceToken } from './sourceTokens.js';

export type AuthMode = 'public' | 'session' | 'tenant' | 'source';

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

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Who may call the route. Default: 'tenant'. 'source' is a bearer source token, never a session. */
    auth?: AuthMode;
  }
  interface FastifyRequest {
    /** Set for 'session' and 'tenant' routes. */
    authSession: AuthSession | null;
    /** Set for 'tenant' routes; derived from the session and the membership row only. */
    actor: Actor | null;
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
  const tenantId = rawTenantId.toLowerCase();
  const membership = await withTenantTx(tenantId, async (tx) => {
    const [row] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, session.userId),
          eq(tenants.id, tenantId),
          isNull(tenants.deletedAt)
        )
      );
    return row ?? null;
  });
  if (!membership) throw new AppError('tenant_not_found');
  return {
    tenantId,
    principalType: 'user',
    principalId: session.userId,
    tenantRole: membership.role,
  };
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
