import assert from 'node:assert/strict';
import { beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { withTenantTx, memberships } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { buildApiServer, type ApiServerOptions } from '../../src/server.js';

/**
 * Gives the enclosing describe (or file) its own in-memory database: created
 * once in beforeAll (migration chain applied, running as living_wiki_app) and
 * emptied before every test. Call it before any other beforeEach hook so the
 * reset runs first.
 */
export function useTestDb(): void {
  let testDb: TestDb | undefined;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  beforeEach(async () => {
    await testDb!.reset();
  });
}

/** Password used for every test account (passes the 10-character minimum). */
export const TEST_PASSWORD = 'correct-horse-battery';

export interface TestSession {
  userId: string;
  token: string;
}

/**
 * The API server as tests use it: identical to production except for a
 * generous auth rate limit, so suites that sign up many users are not
 * throttled. The rate-limit test builds its own server with the default.
 * `opts` adds or overrides server options (e.g. a collab client).
 */
export function buildTestApp(opts: ApiServerOptions = {}): FastifyInstance {
  return buildApiServer({ authRateLimit: { max: 1000, timeWindow: '1 minute' }, ...opts });
}

/** Signs a new user up through the real sign-up route and returns its session. */
export async function signUp(
  app: FastifyInstance,
  email: string = `user-${randomUUID()}@example.test`,
  name: string = email.split('@')[0]
): Promise<TestSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    payload: { email, name, password: TEST_PASSWORD },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { userId: body.user.id, token: body.session.token };
}

/** Request headers for a session, scoped to a tenant when one is given. */
export function asUser(session: { token: string }, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.token}` };
  if (tenantId !== undefined) headers['x-tenant-id'] = tenantId;
  return headers;
}

/** Creates a tenant owned by the session user through the real POST /api/v1/tenants. */
export async function createTenant(
  app: FastifyInstance,
  session: { token: string },
  input: { name: string; slug: string }
): Promise<{ tenant: { id: string; name: string; slug: string }; inboxSpace: { id: string; kind: string } }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/tenants',
    headers: asUser(session),
    payload: input,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

/** Signs up an owner and creates a tenant for them; returns owner session and owner headers. */
export async function bootstrapTenant(
  app: FastifyInstance,
  input: { name: string; slug: string; email?: string }
) {
  const owner = await signUp(app, input.email);
  const { tenant, inboxSpace } = await createTenant(app, owner, {
    name: input.name,
    slug: input.slug,
  });
  return { owner, tenant, inboxSpace, headers: asUser(owner, tenant.id) };
}

/**
 * Adds an existing user to a tenant with the given role by writing the
 * membership row directly (a shortcut for tests that are not about invitations).
 */
export async function addMember(
  tenantId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer'
): Promise<void> {
  await withTenantTx(tenantId, (tx) =>
    tx.insert(memberships).values({ tenantId, userId, role }).then(() => undefined)
  );
}

/** Signs up a new user and adds them to the tenant with the given role. */
export async function signUpMember(
  app: FastifyInstance,
  tenantId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  email?: string
): Promise<TestSession & { headers: Record<string, string> }> {
  const session = await signUp(app, email);
  await addMember(tenantId, session.userId, role);
  return { ...session, headers: asUser(session, tenantId) };
}

/** Changes a member's tenant role directly in the database. */
export async function setMemberRole(
  tenantId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer'
): Promise<void> {
  await withTenantTx(tenantId, (tx) =>
    tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .then(() => undefined)
  );
}
