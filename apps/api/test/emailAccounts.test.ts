import { describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, users } from '@kinote/db';
import { AuthResponseSchema } from '@kinote/contracts';
import { MemoryMailer } from '../src/mail.js';
import { resetPasswordLink } from '../src/cli/resetPassword.js';
import { TEST_PASSWORD, asUser, bootstrapTenant, buildTestApp, signUp as signUpOpen, useTestDb } from './support/testkit.js';

const NEW_PASSWORD = 'another-long-password';

function withMail() {
  const mailer = new MemoryMailer();
  return { app: buildTestApp({ mailer }), mailer };
}

const post = (app: ReturnType<typeof buildTestApp>, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as any, headers });

/** The token at the end of the last link mailed to `to`. */
function tokenFrom(mailer: MemoryMailer, to: string): string {
  const link = mailer.lastLink(to);
  expect(link, `a link was mailed to ${to}`).toBeTruthy();
  return link!.split('/').at(-1)!;
}

describe('accounts with email', () => {
  useTestDb();

  test('sign-up answers the same for a new and a taken address; only the email differs', async () => {
    const { app, mailer } = withMail();
    const fresh = await post(app, '/api/v1/auth/sign-up', { email: 'new@example.test', name: 'New', password: TEST_PASSWORD });
    expect(fresh.statusCode).toBe(202);
    expect(fresh.json()).toEqual({ checkEmail: true });

    const taken = await post(app, '/api/v1/auth/sign-up', { email: 'new@example.test', name: 'Other', password: TEST_PASSWORD });
    expect(taken.statusCode).toBe(202);
    expect(taken.json()).toEqual({ checkEmail: true });

    expect(mailer.sent.map((m) => m.subject)).toEqual([
      'Confirm your email for Kinote',
      'Someone tried to create a Kinote account with your email',
    ]);
    // The second sign-up changed nothing about the account.
    const [user] = await getDb().select().from(users).where(eq(users.email, 'new@example.test'));
    expect(user?.name).toBe('New');
    expect(user?.emailVerifiedAt).toBeNull();
  });

  test('the verification link confirms the address, signs in, and works once', async () => {
    const { app, mailer } = withMail();
    await post(app, '/api/v1/auth/sign-up', { email: 'v@example.test', name: 'V', password: TEST_PASSWORD });
    const token = tokenFrom(mailer, 'v@example.test');
    expect(mailer.lastLink('v@example.test')).toBe(`https://wiki.example/verify-email/${token}`);

    const res = await post(app, '/api/v1/auth/verify', { token });
    expect(res.statusCode).toBe(200);
    expect(AuthResponseSchema.parse(res.json()).user.email).toBe('v@example.test');
    const [user] = await getDb().select().from(users).where(eq(users.email, 'v@example.test'));
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);

    const again = await post(app, '/api/v1/auth/verify', { token });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe('link_invalid');
  });

  test('an unconfirmed account cannot take an invitation sent to its address; once confirmed it can', async () => {
    const { app, mailer } = withMail();
    // The admin's account comes from a server without email (sign-up there signs in at once).
    const { headers } = await bootstrapTenant(buildTestApp(), { name: 'Mail Co', slug: 'mail-co' });
    const invite = await post(app, '/api/v1/invitations', { email: 'squat@example.test', role: 'admin' }, headers);
    const acceptToken = invite.json().acceptToken as string;

    // Someone registers the invited address first, and signs in with the password they chose.
    await post(app, '/api/v1/auth/sign-up', { email: 'squat@example.test', name: 'Squatter', password: TEST_PASSWORD });
    const signIn = await post(app, '/api/v1/auth/sign-in', { email: 'squat@example.test', password: TEST_PASSWORD });
    const session = AuthResponseSchema.parse(signIn.json()).session;
    const accept = await post(app, '/api/v1/invitations/accept', { token: acceptToken }, asUser(session));
    expect(accept.statusCode).toBe(403);
    expect(accept.json().error).toBe('email_unverified');

    // The real owner of the inbox confirms it (here, the verification link) and then can.
    await post(app, '/api/v1/auth/verify', { token: tokenFrom(mailer, 'squat@example.test') });
    expect((await post(app, '/api/v1/invitations/accept', { token: acceptToken }, asUser(session))).statusCode).toBe(200);
  });

  test('a password reset is answered the same for any address, mails only real accounts, and ends every session', async () => {
    const { app, mailer } = withMail();
    const owner = await signUpOpenWithoutMail('reset@example.test');
    const before = mailer.sent.length;

    expect((await post(app, '/api/v1/auth/password-reset/request', { email: 'nobody@example.test' })).statusCode).toBe(202);
    expect(mailer.sent.length).toBe(before);
    expect((await post(app, '/api/v1/auth/password-reset/request', { email: 'reset@example.test' })).statusCode).toBe(202);
    const token = tokenFrom(mailer, 'reset@example.test');

    const res = await post(app, '/api/v1/auth/password-reset/confirm', { token, password: NEW_PASSWORD });
    expect(res.statusCode).toBe(200);
    // The old session is gone; the old password no longer works; the new one does.
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(owner) })).statusCode).toBe(401);
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'reset@example.test', password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'reset@example.test', password: NEW_PASSWORD })).statusCode).toBe(200);
    // The link works once.
    expect((await post(app, '/api/v1/auth/password-reset/confirm', { token, password: NEW_PASSWORD })).statusCode).toBe(404);
  });

  test('reset emails to one address are capped at three an hour', async () => {
    const { app, mailer } = withMail();
    await signUpOpenWithoutMail('busy@example.test');
    for (let i = 0; i < 5; i++) {
      expect((await post(app, '/api/v1/auth/password-reset/request', { email: 'busy@example.test' })).statusCode).toBe(202);
    }
    expect(mailer.sent.filter((m) => m.to === 'busy@example.test')).toHaveLength(3);
  });

  test('a reset link from an expired token does nothing', async () => {
    const { app, mailer } = withMail();
    await signUpOpenWithoutMail('slow@example.test');
    await post(app, '/api/v1/auth/password-reset/request', { email: 'slow@example.test' });
    await getDb().execute(sql`UPDATE email_tokens SET expires_at = now() - interval '1 second'`);
    const res = await post(app, '/api/v1/auth/password-reset/confirm', { token: tokenFrom(mailer, 'slow@example.test'), password: NEW_PASSWORD });
    expect(res.json().error).toBe('link_invalid');
  });

  test('without email, sign-up signs in at once and an invitation needs no confirmed address', async () => {
    const app = buildTestApp();
    const { headers } = await bootstrapTenant(app, { name: 'No Mail Co', slug: 'no-mail-co' });
    const config = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });
    expect(config.json().emailEnabled).toBe(false);
    const invite = await post(app, '/api/v1/invitations', { email: 'plain@example.test', role: 'member' }, headers);
    const res = await post(app, '/api/v1/auth/sign-up', { email: 'plain@example.test', name: 'Plain', password: TEST_PASSWORD });
    expect(res.statusCode).toBe(201);
    const session = AuthResponseSchema.parse(res.json()).session;
    expect((await post(app, '/api/v1/invitations/accept', { token: invite.json().acceptToken }, asUser(session))).statusCode).toBe(200);
  });

  test('changing the password needs the current one and ends every other session', async () => {
    const app = buildTestApp();
    const first = await signUpOpen(app, 'change@example.test');
    const second = AuthResponseSchema.parse(
      (await post(app, '/api/v1/auth/sign-in', { email: 'change@example.test', password: TEST_PASSWORD })).json()
    ).session;

    const wrong = await post(app, '/api/v1/auth/password', { current_password: 'not-it-at-all', new_password: NEW_PASSWORD }, asUser(first));
    expect(wrong.statusCode).toBe(401);

    const ok = await post(app, '/api/v1/auth/password', { current_password: TEST_PASSWORD, new_password: NEW_PASSWORD }, asUser(first));
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(first) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(second) })).statusCode).toBe(401);
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'change@example.test', password: NEW_PASSWORD })).statusCode).toBe(200);
  });

  test('sign out everywhere ends every session, this one included', async () => {
    const app = buildTestApp();
    const first = await signUpOpen(app, 'everywhere@example.test');
    const second = AuthResponseSchema.parse(
      (await post(app, '/api/v1/auth/sign-in', { email: 'everywhere@example.test', password: TEST_PASSWORD })).json()
    ).session;
    expect((await post(app, '/api/v1/auth/sign-out-all', {}, asUser(first))).statusCode).toBe(204);
    for (const s of [first, second]) {
      expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(s) })).statusCode).toBe(401);
    }
  });
});

describe('the operator\u2019s reset-password command', () => {
  useTestDb();

  test('prints a link that sets a new password once, and signs the account out everywhere', async () => {
    const app = buildTestApp();
    const session = await signUpOpen(app, 'locked-out@example.test');
    const link = await resetPasswordLink('Locked-Out@example.test', 'https://wiki.example/');
    expect(link).toMatch(/^https:\/\/wiki\.example\/reset-password\/lwe_/);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: asUser(session) })).statusCode).toBe(401);

    const token = link.split('/').at(-1)!;
    expect((await post(app, '/api/v1/auth/password-reset/confirm', { token, password: NEW_PASSWORD })).statusCode).toBe(200);
    expect((await post(app, '/api/v1/auth/password-reset/confirm', { token, password: NEW_PASSWORD })).statusCode).toBe(404);
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'locked-out@example.test', password: NEW_PASSWORD })).statusCode).toBe(200);
  });

  test('refuses an address no one can sign in with', async () => {
    await expect(resetPasswordLink('nobody@example.test', undefined)).rejects.toThrow(/no account/);
  });
});

/** An account made on a server without email (so it signs in at once). */
async function signUpOpenWithoutMail(email: string) {
  return signUpOpen(buildTestApp(), email);
}
