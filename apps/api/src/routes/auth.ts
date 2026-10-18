import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { getDb, rowsOf, users } from '@living-wiki/db';
import {
  AppError,
  SignInRequestSchema,
  SignUpRequestSchema,
  TenantRoleSchema,
  type AuthResponse,
  type AuthUser,
  type MeResponse,
} from '@living-wiki/contracts';
import { getDummyHash, hashPassword, isUsableHash, verifyPassword } from '../auth/password.js';
import { createSession, revokeSession } from '../auth/sessions.js';
import type { AuthSession } from '../auth/actor.js';

export interface AuthRateLimit {
  max: number;
  timeWindow: string;
}

function toAuthUser(user: { id: string; email: string; name: string }): AuthUser {
  return { id: user.id, email: user.email, name: user.name };
}

async function authResponse(user: AuthUser): Promise<AuthResponse> {
  const session = await createSession(user.id);
  return {
    user,
    session: { token: session.token, expiresAt: session.expiresAt.toISOString() },
  };
}

function sessionOf(req: FastifyRequest): AuthSession {
  if (!req.authSession) throw new AppError('unauthenticated');
  return req.authSession;
}

/** Sign-up, sign-in, sign-out and /me. Must be registered after @fastify/rate-limit. */
export async function authRoutes(
  app: FastifyInstance,
  opts: { authRateLimit: AuthRateLimit }
): Promise<void> {
  const rateLimit = { max: opts.authRateLimit.max, timeWindow: opts.authRateLimit.timeWindow };
  // Compute the dummy hash before serving, so even the first unknown-email
  // sign-in costs exactly one verification.
  await getDummyHash();

  app.post(
    '/api/v1/auth/sign-up',
    { config: { auth: 'public', rateLimit } },
    async (req, reply) => {
      const parsed = SignUpRequestSchema.parse(req.body);
      const passwordHash = await hashPassword(parsed.password);
      // A duplicate email violates users_email_unique -> 409 email_taken (mapDbError).
      const [user] = await getDb()
        .insert(users)
        .values({ email: parsed.email, name: parsed.name, passwordHash })
        .returning();
      return reply.status(201).send(await authResponse(toAuthUser(user)));
    }
  );

  app.post(
    '/api/v1/auth/sign-in',
    { config: { auth: 'public', rateLimit } },
    async (req, reply) => {
      const parsed = SignInRequestSchema.parse(req.body);
      const [user] = await getDb().select().from(users).where(eq(users.email, parsed.email));
      // Always run one argon2 verification so unknown emails, placeholder
      // accounts and wrong passwords cost the same and answer identically.
      const usable = user !== undefined && isUsableHash(user.passwordHash);
      const ok = await verifyPassword(
        parsed.password,
        usable ? user.passwordHash : await getDummyHash()
      );
      if (!usable || !ok) throw new AppError('invalid_credentials');
      return reply.status(200).send(await authResponse(toAuthUser(user)));
    }
  );

  app.post('/api/v1/auth/sign-out', { config: { auth: 'session' } }, async (req, reply) => {
    await revokeSession(sessionOf(req).token);
    return reply.status(204).send();
  });

  app.get('/api/v1/me', { config: { auth: 'session' } }, async (req, reply) => {
    const { userId } = sessionOf(req);
    const [user] = await getDb().select().from(users).where(eq(users.id, userId));
    if (!user) throw new AppError('unauthenticated');
    const rows = rowsOf<{ tenant_id: string; name: string; slug: string; role: string }>(
      await getDb().execute(sql`SELECT tenant_id, name, slug, role FROM my_tenants(${userId}::uuid)`)
    );
    const body: MeResponse = {
      user: toAuthUser(user),
      memberships: rows.map((r) => ({
        tenant: { id: r.tenant_id, name: r.name, slug: r.slug },
        role: TenantRoleSchema.parse(r.role),
      })),
    };
    return reply.send(body);
  });
}
