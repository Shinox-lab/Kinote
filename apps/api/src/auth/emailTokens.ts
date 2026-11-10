import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { emailTokens, getDb } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';

/** `setup`: a new instance's first owner sets their password (POST /internal/v1/bootstrap). */
export type EmailTokenPurpose = 'verify' | 'reset' | 'setup';

/** How long each kind of link works. */
export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  setup: 72 * 60 * 60 * 1000,
};

const PREFIX = 'lwe_';

/** A new one-time token for `userId`; only its SHA-256 is stored. */
export async function createEmailToken(userId: string, purpose: EmailTokenPurpose, now = new Date()): Promise<string> {
  const token = PREFIX + randomBytes(32).toString('base64url');
  await getDb()
    .insert(emailTokens)
    .values({
      tokenHash: sha256Hex(token),
      userId,
      purpose,
      expiresAt: new Date(now.getTime() + EMAIL_TOKEN_TTL_MS[purpose]),
    });
  return token;
}

/**
 * The user a token belongs to, without using it up: null for a token that is
 * unknown, of another purpose, expired or already used.
 */
export async function peekEmailToken(token: string, purpose: EmailTokenPurpose, now = new Date()): Promise<string | null> {
  if (!token.startsWith(PREFIX)) return null;
  const [row] = await getDb()
    .select({ userId: emailTokens.userId })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.tokenHash, sha256Hex(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now)
      )
    );
  return row?.userId ?? null;
}

/**
 * Uses up a token: the user it belongs to, or null for a token that is unknown,
 * of another purpose, expired or already used. Atomic, so a token works once
 * even when two requests race with it.
 */
export async function consumeEmailToken(token: string, purpose: EmailTokenPurpose, now = new Date()): Promise<string | null> {
  if (!token.startsWith(PREFIX)) return null;
  const [row] = await getDb()
    .update(emailTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailTokens.tokenHash, sha256Hex(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, now)
      )
    )
    .returning({ userId: emailTokens.userId });
  return row?.userId ?? null;
}
