import { test, describe, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getDb, withTenantTx, invitations, auditEvents, users, memberships } from '@living-wiki/db';
import { sha256Hex } from '@living-wiki/shared';
import { resolveActor } from '../src/auth/actor.js';
import {
  asUser,
  bootstrapTenant,
  buildTestApp,
  signUp,
  signUpMember,
  type TestSession,
  useTestDb
} from './support/testkit.js';

describe('authenticated tenants and accept-by-token invitations', () => {
  const app = buildTestApp();

  useTestDb();

  async function invite(headers: Record<string, string>, email: string, role = 'member') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers,
      payload: { email, role },
    });
  }

  async function accept(session: TestSession, token: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: asUser(session),
      payload: { token },
    });
  }

  async function me(session: TestSession) {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(session) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  }

  test('inviting creates no membership; the right session accepts and sees only Inbox', async () => {
    const { tenant, headers, inboxSpace } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');

    const res = await invite(headers, 'invitee@example.test', 'member');
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.invitation.email, 'invitee@example.test');
    assert.equal(body.invitation.role, 'member');
    assert.ok(Number.isFinite(Date.parse(body.invitation.expiresAt)));
    assert.ok(body.invitation.id);
    assert.match(body.acceptToken, new RegExp(`^${tenant.id}\\.[A-Za-z0-9_-]{43}$`));

    // Nothing joined yet, and only the hash of the secret is stored.
    assert.deepEqual((await me(invitee)).memberships, []);
    const [stored] = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(invitations).where(eq(invitations.tenantId, tenant.id))
    );
    assert.equal(stored.tokenHash, sha256Hex(body.acceptToken.split('.')[1]));
    assert.equal(stored.acceptedAt, null);

    const accepted = await accept(invitee, body.acceptToken);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json(), {
      tenant: { id: tenant.id, name: 'Acme', slug: 'acme' },
      role: 'member',
    });

    const afterMe = await me(invitee);
    assert.equal(afterMe.memberships.length, 1);
    assert.equal(afterMe.memberships[0].role, 'member');

    const spaces = await app.inject({
      method: 'GET',
      url: '/api/v1/spaces',
      headers: asUser(invitee, tenant.id),
    });
    assert.equal(spaces.statusCode, 200);
    assert.deepEqual(
      spaces.json().map((s: any) => s.id),
      [inboxSpace.id]
    );

    const events = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.tenantId, tenant.id))
    );
    const types = events.map((e) => e.type);
    assert.ok(types.includes('member.invited'));
    assert.ok(types.includes('member.joined'));
    const joined = events.find((e) => e.type === 'member.joined')!;
    assert.equal(joined.actorId, invitee.userId);
  });

  test('accepting with another user session answers 404 invitation_invalid and keeps the token usable', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');
    const other = await signUp(app, 'other@example.test');

    const { acceptToken } = (await invite(headers, 'invitee@example.test')).json();

    const wrong = await accept(other, acceptToken);
    assert.equal(wrong.statusCode, 404);
    assert.equal(wrong.json().error, 'invitation_invalid');
    assert.deepEqual((await me(other)).memberships, []);
    // The failed attempt rolled back: the invitation is still pending.
    const [pending] = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(invitations).where(eq(invitations.tenantId, tenant.id))
    );
    assert.equal(pending.acceptedAt, null);

    const right = await accept(invitee, acceptToken);
    assert.equal(right.statusCode, 200, right.body);
    assert.equal((await me(invitee)).memberships[0].tenant.id, tenant.id);
  });

  test('email comparison is case-insensitive', async () => {
    const { headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'mixed@example.test');
    const res = await invite(headers, 'Mixed@Example.TEST', 'viewer');
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().invitation.email, 'mixed@example.test');
    const accepted = await accept(invitee, res.json().acceptToken);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().role, 'viewer');
  });

  test('a used token answers 404 invitation_invalid', async () => {
    const { headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');
    const { acceptToken } = (await invite(headers, 'invitee@example.test')).json();
    assert.equal((await accept(invitee, acceptToken)).statusCode, 200);
    const again = await accept(invitee, acceptToken);
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error, 'invitation_invalid');
  });

  test('an expired invitation answers 404 invitation_invalid', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');
    const { acceptToken } = (await invite(headers, 'invitee@example.test')).json();

    await withTenantTx(tenant.id, (tx) =>
      tx
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invitations.tenantId, tenant.id))
    );

    const res = await accept(invitee, acceptToken);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'invitation_invalid');
    assert.deepEqual((await me(invitee)).memberships, []);
  });

  test('malformed, unknown-tenant and wrong-secret tokens all answer 404 invitation_invalid', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');
    const { acceptToken } = (await invite(headers, 'invitee@example.test')).json();
    const secret = acceptToken.split('.')[1];

    const bad = [
      'garbage',
      '',
      `${tenant.id}.`,
      `.${secret}`,
      `${tenant.id}.${secret}x`,
      `00000000-0000-4000-8000-000000000000.${secret}`,
      `not-a-uuid.${secret}`,
      `${tenant.id}.${secret}.extra`,
    ];
    for (const token of bad) {
      const res = await accept(invitee, token);
      assert.equal(res.statusCode, 404, `token ${JSON.stringify(token)}: ${res.body}`);
      assert.equal(res.json().error, 'invitation_invalid');
    }
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      headers: asUser(invitee),
      payload: {},
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, 'validation_failed');

    const noSession = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: acceptToken },
    });
    assert.equal(noSession.statusCode, 401);
  });

  test('re-inviting the same email replaces the pending invitation', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');

    const first = (await invite(headers, 'invitee@example.test', 'member')).json();
    const secondRes = await invite(headers, 'invitee@example.test', 'viewer');
    assert.equal(secondRes.statusCode, 201, secondRes.body);
    const second = secondRes.json();
    assert.notEqual(second.acceptToken, first.acceptToken);

    const rows = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(invitations).where(eq(invitations.tenantId, tenant.id))
    );
    assert.equal(rows.length, 1);

    const old = await accept(invitee, first.acceptToken);
    assert.equal(old.statusCode, 404);
    assert.equal(old.json().error, 'invitation_invalid');

    const fresh = await accept(invitee, second.acceptToken);
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().role, 'viewer');
  });

  test('after acceptance the same email can be invited again (partial unique index)', async () => {
    const { headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');
    const first = (await invite(headers, 'invitee@example.test', 'viewer')).json();
    assert.equal((await accept(invitee, first.acceptToken)).statusCode, 200);

    const again = await invite(headers, 'invitee@example.test', 'admin');
    assert.equal(again.statusCode, 201, again.body);
    // An existing membership keeps its role.
    const accepted = await accept(invitee, again.json().acceptToken);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().role, 'viewer');
    assert.equal((await me(invitee)).memberships[0].role, 'viewer');
  });

  test('a tenant token never works against another tenant (hash lookup is tenant-scoped)', async () => {
    const a = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const b = await bootstrapTenant(app, { name: 'Beta', slug: 'beta' });
    const invitee = await signUp(app, 'invitee@example.test');
    const { acceptToken } = (await invite(a.headers, 'invitee@example.test')).json();
    const secret = acceptToken.split('.')[1];

    const res = await accept(invitee, `${b.tenant.id}.${secret}`);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'invitation_invalid');
  });

  test('a plain member inviting answers 403 forbidden; an admin may invite', async () => {
    const { tenant } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const member = await signUpMember(app, tenant.id, 'member');
    const denied = await invite(member.headers, 'x@example.test');
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, 'forbidden');

    const admin = await signUpMember(app, tenant.id, 'admin');
    const ok = await invite(admin.headers, 'x@example.test');
    assert.equal(ok.statusCode, 201, ok.body);
  });

  test('a non-admin with an invalid body gets 403, not 400', async () => {
    const { tenant } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const member = await signUpMember(app, tenant.id, 'member');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: member.headers,
      payload: { email: 'not-an-email', role: 'owner' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'forbidden');
  });

  test('two simultaneous accepts of one token: exactly one 200, one 404, one member.joined', async () => {
    // PGlite has a single connection and may serialise these calls; the test
    // still pins the outcome, and the claim-first UPDATE keeps it true under
    // real READ COMMITTED concurrency.
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const invitee = await signUp(app, 'invitee@example.test');
    const { acceptToken } = (await invite(headers, 'invitee@example.test')).json();

    const results = await Promise.all([accept(invitee, acceptToken), accept(invitee, acceptToken)]);
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [200, 404]);
    const loser = results.find((r) => r.statusCode === 404)!;
    assert.equal(loser.json().error, 'invitation_invalid');

    const joined = await withTenantTx(tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenant.id), eq(auditEvents.type, 'member.joined')))
    );
    assert.equal(joined.length, 1);
  });

  test('concurrent re-invites of one email both succeed and leave a single pending invitation', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const results = await Promise.all([
      invite(headers, 'invitee@example.test', 'member'),
      invite(headers, 'invitee@example.test', 'viewer'),
    ]);
    for (const r of results) assert.equal(r.statusCode, 201, r.body);
    const rows = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(invitations).where(eq(invitations.tenantId, tenant.id))
    );
    assert.equal(rows.length, 1);
  });

  test('inviting as owner (or any unknown role) answers 400 validation_failed', async () => {
    const { headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    for (const role of ['owner', 'superuser']) {
      const res = await invite(headers, 'x@example.test', role);
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error, 'validation_failed');
    }
    const badEmail = await invite(headers, 'not-an-email', 'member');
    assert.equal(badEmail.statusCode, 400);
  });

  test('R8: invitations never create users or return user data; sign-up with the invited email still works', async () => {
    const { tenant, headers } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const before = await getDb().select().from(users);

    const res = await invite(headers, 'newcomer@example.test', 'member');
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['acceptToken', 'invitation']);
    assert.deepEqual(Object.keys(body.invitation).sort(), ['email', 'expiresAt', 'id', 'role']);
    for (const key of ['userId', 'phone', 'passwordHash']) {
      assert.equal(key in body, false);
      assert.equal(key in body.invitation, false);
    }
    assert.equal((await getDb().select().from(users)).length, before.length);
    const members = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(memberships).where(and(eq(memberships.tenantId, tenant.id)))
    );
    assert.equal(members.length, 1);

    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      payload: { email: 'newcomer@example.test', name: 'Newcomer', password: 'correct-horse-battery' },
    });
    assert.equal(signUpRes.statusCode, 201, signUpRes.body);
    const newcomer = {
      userId: signUpRes.json().user.id as string,
      token: signUpRes.json().session.token as string,
    };
    const accepted = await accept(newcomer, body.acceptToken);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().role, 'member');
  });

  test('R8: an upper-case tenant id in x-tenant-id works and the actor tenant id is lower-case', async () => {
    const { tenant, owner } = await bootstrapTenant(app, { name: 'Acme', slug: 'acme' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/spaces',
      headers: { ...asUser(owner), 'x-tenant-id': tenant.id.toUpperCase() },
      payload: { name: 'Docs', slug: 'docs' },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().tenantId, tenant.id);
    assert.equal(res.json().tenantId, res.json().tenantId.toLowerCase());

    // The database normalises uuid columns, so also check the actor itself.
    const actor = await resolveActor({
      headers: { ...asUser(owner), 'x-tenant-id': tenant.id.toUpperCase() },
    } as unknown as FastifyRequest);
    assert.equal(actor.tenantId, tenant.id);
    assert.equal(actor.tenantId, actor.tenantId.toLowerCase());
  });
});
