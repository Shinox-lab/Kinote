import { describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, memberships, users, withTenantTx } from '@kinote/db';
import { AuthConfigSchema, AuthResponseSchema } from '@kinote/contracts';
import { TEST_PASSWORD, bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';
import type { SignUpModeSetting } from '../src/routes/auth.js';

const app = (signUpMode: SignUpModeSetting) => buildTestApp({ signUpMode });

function signUp(server: ReturnType<typeof buildTestApp>, body: Record<string, unknown>) {
  return server.inject({ method: 'POST', url: '/api/v1/auth/sign-up', payload: { name: 'Someone', password: TEST_PASSWORD, ...body } });
}

async function mode(server: ReturnType<typeof buildTestApp>) {
  const res = await server.inject({ method: 'GET', url: '/api/v1/auth/config' });
  expect(res.statusCode).toBe(200);
  return AuthConfigSchema.parse(res.json()).signUpMode;
}

/** A workspace (made in open mode) and an invitation to `email`; returns the accept token. */
async function invitation(email: string, role: 'admin' | 'member' | 'viewer' = 'member') {
  const setup = app('open');
  const { tenant, headers } = await bootstrapTenant(setup, { name: 'Invite Co', slug: `invite-${Math.random().toString(36).slice(2, 8)}` });
  const res = await setup.inject({ method: 'POST', url: '/api/v1/invitations', headers, payload: { email, role } });
  expect(res.statusCode, res.body).toBe(201);
  return { tenant, token: res.json().acceptToken as string, headers, setup };
}

describe('sign-up modes', () => {
  useTestDb();

  test('auto is open until the first real account exists, then needs an invitation', async () => {
    const server = app('auto');
    expect(await mode(server)).toBe('open');
    expect((await signUp(server, { email: 'first@example.test' })).statusCode).toBe(201);
    expect(await mode(server)).toBe('invite');
    const second = await signUp(server, { email: 'second@example.test' });
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe('signup_invite_only');
  });

  test('demo people never count as the first account', async () => {
    await getDb().insert(users).values({ email: 'ann-x@demo.example', name: 'Ann', passwordHash: '!' });
    expect(await mode(app('auto'))).toBe('open');
  });

  test('an invitation sign-up takes the invited email, whatever was posted, and joins the workspace', async () => {
    const { tenant, token } = await invitation('invitee@example.test', 'viewer');
    const server = app('invite');
    const res = await signUp(server, { email: 'attacker@example.test', invitation_token: token });
    expect(res.statusCode, res.body).toBe(201);
    const auth = AuthResponseSchema.parse(res.json());
    expect(auth.user.email).toBe('invitee@example.test');
    expect(auth.joined).toMatchObject({ tenant: { id: tenant.id }, role: 'viewer' });

    const [member] = await withTenantTx(tenant.id, (tx) =>
      tx.select().from(memberships).where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, auth.user.id)))
    );
    expect(member?.role).toBe('viewer');
    expect(await getDb().select().from(users).where(eq(users.email, 'attacker@example.test'))).toEqual([]);

    // The invitation is used up.
    const again = await signUp(server, { invitation_token: token });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe('invitation_invalid');
  });

  test('a bad, expired or replaced invitation creates no account', async () => {
    const server = app('invite');
    expect((await signUp(server, { invitation_token: 'not-a-token' })).json().error).toBe('invitation_invalid');

    const { tenant, token } = await invitation('late@example.test');
    await withTenantTx(tenant.id, (tx) => tx.execute(sql`UPDATE invitations SET expires_at = now() - interval '1 minute'`));
    expect((await signUp(server, { invitation_token: token })).json().error).toBe('invitation_invalid');
    expect(await getDb().select().from(users).where(eq(users.email, 'late@example.test'))).toEqual([]);
  });

  test('an invited email that already has an account must sign in and accept instead', async () => {
    const { token } = await invitation('existing@example.test');
    const server = app('open');
    expect((await signUp(server, { email: 'existing@example.test' })).statusCode).toBe(201);
    const res = await signUp(server, { invitation_token: token });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('email_taken');
  });

  test('closed creates no account, with or without an invitation', async () => {
    const { token } = await invitation('closed@example.test');
    const server = app('closed');
    expect(await mode(server)).toBe('closed');
    expect((await signUp(server, { email: 'new@example.test' })).json().error).toBe('signup_closed');
    expect((await signUp(server, { invitation_token: token })).json().error).toBe('signup_closed');
  });

  test('open still lets anyone sign up; an email is needed without an invitation', async () => {
    const server = app('open');
    expect((await signUp(server, { email: 'one@example.test' })).statusCode).toBe(201);
    expect((await signUp(server, { email: 'two@example.test' })).statusCode).toBe(201);
    expect((await signUp(server, {})).statusCode).toBe(400);
  });

  test('an invitation link shows its email and workspace to whoever holds it', async () => {
    const { token } = await invitation('preview@example.test');
    const server = app('invite');
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/invitation', payload: { token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'preview@example.test', tenantName: 'Invite Co' });
    const bad = await server.inject({ method: 'POST', url: '/api/v1/auth/invitation', payload: { token: `${token}x` } });
    expect(bad.statusCode).toBe(404);
  });
});
