import { describe, expect, test } from 'vitest';
import { AuthResponseSchema } from '@kinote/contracts';
import { COMMON_PASSWORDS } from '../src/auth/commonPasswords.js';
import { assertPasswordAllowed } from '../src/auth/password.js';
import { resetPasswordLink } from '../src/cli/resetPassword.js';
import { TEST_PASSWORD, asUser, bootstrapTenant, buildTestApp, signUp, useTestDb } from './support/testkit.js';

const COMMON = 'qwertyuiop';

const post = (app: ReturnType<typeof buildTestApp>, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as any, headers });

describe('the bundled list', () => {
  test('holds only passwords the length minimum lets through, lower-cased and once each', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(2000);
    expect(COMMON_PASSWORDS.every((p) => p.length >= 10 && p === p.toLowerCase())).toBe(true);
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
    expect(COMMON_PASSWORDS).toContain(COMMON);
  });

  test('refuses common passwords in any case and the account email, and allows the rest', () => {
    for (const pw of [COMMON, 'QwErTyUiOp', '1234567890']) {
      expect(() => assertPasswordAllowed(pw)).toThrow(expect.objectContaining({ code: 'password_too_common' }));
    }
    expect(() => assertPasswordAllowed('Jane.Doe@Example.test', 'jane.doe@example.test')).toThrow();
    expect(() => assertPasswordAllowed('jane.doe.smith', 'jane.doe.smith@example.test')).toThrow();
    expect(() => assertPasswordAllowed(TEST_PASSWORD, 'jane.doe@example.test')).not.toThrow();
    expect(() => assertPasswordAllowed('qwertyuiop-but-longer')).not.toThrow();
  });
});

describe('every way to set a password refuses a common one', () => {
  useTestDb();

  test('sign-up', async () => {
    const app = buildTestApp();
    const res = await post(app, '/api/v1/auth/sign-up', { email: 'common@example.test', name: 'C', password: COMMON });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('password_too_common');
    expect((await post(app, '/api/v1/auth/sign-up', { email: 'common@example.test', name: 'C', password: TEST_PASSWORD })).statusCode).toBe(201);
  });

  test('sign-up from an invitation, which keeps working after a refusal', async () => {
    const app = buildTestApp();
    const { headers } = await bootstrapTenant(app, { name: 'Pw Co', slug: 'pw-co' });
    const invite = await post(app, '/api/v1/invitations', { email: 'invited.person@example.test', role: 'member' }, headers);
    const token = invite.json().acceptToken as string;

    for (const password of [COMMON, 'invited.person']) {
      const refused = await post(app, '/api/v1/auth/sign-up', { invitation_token: token, name: 'I', password });
      expect(refused.json().error).toBe('password_too_common');
    }
    expect((await post(app, '/api/v1/auth/sign-up', { invitation_token: token, name: 'I', password: TEST_PASSWORD })).statusCode).toBe(201);
  });

  test('a password reset, whose link keeps working after a refusal', async () => {
    const app = buildTestApp();
    await signUp(app, 'resetter@example.test');
    const token = (await resetPasswordLink('resetter@example.test', 'https://wiki.example')).split('/').at(-1)!;

    const refused = await post(app, '/api/v1/auth/password-reset/confirm', { token, password: COMMON });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('password_too_common');
    expect((await post(app, '/api/v1/auth/password-reset/confirm', { token, password: 'a-fresh-long-password' })).statusCode).toBe(200);
  });

  test('a password change, which leaves the old password in place', async () => {
    const app = buildTestApp();
    const session = await signUp(app, 'changer@example.test');
    const refused = await post(app, '/api/v1/auth/password', { current_password: TEST_PASSWORD, new_password: COMMON }, asUser(session));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('password_too_common');
    const signIn = await post(app, '/api/v1/auth/sign-in', { email: 'changer@example.test', password: TEST_PASSWORD });
    expect(AuthResponseSchema.parse(signIn.json()).user.email).toBe('changer@example.test');
  });
});
