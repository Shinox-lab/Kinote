import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { getDb, hitLimit, rowsOf, users } from '@kinote/db';
import {
  AppError,
  SignInRequestSchema,
  SignUpRequestSchema,
  TenantRoleSchema,
  AuthResponseSchema,
  AuthConfigSchema,
  ChangePasswordRequestSchema,
  EmailLinkRequestSchema,
  InvitationPreviewSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  SignUpPendingSchema,
  MeResponseSchema,
  type SignUpMode,
  type AuthResponse,
  type AuthUser,
  type MeResponse,
} from '@kinote/contracts';
import { getDummyHash, hashPassword, isUsableHash, verifyPassword } from '../auth/password.js';
import { createSession, revokeAllSessions, revokeSession } from '../auth/sessions.js';
import { consumeEmailToken, createEmailToken } from '../auth/emailTokens.js';
import type { Mailer } from '../mail.js';
import { assertSignInAllowed, recordFailedSignIn, recordSuccessfulSignIn } from '../auth/signInThrottle.js';
import type { AuthSession } from '../auth/actor.js';
import { parseReply } from '../reply.js';
import { previewInvitation, signUpWithInvitation } from './foundations.js';

export interface AuthRateLimit {
  max: number;
  timeWindow: string;
}

function toAuthUser(user: { id: string; email: string; name: string }): AuthUser {
  return { id: user.id, email: user.email, name: user.name };
}

async function authResponse(user: AuthUser, joined?: AuthResponse['joined']): Promise<AuthResponse> {
  const session = await createSession(user.id);
  return parseReply(AuthResponseSchema, {
    user,
    session: { token: session.token, expiresAt: session.expiresAt.toISOString() },
    ...(joined ? { joined } : {}),
  });
}

function sessionOf(req: FastifyRequest): AuthSession {
  if (!req.authSession) throw new AppError('unauthenticated');
  return req.authSession;
}

/** SIGNUP_MODE as configured; `auto` is resolved per request by resolveSignUpMode. */
export type SignUpModeSetting = 'auto' | SignUpMode;

/**
 * The sign-up mode in force: `auto` is `open` until the first real account
 * exists (demo people, who can never sign in, don't count) and `invite` after.
 */
export async function resolveSignUpMode(setting: SignUpModeSetting): Promise<SignUpMode> {
  if (setting !== 'auto') return setting;
  const rows = rowsOf<{ exists: boolean }>(
    await getDb().execute(sql`SELECT EXISTS (SELECT 1 FROM users WHERE password_hash <> '!') AS exists`)
  );
  return rows[0]?.exists ? 'invite' : 'open';
}

