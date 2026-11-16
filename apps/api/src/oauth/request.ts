import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { getDb, oauthClients } from '@kinote/db';
import { OAUTH_SCOPES, type OAuthAuthorizeParams } from '@kinote/contracts';

/**
 * Kinote's own address as the authorization server and MCP resource: PUBLIC_URL when it is set, otherwise the
 * address the request came to (behind nginx, its Host and, with TRUST_PROXY, X-Forwarded-Proto). No trailing slash.
 */
export function oauthBase(req: FastifyRequest, publicUrl: string | undefined): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  return `${req.protocol}://${req.host}`;
}

/** Where /mcp's 401 points clients that can sign in. */
export const protectedResourceUrl = (base: string) => `${base}/.well-known/oauth-protected-resource/mcp`;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Schemes that run, read or embed something instead of opening an app. */
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ws', 'wss', 'ftp', 'http']);

/**
 * A redirect address a public client may register (RFC 8252 and OAuth 2.1): https anywhere, http only to this
 * device (loopback), or an app's own scheme (`cursor://…`). Never a fragment or credentials.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  if (raw.length > 2000 || raw.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https') return true;
  if (scheme === 'http') return LOOPBACK.has(url.hostname);
  return !BLOCKED_SCHEMES.has(scheme) && /^[a-z][a-z0-9+.-]*$/.test(scheme);
}

/**
 * Whether `requested` is one of the client's registered redirect addresses. Exact, except that a loopback http
 * address may differ in port: a native app picks a free port each time (RFC 8252 section 7.3).
 */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== 'http:' || !LOOPBACK.has(req.hostname) || requested.includes('#')) return false;
  return registered.some((g) => {
    try {
      const reg = new URL(g);
      return reg.protocol === 'http:' && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
    } catch {
      return false;
    }
  });
}

/** The client's redirect address with `params` added (code or error, state, iss). */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An S256 challenge is the base64url SHA-256 of the verifier: always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export type AuthorizeCheck =
  /** The client or its redirect address can't be trusted: show the error, never redirect. */
  | { kind: 'invalid'; reason: string }
  /** Anything else wrong goes back to the client as an OAuth error. */
  | { kind: 'redirect'; to: string }
  | {
      kind: 'ok';
      client: { id: string; name: string };
      redirectUri: string;
      codeChallenge: string;
      scopes: string[];
      state: string | undefined;
    };

/**
 * Checks an authorization request (the query of /oauth/authorize) in the order OAuth requires: the client and its
 * redirect address first, since an error can only be sent back to an address the client registered.
 */
export async function checkAuthorizeRequest(p: OAuthAuthorizeParams, base: string): Promise<AuthorizeCheck> {
  if (!p.client_id || !UUID.test(p.client_id)) return { kind: 'invalid', reason: 'Unknown app.' };
  const [client] = await getDb().select().from(oauthClients).where(eq(oauthClients.id, p.client_id.toLowerCase()));
  if (!client) return { kind: 'invalid', reason: 'Unknown app.' };
  if (!p.redirect_uri || !redirectMatches(client.redirectUris, p.redirect_uri)) {
    return { kind: 'invalid', reason: 'The app asked to return to an address it never registered.' };
  }
  const redirectUri = p.redirect_uri;
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: 'redirect',
    to: redirectWith(redirectUri, { error, error_description: description, state: p.state, iss: base }),
  });

  if (p.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (p.code_challenge_method !== 'S256' || !p.code_challenge || !CHALLENGE.test(p.code_challenge)) {
    return fail('invalid_request', 'PKCE is required: code_challenge with code_challenge_method=S256.');
  }
  const asked = (p.scope ?? '').split(/\s+/).filter(Boolean);
  const known = new Set<string>(OAUTH_SCOPES);
  if (asked.some((s) => !known.has(s))) return fail('invalid_scope', `Scopes offered: ${OAUTH_SCOPES.join(' ')}.`);
  if (p.resource !== undefined) {
    const resource = p.resource.replace(/\/+$/, '');
    if (resource !== `${base}/mcp` && resource !== base) return fail('invalid_target', `The resource is ${base}/mcp.`);
  }
  return {
    kind: 'ok',
    client: { id: client.id, name: client.name },
    redirectUri,
    codeChallenge: p.code_challenge,
    scopes: asked.length > 0 ? [...new Set(asked)] : [...OAUTH_SCOPES],
    state: p.state,
  };
}
