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

  test('the verification link takes the password, confirms the address, signs in, and works once', async () => {
    const { app, mailer } = withMail();
    await post(app, '/api/v1/auth/sign-up', { email: 'v@example.test', name: 'V', password: TEST_PASSWORD });
    const token = tokenFrom(mailer, 'v@example.test');
    expect(mailer.lastLink('v@example.test')).toBe(`https://wiki.example/verify-email/${token}`);

    // A wrong password leaves the link unused.
    const wrong = await post(app, '/api/v1/auth/verify', { token, password: 'not-the-password' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('invalid_credentials');
    const [before] = await getDb().select().from(users).where(eq(users.email, 'v@example.test'));
    expect(before?.emailVerifiedAt).toBeNull();

    const res = await post(app, '/api/v1/auth/verify', { token, password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(AuthResponseSchema.parse(res.json()).user.email).toBe('v@example.test');
    const [user] = await getDb().select().from(users).where(eq(users.email, 'v@example.test'));
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);

    const again = await post(app, '/api/v1/auth/verify', { token, password: TEST_PASSWORD });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe('link_invalid');
  });

  test('an unconfirmed account cannot sign in; the right password mails a fresh link', async () => {
    const { app, mailer } = withMail();
    await post(app, '/api/v1/auth/sign-up', { email: 'early@example.test', name: 'Early', password: TEST_PASSWORD });
    const first = tokenFrom(mailer, 'early@example.test');

    const wrong = await post(app, '/api/v1/auth/sign-in', { email: 'early@example.test', password: 'not-the-password' });
    expect(wrong.json().error).toBe('invalid_credentials');
    const sentBefore = mailer.sent.length;

    const res = await post(app, '/api/v1/auth/sign-in', { email: 'early@example.test', password: TEST_PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('email_unverified');
    expect(res.json().session).toBeUndefined();
    expect(mailer.sent.length).toBe(sentBefore + 1);
    const fresh = tokenFrom(mailer, 'early@example.test');
    expect(fresh).not.toBe(first);

    expect((await post(app, '/api/v1/auth/verify', { token: fresh, password: TEST_PASSWORD })).statusCode).toBe(200);
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'early@example.test', password: TEST_PASSWORD })).statusCode).toBe(200);
  });

  test('someone who registers another person\'s address first never gets in, and the owner takes it over', async () => {
    const { app, mailer } = withMail();
    // The admin's account comes from a server without email (sign-up there signs in at once).
    const { headers } = await bootstrapTenant(buildTestApp(), { name: 'Mail Co', slug: 'mail-co' });
    const invite = await post(app, '/api/v1/invitations', { email: 'squat@example.test', role: 'admin' }, headers);
    const acceptToken = invite.json().acceptToken as string;

    // The squatter registers the invited address with a password they know, and can't sign in.
    await post(app, '/api/v1/auth/sign-up', { email: 'squat@example.test', name: 'Squatter', password: TEST_PASSWORD });
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'squat@example.test', password: TEST_PASSWORD })).statusCode).toBe(403);

    // The real owner of the inbox can't confirm it without the squatter's password...
    const link = tokenFrom(mailer, 'squat@example.test');
    expect((await post(app, '/api/v1/auth/verify', { token: link, password: 'owner-guess-123' })).statusCode).toBe(401);

    // ...so they set their own password instead, which confirms the address.
    await post(app, '/api/v1/auth/password-reset/request', { email: 'squat@example.test' });
    const reset = await post(app, '/api/v1/auth/password-reset/confirm', {
      token: tokenFrom(mailer, 'squat@example.test'),
      password: NEW_PASSWORD,
    });
    expect(reset.statusCode).toBe(200);
    const owner = AuthResponseSchema.parse(reset.json()).session;

    // The squatter's password and the old link are dead; the owner takes the invitation.
    expect((await post(app, '/api/v1/auth/sign-in', { email: 'squat@example.test', password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await post(app, '/api/v1/auth/verify', { token: link, password: TEST_PASSWORD })).statusCode).toBe(401);
    expect((await post(app, '/api/v1/invitations/accept', { token: acceptToken }, asUser(owner))).statusCode).toBe(200);
  });

  test('a session from before email was turned on cannot take an invitation until the address is confirmed', async () => {
    const { app, mailer } = withMail();
    const { headers } = await bootstrapTenant(buildTestApp(), { name: 'Late Mail Co', slug: 'late-mail-co' });
    const invite = await post(app, '/api/v1/invitations', { email: 'legacy@example.test', role: 'member' }, headers);
    const acceptToken = invite.json().acceptToken as string;
    const session = await signUpOpenWithoutMail('legacy@example.test');

    const accept = await post(app, '/api/v1/invitations/accept', { token: acceptToken }, asUser(session));
    expect(accept.statusCode).toBe(403);
    expect(accept.json().error).toBe('email_unverified');

    expect((await post(app, '/api/v1/auth/verify/resend', {}, asUser(session))).statusCode).toBe(204);
    await post(app, '/api/v1/auth/verify', { token: tokenFrom(mailer, 'legacy@example.test'), password: TEST_PASSWORD });
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
