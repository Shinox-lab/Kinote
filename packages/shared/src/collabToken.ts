import { createHmac, timingSafeEqual } from 'node:crypto';

/** Lifetime of a collab token. Short on purpose: the role is re-checked on connect. */
export const COLLAB_TOKEN_TTL_SECONDS = 5 * 60;

export interface CollabClaims {
  tenantId: string;
  pageId: string;
  principalType: 'user' | 'agent';
  principalId: string;
  access: 'read' | 'write';
  /** Expiry as seconds since the Unix epoch. */
  exp: number;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** `<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`, expiring 5 minutes after `now`. */
export function signCollabToken(
  c: Omit<CollabClaims, 'exp'>,
  secret: string,
  now: Date = new Date()
): string {
  const claims: CollabClaims = {
    tenantId: c.tenantId,
    pageId: c.pageId,
    principalType: c.principalType,
    principalId: c.principalId,
    access: c.access,
    exp: Math.floor(now.getTime() / 1000) + COLLAB_TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

/** The token's claims, or null when it is malformed, forged or expired. */
export function verifyCollabToken(
  token: string,
  secret: string,
  now: Date = new Date()
): CollabClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature) return null;

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
  if (
    typeof c.tenantId !== 'string' ||
    typeof c.pageId !== 'string' ||
    typeof c.principalId !== 'string' ||
    (c.principalType !== 'user' && c.principalType !== 'agent') ||
    (c.access !== 'read' && c.access !== 'write') ||
    typeof c.exp !== 'number' ||
    !Number.isFinite(c.exp)
  ) {
    return null;
  }
  if (c.exp * 1000 <= now.getTime()) return null;

  return {
    tenantId: c.tenantId,
    pageId: c.pageId,
    principalType: c.principalType,
    principalId: c.principalId,
    access: c.access,
    exp: c.exp,
  };
}

/** Hocuspocus document name for a page: `{tenantId}:{pageId}`. */
export function documentName(tenantId: string, pageId: string): string {
  return `${tenantId}:${pageId}`;
}

/**
 * Inverse of `documentName`; null unless the name is exactly the canonical
 * form of two UUIDs (lower-case). Hocuspocus keys its in-memory documents by
 * the raw name, so accepting any other spelling of the same ids would open a
 * second Y.Doc for one page and let the two overwrite each other on store.
 */
export function parseDocumentName(name: string): { tenantId: string; pageId: string } | null {
  if (typeof name !== 'string') return null;
  const parts = name.split(':');
  if (parts.length !== 2) return null;
  const [tenantId, pageId] = parts;
  if (!UUID_REGEX.test(tenantId) || !UUID_REGEX.test(pageId)) return null;
  if (documentName(tenantId, pageId) !== name || name !== name.toLowerCase()) return null;
  return { tenantId, pageId };
}

/**
 * The collab token signing secret from `COLLAB_TOKEN_SECRET` (at least 32
 * characters). The only place the variable is read until the config loader
 * exists; throws when it is unset or too short so a server never signs or
 * verifies with a weak key.
 */
export function getCollabTokenSecret(): string {
  const secret = process.env.COLLAB_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('COLLAB_TOKEN_SECRET must be set to at least 32 characters.');
  }
  return secret;
}
