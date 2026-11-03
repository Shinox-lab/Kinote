import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { getDb, rowsOf, sessions, users } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';
import {
  AuthResponseSchema,
  MeResponseSchema,
  ERROR_SENTENCES,
} from '@kinote/contracts';
import { buildApiServer } from '../src/server.js';
import { clearSessionCache, resolveSession } from '../src/auth/sessions.js';
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
    clearSessionCache();
    const expired = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(other) });
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.json().error, 'unauthenticated');
    assert.equal(await resolveSession(other.token), null);
  });

  test('a session lasts 14 days unused, is renewed while in use, and never past 90 days', async () => {
    const day = 86400 * 1000;
    const start = Date.now();
    const at = (days: number) => new Date(start + days * day);
    const expiry = async (token: string) =>
      (await getDb().select().from(sessions).where(eq(sessions.tokenHash, sha256Hex(token))))[0]!.expiresAt.getTime();

    // Unused after its first week, it ends 14 days after it began.
    const idle = await signUp(app);
    assert.deepEqual(await resolveSession(idle.token, at(6)), { userId: idle.userId });
    clearSessionCache();
    assert.equal(await resolveSession(idle.token, at(15)), null);

    // Used in its first week, it is not renewed (no write); in its second week it is.
    const used = await signUp(app);
    const first = await expiry(used.token);
    await resolveSession(used.token, at(3));
    assert.equal(await expiry(used.token), first);
    clearSessionCache();
    await resolveSession(used.token, at(10));
    assert.ok(Math.abs((await expiry(used.token)) - at(24).getTime()) < 60_000, 'renewed to 14 days from use');

    // Used every 10 days it keeps going, but stops 90 days after it began.
    for (let d = 20; d <= 80; d += 10) {
      clearSessionCache();
      assert.deepEqual(await resolveSession(used.token, at(d)), { userId: used.userId }, `day ${d}`);
    }
    assert.ok((await expiry(used.token)) <= at(90).getTime() + 60_000, 'capped at 90 days');
    clearSessionCache();
    assert.equal(await resolveSession(used.token, at(91)), null);
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
    assert.ok(Math.abs(ttl - 14 * 86400 * 1000) < 60_000, `ttl ${ttl}`);

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
      // A different email each time: this is the per-IP limit, not the per-account one.
      let n = 0;
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          payload: { email: `nobody-${++n}@example.test`, password: 'not-the-password' },
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

  test('a hop count trusts only that many proxies: real clients get their own bucket, a spoofed leftmost X-Forwarded-For does not', async () => {
    // One trusted proxy appends the address it saw; whatever the client put
    // before it is not trusted, so it cannot pick a fresh rate-limit bucket.
    const attempt = (xff: string) =>
      oneHop.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { 'x-forwarded-for': xff },
        payload: { email: 'nobody@example.test', password: 'not-the-password' },
      });
    const oneHop = buildApiServer({ authRateLimit: { max: 1, timeWindow: '1 minute' }, trustProxy: 1 });
    try {
      assert.equal((await attempt('198.51.100.7')).statusCode, 401);
      // A different client behind the same proxy has its own bucket.
      assert.equal((await attempt('198.51.100.8')).statusCode, 401);
      // The first client again, with a forged leftmost entry: same bucket.
      assert.equal((await attempt('203.0.113.99, 198.51.100.7')).statusCode, 429);
    } finally {
      await oneHop.close();
    }
  });

  test('two api processes count sign-ins against one shared limit', async () => {
    const authRateLimit = { max: 2, timeWindow: '1 minute' };
    const first = buildApiServer({ authRateLimit });
    const second = buildApiServer({ authRateLimit });
    const attempt = (server: ReturnType<typeof buildApiServer>) =>
      server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        payload: { email: 'nobody@example.test', password: 'not-the-password' },
      });
    try {
      assert.equal((await attempt(first)).statusCode, 401);
      assert.equal((await attempt(second)).statusCode, 401);
      // The third attempt is over the limit whichever process takes it.
      const third = await attempt(first);
      assert.equal(third.statusCode, 429);
      assert.ok(Number(third.headers['retry-after']) > 0, 'says how long to wait');
      // Sign-up has a bucket of its own.
      const signUpRes = await second.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        payload: { email: 'fresh@example.test', name: 'Fresh', password: TEST_PASSWORD },
      });
      assert.equal(signUpRes.statusCode, 201, signUpRes.body);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('sign-in refuses rather than skipping its limit when the counters cannot be read', async () => {
    const server = buildApiServer();
    try {
      // As the owner (the app role may not alter tables), on the test database's one connection.
      await getDb().execute(sql`RESET ROLE`);
      await getDb().execute(sql`ALTER TABLE rate_limit_counters RENAME TO rate_limit_counters_away`);
      await getDb().execute(sql`SET ROLE kinote_app`);
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        payload: { email: 'nobody@example.test', password: 'not-the-password' },
      });
      assert.equal(res.statusCode, 500);
    } finally {
      await getDb().execute(sql`RESET ROLE`);
      await getDb().execute(sql`ALTER TABLE IF EXISTS rate_limit_counters_away RENAME TO rate_limit_counters`);
      await getDb().execute(sql`SET ROLE kinote_app`);
      await server.close();
    }
  });

  describe('failed sign-ins per account', () => {
    // One trusted proxy, so each attempt can come from its own client address.
    const server = () => buildApiServer({ authRateLimit: { max: 1000, timeWindow: '1 minute' }, trustProxy: 1 });
    let ip = 0;
    const signIn = (app: ReturnType<typeof buildApiServer>, email: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { 'x-forwarded-for': `198.51.100.${++ip % 250}` },
        payload: { email, password },
      });

    test('five wrong passwords from five addresses lock the account, even against the right password', async () => {
      const app = server();
      try {
        const user = await signUp(app, 'target@example.test');
        assert.ok(user.token);
        for (let i = 1; i <= 5; i++) {
          assert.equal((await signIn(app, 'target@example.test', 'wrong-password')).statusCode, 401, `attempt ${i}`);
        }
        const locked = await signIn(app, 'target@example.test', TEST_PASSWORD);
        assert.equal(locked.statusCode, 429);
        assert.equal(locked.json().error, 'rate_limited');
        const wait = Number(locked.headers['retry-after']);
        assert.ok(wait > 0 && wait <= 60, `first lock is at most a minute, got ${wait}`);

        // The lock ends by itself; then the right password works and the count starts over.
        await getDb().execute(sql`UPDATE rate_limit_counters SET reset_at = now() - interval '1 second' WHERE key LIKE 'signin-lock:%'`);
        assert.equal((await signIn(app, 'target@example.test', TEST_PASSWORD)).statusCode, 200);
      } finally {
        await app.close();
      }
    });

    test('an unknown email is throttled exactly like a real one', async () => {
      const app = server();
      try {
        for (let i = 1; i <= 5; i++) {
          assert.equal((await signIn(app, 'ghost@example.test', 'wrong-password')).statusCode, 401);
        }
        assert.equal((await signIn(app, 'ghost@example.test', 'wrong-password')).statusCode, 429);
        // The count is per email, whatever its case.
        assert.equal((await signIn(app, 'GHOST@example.test', 'wrong-password')).statusCode, 429);
        assert.equal((await signIn(app, 'someone-else@example.test', 'wrong-password')).statusCode, 401);
      } finally {
        await app.close();
      }
    });

    test('a successful sign-in forgets earlier failures', async () => {
      const app = server();
      try {
        await signUp(app, 'forgetful@example.test');
        for (let i = 0; i < 4; i++) await signIn(app, 'forgetful@example.test', 'wrong-password');
        assert.equal((await signIn(app, 'forgetful@example.test', TEST_PASSWORD)).statusCode, 200);
        for (let i = 0; i < 4; i++) {
          assert.equal((await signIn(app, 'forgetful@example.test', 'wrong-password')).statusCode, 401);
        }
      } finally {
        await app.close();
      }
    });

    test('each lock within a day is longer than the one before, up to 15 minutes', async () => {
      const app = server();
      try {
        const waits: number[] = [];
        for (let round = 0; round < 6; round++) {
          for (let i = 0; i < 5; i++) await signIn(app, 'persistent@example.test', 'wrong-password');
          const locked = await signIn(app, 'persistent@example.test', 'wrong-password');
          assert.equal(locked.statusCode, 429);
          waits.push(Number(locked.headers['retry-after']));
          await getDb().execute(sql`UPDATE rate_limit_counters SET reset_at = now() - interval '1 second' WHERE key LIKE 'signin-lock:%'`);
        }
        for (let i = 1; i < waits.length; i++) assert.ok(waits[i]! >= waits[i - 1]!, `waits grow: ${waits}`);
        assert.ok(waits[0]! <= 60 && waits[1]! > 60, `doubles: ${waits}`);
        assert.ok(waits.at(-1)! <= 15 * 60, `capped: ${waits}`);
      } finally {
        await app.close();
      }
    });
  });

  test('TRUST_PROXY settings that weaken the sign-in limit are logged once', async () => {
    const logged = (server: { lines: string[] }) => server.lines.filter((l) => l.includes('TRUST_PROXY')).length;
    const build = (trustProxy?: boolean | number) => {
      const lines: string[] = [];
      const app = buildApiServer({
        trustProxy,
        logger: { level: 'warn', stream: { write: (line: string) => void lines.push(line) } },
      });
      return { app, lines };
    };
    const hit = (app: ReturnType<typeof buildApiServer>, xff?: string) =>
      app.inject({ method: 'GET', url: '/api/v1/me', headers: xff ? { 'x-forwarded-for': xff } : {} });

    const direct = build(false);
    const everyHop = build(true);
    const oneHop = build(1);
    try {
      await direct.app.ready();
      await hit(direct.app);
      assert.equal(logged(direct), 0, 'no header, nothing to warn about');
      await hit(direct.app, '198.51.100.7');
      await hit(direct.app, '198.51.100.8');
      assert.equal(logged(direct), 1, 'false behind a proxy warns once');

      await everyHop.app.ready();
      assert.equal(logged(everyHop), 1, 'true warns at start');

      await oneHop.app.ready();
      await hit(oneHop.app, '198.51.100.7');
      assert.equal(logged(oneHop), 0, 'a hop count is the recommended form');
    } finally {
      await direct.app.close();
      await everyHop.app.close();
      await oneHop.app.close();
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
    assert.equal(rowsOf<{ u: string }>(role)[0].u, 'kinote_app');

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
      SELECT has_function_privilege('kinote_app', 'my_tenants(uuid)', 'EXECUTE') AS app_exec,
             has_function_privilege('public', 'my_tenants(uuid)', 'EXECUTE') AS public_exec,
             has_table_privilege('kinote_app', 'sessions', 'SELECT,INSERT,UPDATE') AS sessions_rw`);
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
