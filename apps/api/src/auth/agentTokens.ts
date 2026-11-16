import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@kinote/shared';

/** Not `lws_` (session) or `lwsrc_` (source): the kinds of token must never be mistaken for each other. */
export const AGENT_TOKEN_PREFIX = 'lwagt_';
/** The refresh token of a browser sign-in. */
export const REFRESH_TOKEN_PREFIX = 'lwagr_';
/** A one-time authorization code of a browser sign-in. */
export const OAUTH_CODE_PREFIX = 'lwaco_';

type Minted = { token: string; hash: string; prefix: string };
type Parsed = { tenantId: string; hash: string } | null;

/**
 * `{kind}{tenant id without dashes}.{secret}`. The tenant id is not secret; it lets the api open that tenant's
 * transaction (so row level security stays on) before it looks the token up. Only `hash` is stored; `prefix` (the
 * first 8 characters of the secret) is what an admin sees to tell tokens apart.
 */
function mint(kind: string, tenantId: string): Minted {
  const secret = randomBytes(32).toString('base64url');
  const token = `${kind}${tenantId.toLowerCase().replaceAll('-', '')}.${secret}`;
  return { token, hash: sha256Hex(token), prefix: secret.slice(0, 8) };
}

function parser(kind: string): (raw: string) => Parsed {
  const regex = new RegExp(`^${kind}([0-9a-f]{32})\\.([A-Za-z0-9_-]{43})$`);
  return (raw) => {
    const match = regex.exec(raw);
    if (!match) return null;
    const h = match[1]!;
    const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    return { tenantId, hash: sha256Hex(raw) };
  };
}

/** A new token for an agent in a tenant: `lwagt_{tenant id without dashes}.{secret}`. */
export const mintAgentToken = (tenantId: string): Minted => mint(AGENT_TOKEN_PREFIX, tenantId);
/** The tenant id and stored hash of a token, or null when the string is not exactly an agent token. */
export const parseAgentToken = parser(AGENT_TOKEN_PREFIX);

export const mintRefreshToken = (tenantId: string): Minted => mint(REFRESH_TOKEN_PREFIX, tenantId);
export const parseRefreshToken = parser(REFRESH_TOKEN_PREFIX);

export const mintOAuthCode = (tenantId: string): Minted => mint(OAUTH_CODE_PREFIX, tenantId);
export const parseOAuthCode = parser(OAUTH_CODE_PREFIX);
