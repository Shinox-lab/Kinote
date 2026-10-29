import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, sessions } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';

export const SESSION_TOKEN_PREFIX = 'lws_';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Issues a new session for a user. The token (`lws_` + 32 random bytes,
 * base64url) is returned once and only its SHA-256 is stored.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = SESSION_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getDb().insert(sessions).values({ userId, tokenHash: sha256Hex(token), expiresAt });
  return { token, expiresAt };
}

/** Resolves a bearer token to its user; null when unknown, revoked or expired. */
export async function resolveSession(
  token: string,
  now: Date = new Date()
): Promise<{ userId: string } | null> {
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const [row] = await getDb()
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, sha256Hex(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      )
    );
  return row ? { userId: row.userId } : null;
}

/** Revokes a session; idempotent. */
export async function revokeSession(token: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)));
}
