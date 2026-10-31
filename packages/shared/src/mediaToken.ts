import { createHmac, timingSafeEqual } from 'node:crypto';

/** Lifetime of a media link. Long enough to watch a film without a refresh, short enough that a leaked link soon dies. */
export const MEDIA_TOKEN_TTL_SECONDS = 15 * 60;

export interface MediaClaims {
  tenantId: string;
  versionId: string;
  /** Expiry as seconds since the Unix epoch. */
  exp: number;
}

// A media element cannot send the Authorization header, so the link itself carries a signed,
// short-lived grant for one file version. It is minted only after the viewer's access was checked.
// The `media` prefix keeps a token for one purpose from verifying as another under the same secret.
function hmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`media:${payload}`).digest('base64url');
}

/** `<base64url(JSON claims)>.<base64url(HMAC-SHA256)>` for one version, expiring MEDIA_TOKEN_TTL_SECONDS after `now`. */
export function signMediaToken(
  c: Omit<MediaClaims, 'exp'>,
  secret: string,
  now: Date = new Date()
): { token: string; expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + MEDIA_TOKEN_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ tenantId: c.tenantId, versionId: c.versionId, exp }), 'utf8').toString('base64url');
  return { token: `${payload}.${hmac(payload, secret)}`, expiresAt: new Date(exp * 1000) };
}

/** The token's claims, or null when it is malformed, forged or expired. */
export function verifyMediaToken(token: string, secret: string, now: Date = new Date()): MediaClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts as [string, string];
  const expected = Buffer.from(hmac(payload, secret), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.tenantId !== 'string' || typeof c.versionId !== 'string' || typeof c.exp !== 'number') return null;
  if (c.exp <= Math.floor(now.getTime() / 1000)) return null;
  return { tenantId: c.tenantId, versionId: c.versionId, exp: c.exp };
}
