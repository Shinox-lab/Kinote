import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { getDb, rowsOf, sessions, users } from '@living-wiki/db';
import { sha256Hex } from '@living-wiki/shared';
import {
  AuthResponseSchema,
  MeResponseSchema,
  ERROR_SENTENCES,
} from '@living-wiki/contracts';
import { buildApiServer } from '../src/server.js';
import { resolveSession } from '../src/auth/sessions.js';
import {
  TEST_PASSWORD,
  addMember,
  asUser,
  bootstrapTenant,
  buildTestApp,
  createTenant,
  signUp,
  signUpMember,
  useTestDb
} from './support/testkit.js';

describe('sessions and the database-derived actor', () => {
  const app = buildTestApp();

  useTestDb();

  test('tenant routes without Authorization answer 401 unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/spaces' });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), {
      error: 'unauthenticated',
      message: ERROR_SENTENCES.unauthenticated,
    });

    const garbage = await app.inject({
      method: 'GET',
      url: '/api/v1/spaces',
      headers: { authorization: 'Bearer lws_not-a-real-token' },
    });
    assert.equal(garbage.statusCode, 401);
    assert.equal(garbage.json().error, 'unauthenticated');
  });

  test('forged identity headers are ignored entirely; the role comes from the membership row', async () => {
    const { owner, tenant } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const member = await signUpMember(app, tenant.id, 'member');

    // A member forging an owner identity + role is still just a member.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: {
        ...member.headers,
        'x-tenant-role': 'owner',
        'x-principal-type': 'user',
        'x-principal-id': owner.userId,
      },
      payload: { name: 'Engineering', slug: 'engineering' },
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.json().error, 'forbidden');

    // Headers alone (no session) do not authenticate at all.
    const headersOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: {
        'x-tenant-id': tenant.id,
        'x-tenant-role': 'owner',
        'x-principal-type': 'user',
        'x-principal-id': owner.userId,
      },
      payload: { name: 'Engineering', slug: 'engineering' },
    });
    assert.equal(headersOnly.statusCode, 401);

    // The real owner can.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: asUser(owner, tenant.id),
      payload: { name: 'Engineering', slug: 'engineering' },
    });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(ok.json().createdBy, owner.userId);
  });

  test("a session sending another tenant's x-tenant-id answers 404 tenant_not_found", async () => {
    const a = await bootstrapTenant(app, { name: 'Tenant A', slug: 'tenant-a' });
    const b = await bootstrapTenant(app, { name: 'Tenant B', slug: 'tenant-b' });

    const cross = await app.inject({
      method: 'GET',
      url: '/api/v1/spaces',
      headers: asUser(a.owner, b.tenant.id),
    });
    assert.equal(cross.statusCode, 404);
    assert.deepEqual(cross.json(), {
      error: 'tenant_not_found',
      message: ERROR_SENTENCES.tenant_not_found,
    });

    for (const tenantId of [undefined, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/spaces',
        headers: asUser(a.owner, tenantId),
      });
      assert.equal(res.statusCode, 404, `tenant id ${String(tenantId)}`);
      assert.equal(res.json().error, 'tenant_not_found');
    }

    const own = await app.inject({
      method: 'GET',
      url: '/api/v1/spaces',
      headers: asUser(a.owner, a.tenant.id),
    });
    assert.equal(own.statusCode, 200);
  });

  test('sign-out revokes the token; an expired session is rejected', async () => {
    const { owner, tenant } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });

    const before = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(owner) });
    assert.equal(before.statusCode, 200);

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: asUser(owner),
    });
    assert.equal(out.statusCode, 204);
    assert.equal(out.body, '');

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(owner) });
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().error, 'unauthenticated');
    const spaces = await app.inject({
      method: 'GET',
      url: '/api/v1/spaces',
      headers: asUser(owner, tenant.id),
    });
    assert.equal(spaces.statusCode, 401);

    // Expiry
    const other = await signUp(app);
    assert.deepEqual(await resolveSession(other.token), { userId: other.userId });
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, sha256Hex(other.token)));
    const expired = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(other) });
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.json().error, 'unauthenticated');
    assert.equal(await resolveSession(other.token), null);
  });

  test('resolveSession honours the 30-day TTL', async () => {
    const s = await signUp(app);
    const day = 86400 * 1000;
    assert.deepEqual(await resolveSession(s.token, new Date(Date.now() + 29 * day)), {
      userId: s.userId,
    });
    assert.equal(await resolveSession(s.token, new Date(Date.now() + 31 * day)), null);
  });

  test('sign-up returns the camelCase user and session; only the token hash is stored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      payload: { email: 'Alice@Example.test', name: 'Alice', password: TEST_PASSWORD },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = AuthResponseSchema.strict().parse(res.json());
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'name']);
    assert.equal(body.user.email, 'alice@example.test');
    assert.match(body.session.token, /^lws_[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(body.session.expiresAt).getTime() - Date.now();
    assert.ok(Math.abs(ttl - 30 * 86400 * 1000) < 60_000, `ttl ${ttl}`);

    const rows = await getDb().select().from(sessions).where(eq(sessions.userId, body.user.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenHash, sha256Hex(body.session.token));
    assert.notEqual(rows[0].tokenHash, body.session.token);

    const [user] = await getDb().select().from(users).where(eq(users.id, body.user.id));
    assert.match(user.passwordHash, /^\$argon2id\$/);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      payload: { email: 'alice@example.test', name: 'Alice 2', password: TEST_PASSWORD },
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, 'email_taken');

    const short = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      payload: { email: 'bob@example.test', name: 'Bob', password: '123456789' },
    });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error, 'validation_failed');
    assert.equal(short.json().issues[0].path, 'password');
  });

  test('sign-in succeeds with the right password; wrong password and unknown email are indistinguishable', async () => {
    await signUp(app, 'carol@example.test');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { email: 'carol@example.test', password: TEST_PASSWORD },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    const session = AuthResponseSchema.strict().parse(ok.json());
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(session.session) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email, 'carol@example.test');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { email: 'carol@example.test', password: 'not-the-password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { email: 'nobody@example.test', password: 'not-the-password' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, wrong.statusCode);
    assert.equal(unknown.body, wrong.body);
    assert.deepEqual(wrong.json(), {
      error: 'invalid_credentials',
      message: ERROR_SENTENCES.invalid_credentials,
    });
  });

  test('inviting an unregistered email creates no account that could sign in', async () => {
    const { headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invited = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers,
      payload: { email: 'invitee@example.test', role: 'member' },
    });
    assert.equal(invited.statusCode, 201, invited.body);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { email: 'invitee@example.test', password: '!' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'invalid_credentials');
    const rows = await getDb().select().from(users).where(eq(users.email, 'invitee@example.test'));
    assert.equal(rows.length, 0);
  });

  test('the 11th sign-in within a minute from one IP answers 429 rate_limited', async () => {
    const limited = buildApiServer();
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          payload: { email: 'nobody@example.test', password: 'not-the-password' },
        });
      for (let i = 1; i <= 10; i++) {
        const res = await attempt();
        assert.equal(res.statusCode, 401, `attempt ${i}`);
      }
      const eleventh = await attempt();
      assert.equal(eleventh.statusCode, 429);
      assert.deepEqual(eleventh.json(), {
        error: 'rate_limited',
        message: ERROR_SENTENCES.rate_limited,
      });
    } finally {
      await limited.close();
    }
  });

  test('X-Forwarded-For keys the rate limit only when trustProxy is set', async () => {
    const attempt = (server: ReturnType<typeof buildApiServer>, ip: string) =>
      server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { 'x-forwarded-for': ip },
        payload: { email: 'nobody@example.test', password: 'not-the-password' },
      });
    const authRateLimit = { max: 1, timeWindow: '1 minute' };

    const proxied = buildApiServer({ authRateLimit, trustProxy: true });
    const direct = buildApiServer({ authRateLimit });
    try {
      assert.equal((await attempt(proxied, '203.0.113.1')).statusCode, 401);
      assert.equal((await attempt(proxied, '203.0.113.2')).statusCode, 401);
      assert.equal((await attempt(proxied, '203.0.113.1')).statusCode, 429);

      // Without trustProxy the header is client-controlled and ignored.
      assert.equal((await attempt(direct, '203.0.113.1')).statusCode, 401);
      assert.equal((await attempt(direct, '203.0.113.2')).statusCode, 429);
    } finally {
      await proxied.close();
      await direct.close();
    }
  });

  test('GET /api/v1/me lists every tenant the user belongs to, with roles, via my_tenants', async () => {
    const a = await bootstrapTenant(app, { name: 'Tenant A', slug: 'tenant-a' });
    const b = await bootstrapTenant(app, { name: 'Tenant B', slug: 'tenant-b' });
    await bootstrapTenant(app, { name: 'Tenant C', slug: 'tenant-c' });
    await addMember(b.tenant.id, a.owner.userId, 'viewer');

    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(a.owner) });
    assert.equal(res.statusCode, 200, res.body);
    const me = MeResponseSchema.strict().parse(res.json());
    assert.equal(me.user.id, a.owner.userId);
    assert.deepEqual(Object.keys(me.user).sort(), ['email', 'id', 'name']);
    const memberships = [...me.memberships].sort((x, y) => x.tenant.slug.localeCompare(y.tenant.slug));
    assert.deepEqual(memberships, [
      { tenant: { id: a.tenant.id, name: 'Tenant A', slug: 'tenant-a' }, role: 'owner' },
      { tenant: { id: b.tenant.id, name: 'Tenant B', slug: 'tenant-b' }, role: 'viewer' },
    ]);

    // The role resolved per tenant comes from that tenant's membership row.
    const asViewer = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: asUser(a.owner, b.tenant.id),
      payload: { name: 'X', slug: 'x' },
    });
    assert.equal(asViewer.statusCode, 403);

    const unauth = await app.inject({ method: 'GET', url: '/api/v1/me' });
    assert.equal(unauth.statusCode, 401);
  });

  test('my_tenants runs as the app role across tenants (SECURITY DEFINER) and app role can use sessions', async () => {
    const a = await bootstrapTenant(app, { name: 'Tenant A', slug: 'tenant-a' });
    const b = await bootstrapTenant(app, { name: 'Tenant B', slug: 'tenant-b' });
    await addMember(b.tenant.id, a.owner.userId, 'admin');

    const role = await getDb().execute(sql`SELECT current_user AS u`);
    assert.equal(rowsOf<{ u: string }>(role)[0].u, 'living_wiki_app');

    // Without the function, RLS hides both tenants from the app role.
    const direct = await getDb().execute(sql`SELECT count(*)::int AS n FROM memberships`);
    assert.equal(rowsOf<{ n: number }>(direct)[0].n, 0);

    const rows = await getDb().execute(
      sql`SELECT tenant_id, name, slug, role FROM my_tenants(${a.owner.userId}::uuid) ORDER BY slug`
    );
    assert.deepEqual(rowsOf(rows), [
      { tenant_id: a.tenant.id, name: 'Tenant A', slug: 'tenant-a', role: 'owner' },
      { tenant_id: b.tenant.id, name: 'Tenant B', slug: 'tenant-b', role: 'admin' },
    ]);

    const priv = await getDb().execute(sql`
      SELECT has_function_privilege('living_wiki_app', 'my_tenants(uuid)', 'EXECUTE') AS app_exec,
             has_function_privilege('public', 'my_tenants(uuid)', 'EXECUTE') AS public_exec,
             has_table_privilege('living_wiki_app', 'sessions', 'SELECT,INSERT,UPDATE') AS sessions_rw`);
    assert.deepEqual(rowsOf(priv)[0], { app_exec: true, public_exec: false, sessions_rw: true });
  });

  test('POST /api/v1/tenants needs a session and makes the session user the owner', async () => {
    const unauth = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: { name: 'Acme', slug: 'acme' },
    });
    assert.equal(unauth.statusCode, 401);

    const s = await signUp(app);
    const { tenant, inboxSpace } = await createTenant(app, s, { name: 'Acme', slug: 'acme' });
    assert.equal(inboxSpace.kind, 'inbox');
    const me = (await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(s) })).json();
    assert.deepEqual(me.memberships, [
      { tenant: { id: tenant.id, name: 'Acme', slug: 'acme' }, role: 'owner' },
    ]);
  });
});