/** Sign-up, sign-in, sign-out and /me. Must be registered after @fastify/rate-limit. */
export async function authRoutes(
  app: FastifyInstance,
  opts: { authRateLimit: AuthRateLimit; signUpMode: SignUpModeSetting; mailer?: Mailer }
): Promise<void> {
  const { mailer } = opts;
  const rateLimit = { max: opts.authRateLimit.max, timeWindow: opts.authRateLimit.timeWindow };
  // Compute the dummy hash before serving, so even the first unknown-email
  // sign-in costs exactly one verification.
  await getDummyHash();

  /** What the sign-up page offers: open, by invitation, or nothing. */
  app.get('/api/v1/auth/config', { config: { auth: 'public' } }, async (_req, reply) => {
    return reply.send(
      parseReply(AuthConfigSchema, { signUpMode: await resolveSignUpMode(opts.signUpMode), emailEnabled: mailer !== undefined })
    );
  });

  /** The invited email and workspace behind an invitation link (counted with sign-up attempts). */
  app.post('/api/v1/auth/invitation', { config: { auth: 'public', rateLimit } }, async (req, reply) => {
    return reply.send(parseReply(InvitationPreviewSchema, await previewInvitation(req.body)));
  });

  app.post(
    '/api/v1/auth/sign-up',
    { config: { auth: 'public', rateLimit } },
    async (req, reply) => {
      const parsed = SignUpRequestSchema.parse(req.body);
      const mode = await resolveSignUpMode(opts.signUpMode);
      if (mode === 'closed') throw new AppError('signup_closed');

      if (parsed.invitation_token !== undefined) {
        // An invitation decides the email and the workspace; allowed in open and invite mode.
        const passwordHash = await hashPassword(parsed.password);
        const { user, joined } = await signUpWithInvitation({
          token: parsed.invitation_token,
          name: parsed.name,
          passwordHash,
        });
        return reply.status(201).send(await authResponse(toAuthUser(user), joined));
      }

      if (mode === 'invite') throw new AppError('signup_invite_only');
      const email = parsed.email!;
      const passwordHash = await hashPassword(parsed.password);

      if (mailer) {
        // With email, the answer never says whether the address already has an
        // account: both get 202, and the email says what to do next. The new
        // account is unverified (no invitations) until its link is opened.
        const [existing] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email));
        if (existing) {
          await sendMail(req, mailer, {
            to: email,
            subject: 'Someone tried to create a Kinote account with your email',
            text:
              `Someone, maybe you, tried to create a Kinote account with ${email}, which already has one.\n\n` +
              `Sign in at ${mailer.publicUrl}/sign-in, or set a new password at ${mailer.publicUrl}/forgot-password.\n\n` +
              `If it wasn't you, you can ignore this email.`,
          });
        } else {
          const [user] = await getDb().insert(users).values({ email, name: parsed.name, passwordHash }).returning();
          await sendVerification(req, mailer, user!);
        }
        return reply.status(202).send(parseReply(SignUpPendingSchema, { checkEmail: true }));
      }

      // Without email nothing can be verified. A duplicate email violates
      // users_email_unique -> 409 email_taken (mapDbError).
      const [user] = await getDb().insert(users).values({ email, name: parsed.name, passwordHash }).returning();
      return reply.status(201).send(await authResponse(toAuthUser(user)));
    }
  );

  app.post(
    '/api/v1/auth/sign-in',
    { config: { auth: 'public', rateLimit } },
    async (req, reply) => {
      const parsed = SignInRequestSchema.parse(req.body);
      await assertSignInAllowed(parsed.email, reply);
      const [user] = await getDb().select().from(users).where(eq(users.email, parsed.email));
      // Always run one argon2 verification so unknown emails, placeholder
      // accounts and wrong passwords cost the same and answer identically.
      const usable = user !== undefined && isUsableHash(user.passwordHash);
      const ok = await verifyPassword(
        parsed.password,
        usable ? user.passwordHash : await getDummyHash()
      );
      if (!usable || !ok) {
        await recordFailedSignIn(parsed.email);
        throw new AppError('invalid_credentials');
      }
      await recordSuccessfulSignIn(parsed.email);
      return reply.status(200).send(await authResponse(toAuthUser(user)));
    }
  );

  app.post('/api/v1/auth/sign-out', { config: { auth: 'session' } }, async (req, reply) => {
    await revokeSession(sessionOf(req).token);
    return reply.status(204).send();
  });

  /** Opens a verification link: the address is the person's, and they are signed in. */
  app.post('/api/v1/auth/verify', { config: { auth: 'public', rateLimit } }, async (req, reply) => {
    const { token } = EmailLinkRequestSchema.parse(req.body);
    const userId = await consumeEmailToken(token, 'verify');
    if (!userId) throw new AppError('link_invalid');
    const [user] = await getDb()
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new AppError('link_invalid');
    return reply.send(await authResponse(toAuthUser(user)));
  });

  /** Sends the signed-in person a new verification link (a few an hour). */
  app.post('/api/v1/auth/verify/resend', { config: { auth: 'session' } }, async (req, reply) => {
    const { userId } = sessionOf(req);
    if (!mailer) return reply.status(204).send();
    const [user] = await getDb().select().from(users).where(eq(users.id, userId));
    if (!user || user.emailVerifiedAt) return reply.status(204).send();
    const { allowed } = await hitLimit(`verify-resend:${userId}`, 3, 60 * 60 * 1000);
    if (!allowed) throw new AppError('rate_limited');
    await sendVerification(req, mailer, user);
    return reply.status(204).send();
  });

  /**
   * "Forgot your password?": always 202, whether or not the address has an
   * account; only an existing account gets the email (a few an hour per address).
   */
  app.post('/api/v1/auth/password-reset/request', { config: { auth: 'public', rateLimit } }, async (req, reply) => {
    const { email } = PasswordResetRequestSchema.parse(req.body);
    if (mailer) {
      const [user] = await getDb().select().from(users).where(eq(users.email, email));
      const { allowed } = await hitLimit(`reset-request:${email}`, 3, 60 * 60 * 1000);
      if (user && isUsableHash(user.passwordHash) && allowed) {
        const token = await createEmailToken(user.id, 'reset');
        await sendMail(req, mailer, {
          to: user.email,
          subject: 'Set a new Kinote password',
          text:
            `Open this link within an hour to set a new password for ${user.email}:\n\n` +
            `${mailer.publicUrl}/reset-password/${token}\n\n` +
            `Setting it signs you out everywhere else. If you didn't ask for this, you can ignore this email.`,
        });
      }
    }
    return reply.status(202).send();
  });

  /**
   * Sets a new password from a reset link (an email link or the operator's
   * CLI). Opening it proves the address too, so the email counts as verified.
   * Every existing session ends; the answer signs the person in afresh.
   */
  app.post('/api/v1/auth/password-reset/confirm', { config: { auth: 'public', rateLimit } }, async (req, reply) => {
    const parsed = PasswordResetConfirmSchema.parse(req.body);
    const passwordHash = await hashPassword(parsed.password);
    const userId = await consumeEmailToken(parsed.token, 'reset');
    if (!userId) throw new AppError('link_invalid');
    const [user] = await getDb()
      .update(users)
      .set({ passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new AppError('link_invalid');
    await revokeAllSessions(userId);
    await recordSuccessfulSignIn(user.email);
    return reply.send(await authResponse(toAuthUser(user)));
  });

  /** Changes the signed-in person's password; every other session of theirs ends. */
  app.post('/api/v1/auth/password', { config: { auth: 'session', rateLimit } }, async (req, reply) => {
    const session = sessionOf(req);
    const parsed = ChangePasswordRequestSchema.parse(req.body);
    const [user] = await getDb().select().from(users).where(eq(users.id, session.userId));
    if (!user || !isUsableHash(user.passwordHash) || !(await verifyPassword(parsed.current_password, user.passwordHash))) {
      throw new AppError('invalid_credentials');
    }
    await getDb()
      .update(users)
      .set({ passwordHash: await hashPassword(parsed.new_password) })
      .where(eq(users.id, user.id));
    await revokeAllSessions(user.id, { except: session.token });
    return reply.status(204).send();
  });

  /** Ends every session of the signed-in person, this one included. */
  app.post('/api/v1/auth/sign-out-all', { config: { auth: 'session' } }, async (req, reply) => {
    await revokeAllSessions(sessionOf(req).userId);
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
    return reply.send(parseReply(MeResponseSchema, body));
  });
}

/** Sends a mail; a failure is logged and not shown, so the answer never depends on the mail server. */
async function sendMail(req: FastifyRequest, mailer: Mailer, mail: Parameters<Mailer['send']>[0]): Promise<void> {
  try {
    await mailer.send(mail);
  } catch (err) {
    req.log.error({ err }, 'sending mail failed');
  }
}

async function sendVerification(req: FastifyRequest, mailer: Mailer, user: { id: string; email: string }): Promise<void> {
  const token = await createEmailToken(user.id, 'verify');
  await sendMail(req, mailer, {
    to: user.email,
    subject: 'Confirm your email for Kinote',
    text:
      `Open this link within a day to confirm ${user.email} and sign in to Kinote:\n\n` +
      `${mailer.publicUrl}/verify-email/${token}\n\n` +
      `If you didn't create an account, you can ignore this email.`,
  });
}
