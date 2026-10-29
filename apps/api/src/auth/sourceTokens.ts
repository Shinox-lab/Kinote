import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@kinote/shared';

/** Not `lws_`: that is a session token, and the two kinds must never be mistaken for each other. */
export const SOURCE_TOKEN_PREFIX = 'lwsrc_';

const TOKEN_REGEX = /^lwsrc_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

/**
 * A new token for a tenant: `lwsrc_{tenant id without dashes}.{secret}`. The tenant id is
 * not secret; it lets the api open that tenant's transaction (so row level security stays
 * on) before it can look the token up. Only `hash` is stored; `prefix` (the first
 * characters of the secret) is what an admin sees to tell tokens apart.
 */
export function mintSourceToken(tenantId: string): { token: string; hash: string; prefix: string } {
  const secret = randomBytes(32).toString('base64url');
  const token = `${SOURCE_TOKEN_PREFIX}${tenantId.toLowerCase().replaceAll('-', '')}.${secret}`;
  return { token, hash: sha256Hex(token), prefix: secret.slice(0, 8) };
}

/** The tenant id and stored hash of a token, or null when the string is not exactly a source token. */
export function parseSourceToken(raw: string): { tenantId: string; hash: string } | null {
  const match = TOKEN_REGEX.exec(raw);
  if (!match) return null;
  const h = match[1]!;
  const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { tenantId, hash: sha256Hex(raw) };
}
