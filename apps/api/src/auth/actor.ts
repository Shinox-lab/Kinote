import type { FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenantTx, memberships, tenants } from '@living-wiki/db';
import { AppError } from '@living-wiki/contracts';
import type { Actor } from '@living-wiki/core';
import { resolveSession } from './sessions.js';

export type AuthMode = 'public' | 'session' | 'tenant';

export interface AuthSession {
  userId: string;
  token: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Who may call the route. Default: 'tenant'. */
    auth?: AuthMode;
  }
  interface FastifyRequest {
    /** Set for 'session' and 'tenant' routes. */
    authSession: AuthSession | null;
    /** Set for 'tenant' routes; derived from the session and the membership row only. */
    actor: Actor | null;
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
  const tenantId = req.headers['x-tenant-id'];
  if (typeof tenantId !== 'string' || !UUID_REGEX.test(tenantId)) {
    throw new AppError('tenant_not_found');
  }
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
