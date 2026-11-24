import { createHmac, timingSafeEqual } from 'node:crypto';

/** Lifetime of an agent's download or upload link: as a media link. */
export const AGENT_LINK_TTL_SECONDS = 15 * 60;

export type AgentLinkPurpose = 'agent-file' | 'agent-upload';

/**
 * What an agent's link grants: one file version, one page (live or one saved version) as Markdown, or one
 * staged upload. The agent and token it was issued to are re-checked on every request.
 */
export type AgentLinkClaims = { tenantId: string; agentId: string; tokenId: string; exp: number } & (
  | { kind: 'file'; versionId: string }
  | { kind: 'page'; documentId: string; versionId: string | null }
  | { kind: 'upload'; uploadId: string }
);
type Unsigned = AgentLinkClaims extends infer C ? (C extends AgentLinkClaims ? Omit<C, 'exp'> : never) : never;

// The purpose prefix keeps a token for one purpose (or a media token) from verifying as another under the same secret.
function hmac(purpose: AgentLinkPurpose, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${payload}`).digest('base64url');
}

/** `<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`, expiring AGENT_LINK_TTL_SECONDS after `now`. */
export function signAgentLink(
  purpose: AgentLinkPurpose,
  claims: Unsigned,
  secret: string,
  now: Date = new Date()
): { token: string; expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + AGENT_LINK_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp }), 'utf8').toString('base64url');
  return { token: `${payload}.${hmac(purpose, payload, secret)}`, expiresAt: new Date(exp * 1000) };
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The token's claims, or null when it is malformed, forged, for another purpose or expired. */
export function verifyAgentLink(
  purpose: AgentLinkPurpose,
  token: string,
  secret: string,
  now: Date = new Date()
): AgentLinkClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts as [string, string];
  const expected = Buffer.from(hmac(purpose, payload, secret), 'utf8');
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
  if (!str(c.tenantId) || !str(c.agentId) || !str(c.tokenId) || typeof c.exp !== 'number') return null;
  if (c.exp <= Math.floor(now.getTime() / 1000)) return null;
  const base = { tenantId: c.tenantId, agentId: c.agentId, tokenId: c.tokenId, exp: c.exp };
  if (c.kind === 'file' && purpose === 'agent-file' && str(c.versionId)) return { ...base, kind: 'file', versionId: c.versionId };
  if (c.kind === 'page' && purpose === 'agent-file' && str(c.documentId) && (c.versionId === null || str(c.versionId))) {
    return { ...base, kind: 'page', documentId: c.documentId, versionId: c.versionId };
  }
  if (c.kind === 'upload' && purpose === 'agent-upload' && str(c.uploadId)) return { ...base, kind: 'upload', uploadId: c.uploadId };
  return null;
}
