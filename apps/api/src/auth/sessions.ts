import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { getDb, sessions } from '@kinote/db';
import { sha256Hex } from '@kinote/shared';
import { TtlCache } from '../cache.js';

export const SESSION_TOKEN_PREFIX = 'lws_';
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A session lasts 14 days from its last renewal: one in use is renewed once
 * fewer than SESSION_RENEW_BELOW_MS remain (at most one write a week), and
 * never past SESSION_MAX_AGE_MS after it began, so a stolen token can't be
 * kept alive for ever.
 */
export const SESSION_TTL_MS = 14 * DAY_MS;
export const SESSION_RENEW_BELOW_MS = 7 * DAY_MS;
export const SESSION_MAX_AGE_MS = 90 * DAY_MS;

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
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt, createdAt: sessions.createdAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now)
      )
    );
  if (!row) return null;
  let expiresAt = row.expiresAt;
  if (expiresAt.getTime() - now.getTime() < SESSION_RENEW_BELOW_MS) {
    const renewed = new Date(Math.min(now.getTime() + SESSION_TTL_MS, row.createdAt.getTime() + SESSION_MAX_AGE_MS));
    if (renewed > expiresAt) {
      await getDb()
        .update(sessions)
        .set({ expiresAt: renewed })
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
      expiresAt = renewed;
    }
  }
  sessionCache.set(tokenHash, { userId: row.userId, expiresAt: expiresAt.getTime() });
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

/**
 * Revokes every live session of a user, except `except` (the caller's own
 * token, e.g. on a password change). The cache is cleared whole: it holds at
 * most SESSION_CACHE_TTL_MS of answers, and another process's copy runs out
 * within that window.
 */
export async function revokeAllSessions(userId: string, o: { except?: string } = {}): Promise<number> {
  const keep = o.except ? sha256Hex(o.except) : null;
  const revoked = await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(keep ? [ne(sessions.tokenHash, keep)] : [])
      )
    )
    .returning({ id: sessions.id });
  sessionCache.clear();
  return revoked.length;
}
