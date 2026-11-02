import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, sessions } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';
import { TtlCache } from '../cache.js';

export const SESSION_TOKEN_PREFIX = 'lws_';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A short cache cuts one session lookup per request in a burst. Revocation is
 * immediate in this process; another API process may serve a revoked token for
 * at most this window, so keep it small.
 */
const SESSION_CACHE_TTL_MS = 5_000;
const sessionCache = new TtlCache<{ userId: string; expiresAt: number }>({
  ttlMs: SESSION_CACHE_TTL_MS,
  maxEntries: 10_000,
});

/** Test isolation: a new database must not be served entries from the old one. */
export function clearSessionCache(): void {
  sessionCache.clear();
}

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
  const tokenHash = sha256Hex(token);
  const cached = sessionCache.get(tokenHash);
  if (cached) {
    if (cached.expiresAt > now.getTime()) return { userId: cached.userId };
    sessionCache.delete(tokenHash);
  }

  const [row] = await getDb()
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      )
    );
  if (!row) return null;
  sessionCache.set(tokenHash, { userId: row.userId, expiresAt: row.expiresAt.getTime() });
  return { userId: row.userId };
}

/** Revokes a session; idempotent. */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = sha256Hex(token);
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
  sessionCache.delete(tokenHash);
}
