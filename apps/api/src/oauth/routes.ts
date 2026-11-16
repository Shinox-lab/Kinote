import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  agentTokens,
  getDb,
  memberships,
  oauthClients,
  oauthCodes,
  rowsOf,
  spaceGrants,
  tenants,
  withTenantTx,
  writeAuditEvent,
  type DbTransaction,
} from '@kinote/db';
import {
  AppError,
  DEFAULT_AGENT_TOKEN_DAYS,
  OAUTH_ACCESS_TOKEN_SECONDS,
  OAUTH_SCOPES,
  OAuthAuthorizeCheckSchema,
  OAuthAuthorizeParamsSchema,
  OAuthDecisionResponseSchema,
  OAuthDecisionSchema,
  type OAuthAuthorizeCheck,
} from '@kinote/contracts';
import type { Actor } from '@kinote/core';
import { mintAgentToken, mintOAuthCode, mintRefreshToken, parseAgentToken, parseOAuthCode, parseRefreshToken } from '../auth/agentTokens.js';
import { actorForUser } from '../auth/actor.js';
import { namedSpaces } from '../mcp/refs.js';
import { parseReply } from '../reply.js';
import { assertNotSuspended } from '../usageLimits.js';
import { checkAuthorizeRequest, isAllowedRedirectUri, oauthBase, redirectWith, s256 } from './request.js';

const CODE_TTL_MS = 10 * 60_000;
const REFRESH_TTL_MS = DEFAULT_AGENT_TOKEN_DAYS * 86_400_000;
const DEFAULT_CLIENT_NAME = 'MCP client';
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Browsers may call the public OAuth endpoints from any origin: they carry no cookies, only what the body holds. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
  'access-control-max-age': '86400',
};

class OAuthError extends Error {
  constructor(
    readonly code: string,
    description: string,
    readonly status = 400
  ) {
    super(description);
  }
}
const grantError = (description = 'The code or refresh token is invalid, expired, revoked or was issued to another client.') =>
  new OAuthError('invalid_grant', description);

function sendOAuthError(reply: FastifyReply, err: OAuthError) {
  return reply
    .status(err.status)
    .headers({ ...CORS, 'cache-control': 'no-store' })
    .send({ error: err.code, error_description: err.message });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const RegisterSchema = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(10),
    client_name: z.string().max(200).optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
  })
  .passthrough();

interface Tokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** A fresh access and refresh token pair for a tenant: the values to return and the columns to store. */
function mintPair(tenantId: string, now: Date) {
  const access = mintAgentToken(tenantId);
  const refresh = mintRefreshToken(tenantId);
  return {
    access,
    refresh,
    columns: {
      tokenHash: access.hash,
      tokenPrefix: access.prefix,
      expiresAt: new Date(now.getTime() + OAUTH_ACCESS_TOKEN_SECONDS * 1000),
      refreshTokenHash: refresh.hash,
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
    },
  };
}

const tokensOf = (pair: ReturnType<typeof mintPair>, scopes: string[]): Tokens => ({
  access_token: pair.access.token,
  token_type: 'Bearer',
  expires_in: OAUTH_ACCESS_TOKEN_SECONDS,
  refresh_token: pair.refresh.token,
  scope: scopes.join(' '),
});

/** The member's role in the tenant now, or null when they left or the workspace is deleted. */
async function currentRole(tx: DbTransaction, tenantId: string, userId: string): Promise<NonNullable<Actor['tenantRole']> | null> {
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId), isNull(tenants.deletedAt)));
  return row?.role ?? null;
}

/**
 * authorization_code: checks the code (unused, unexpired, same client, same redirect, PKCE) and only then creates
 * the agent, owned by the member who approved, with viewer grants on the spaces they picked that they can still
 * read, and its token. A code presented twice revokes the token it gave (OAuth 2.1, section 4.1.3).
 */
async function exchangeCode(body: Record<string, unknown>): Promise<Tokens> {
  const code = str(body.code);
  const redirectUri = str(body.redirect_uri);
  const clientId = str(body.client_id);
  const verifier = str(body.code_verifier);
  if (!code || !redirectUri || !clientId || !verifier) {
    throw new OAuthError('invalid_request', 'code, redirect_uri, client_id and code_verifier are required.');
  }
  if (!VERIFIER.test(verifier)) throw new OAuthError('invalid_request', 'code_verifier must be 43 to 128 unreserved characters.');
  const parsed = parseOAuthCode(code);
  if (!parsed) throw grantError();
  const now = new Date();

  const result = await withTenantTx(parsed.tenantId, async (tx): Promise<Tokens | OAuthError> => {
    const [row] = await tx
      .select()
      .from(oauthCodes)
      .where(and(eq(oauthCodes.tenantId, parsed.tenantId), eq(oauthCodes.codeHash, parsed.hash)))
      .for('update');
    if (!row) return grantError();
    if (row.usedAt) {
      if (row.tokenId) {
        await tx
          .update(agentTokens)
          .set({ revokedAt: now })
          .where(and(eq(agentTokens.tenantId, row.tenantId), eq(agentTokens.id, row.tokenId), isNull(agentTokens.revokedAt)));
      }
      return grantError('This code was already used; the token it gave is revoked.');
    }
    if (row.expiresAt <= now || row.clientId !== clientId.toLowerCase() || row.redirectUri !== redirectUri || s256(verifier) !== row.codeChallenge) {
      return grantError();
    }
    await tx.update(oauthCodes).set({ usedAt: now }).where(eq(oauthCodes.id, row.id));

    const role = await currentRole(tx, row.tenantId, row.userId);
    if (!role) return grantError('The person who approved this sign-in is no longer a member.');
    const member: Actor = { tenantId: row.tenantId, principalType: 'user', principalId: row.userId, tenantRole: role };
    const readable = new Set((await namedSpaces(tx, member)).map((s) => s.id));
    const spaceIds = row.spaceIds.filter((id) => readable.has(id));
    if (spaceIds.length === 0) return grantError('None of the chosen spaces can be read any more.');
    const [client] = await tx.select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.id, row.clientId));
    const clientName = client?.name ?? DEFAULT_CLIENT_NAME;

    const [agent] = await tx
      .insert(agents)
      .values({ tenantId: row.tenantId, name: row.agentName, kind: 'external', createdBy: row.userId })
      .returning();
    const audit = (type: Parameters<typeof writeAuditEvent>[1]['type'], subjectType: string, subjectId: string, payload: Record<string, unknown>) =>
      writeAuditEvent(tx, { tenantId: row.tenantId, type, actorType: 'user', actorId: row.userId, subjectType, subjectId, payload });
    await audit('agent.created', 'agent', agent!.id, { name: agent!.name, dailyAiLimit: null, via: 'sign-in', client: clientName });
    // An agent that may file captures or edit needs editor access where it writes (still never more than its owner can).
    const grantRole = row.scopes.includes('capture') || row.scopes.includes('edit') ? ('editor' as const) : ('viewer' as const);
    for (const spaceId of spaceIds) {
      await tx.insert(spaceGrants).values({ tenantId: row.tenantId, spaceId, principalType: 'agent', principalId: agent!.id, role: grantRole });
      await audit('space.grant_changed', 'space', spaceId, { principal_type: 'agent', principal_id: agent!.id, role: grantRole });
    }
    const pair = mintPair(row.tenantId, now);
    const [token] = await tx
      .insert(agentTokens)
      .values({
        tenantId: row.tenantId,
        agentId: agent!.id,
        scopes: row.scopes,
        name: clientName.slice(0, 80),
        createdBy: row.userId,
        oauthClientId: row.clientId,
        ...pair.columns,
      })
      .returning();
    await tx.update(oauthCodes).set({ tokenId: token!.id }).where(eq(oauthCodes.id, row.id));
    await audit('agent.token_issued', 'agent', agent!.id, { tokenId: token!.id, name: token!.name, scopes: token!.scopes, via: 'sign-in' });
    return tokensOf(pair, row.scopes);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

/**
 * refresh_token: rotates the access and refresh token of one sign-in in place (one agent_tokens row per sign-in),
 * if the token is not revoked, the refresh not expired, the client the same, the agent enabled and its owner still
 * a member. The old pair stops working at once.
 */
async function refreshTokens(body: Record<string, unknown>): Promise<Tokens> {
  const raw = str(body.refresh_token);
  const clientId = str(body.client_id);
  if (!raw || !clientId) throw new OAuthError('invalid_request', 'refresh_token and client_id are required.');
  const parsed = parseRefreshToken(raw);
  if (!parsed) throw grantError();
  const now = new Date();
  const result = await withTenantTx(parsed.tenantId, async (tx): Promise<Tokens | OAuthError> => {
    const [row] = await tx
      .select({ token: agentTokens, disabledAt: agents.disabledAt, ownerRole: memberships.role })
      .from(agentTokens)
      .innerJoin(agents, and(eq(agents.tenantId, agentTokens.tenantId), eq(agents.id, agentTokens.agentId)))
      .innerJoin(tenants, eq(tenants.id, agentTokens.tenantId))
      .leftJoin(memberships, and(eq(memberships.tenantId, agents.tenantId), eq(memberships.userId, agents.createdBy)))
      .where(and(eq(agentTokens.tenantId, parsed.tenantId), eq(agentTokens.refreshTokenHash, parsed.hash), isNull(tenants.deletedAt)));
    if (!row) return grantError();
    const { token } = row;
    if (
      token.revokedAt ||
      !token.refreshExpiresAt ||
      token.refreshExpiresAt <= now ||
      token.oauthClientId !== clientId.toLowerCase() ||
      row.disabledAt ||
      !row.ownerRole
    ) {
      return grantError();
    }
    const asked = (str(body.scope) ?? '').split(/\s+/).filter(Boolean);
    if (asked.some((s) => !token.scopes.includes(s))) return new OAuthError('invalid_scope', 'A refresh cannot add scopes.');
    const pair = mintPair(parsed.tenantId, now);
    const rotated = await tx
      .update(agentTokens)
      .set(pair.columns)
      .where(and(eq(agentTokens.tenantId, parsed.tenantId), eq(agentTokens.id, token.id), eq(agentTokens.refreshTokenHash, parsed.hash)))
      .returning({ id: agentTokens.id });
    // Another refresh with the same token won the race.
    if (rotated.length === 0) return grantError();
    return tokensOf(pair, token.scopes);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

/** RFC 7009: revokes the sign-in an access or refresh token belongs to. Unknown tokens are not an error. */
async function revokeToken(raw: string): Promise<void> {
  const access = parseAgentToken(raw);
  const refresh = access ? null : parseRefreshToken(raw);
  const parsed = access ?? refresh;
  if (!parsed) return;
  await withTenantTx(parsed.tenantId, async (tx) => {
    const [row] = await tx
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentTokens.tenantId, parsed.tenantId),
          access ? eq(agentTokens.tokenHash, parsed.hash) : eq(agentTokens.refreshTokenHash, parsed.hash),
          isNull(agentTokens.revokedAt)
        )
      )
      .returning();
    if (!row) return;
    await writeAuditEvent(tx, {
      tenantId: parsed.tenantId,
      type: 'agent.token_revoked',
      actorType: 'agent',
      actorId: row.agentId,
      subjectType: 'agent',
      subjectId: row.agentId,
      payload: { tokenId: row.id, name: row.name, via: 'sign-in' },
    });
  });
}

/** The workspaces the member can connect, each with the spaces (never the Inbox) the sign-in page offers. */
async function workspacesOf(userId: string) {
  const rows = rowsOf<{ tenant_id: string; name: string; slug: string }>(
    await getDb().execute(sql`SELECT tenant_id, name, slug FROM my_tenants(${userId}::uuid) ORDER BY name, tenant_id`)
  );
  const out = [];
  for (const r of rows) {
    const actor = await actorForUser(r.tenant_id, userId);
    const spaces = await withTenantTx(r.tenant_id, (tx) => namedSpaces(tx, actor));
    out.push({ tenantId: r.tenant_id, name: r.name, slug: r.slug, spaces });
  }
  return out;
}

/**
 * Browser sign-in for MCP clients: Kinote as its own OAuth 2.1 authorization server (authorization code with
 * PKCE, public clients only, dynamic client registration). The sign-in page itself is the console's
 * /oauth/authorize, since sessions live in the browser; it asks GET /api/v1/oauth/authorize what to show and
 * POSTs the member's answer. Must be registered after @fastify/rate-limit.
 */
export async function oauthRoutes(app: FastifyInstance, opts: { publicUrl?: string }): Promise<void> {
  const baseOf = (req: FastifyRequest) => oauthBase(req, opts.publicUrl);

  // Token and revocation requests are form-encoded (RFC 6749); only in this plugin.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))));
  });

  const publicCors = { config: { auth: 'public' as const } };
  for (const path of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/api/v1/oauth/register',
    '/api/v1/oauth/token',
    '/api/v1/oauth/revoke',
  ]) {
    app.options(path, publicCors, async (_req, reply) => reply.status(204).headers(CORS).send());
  }

  app.get('/.well-known/oauth-authorization-server', publicCors, async (req, reply) => {
    const base = baseOf(req);
    return reply.headers(CORS).send({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/api/v1/oauth/token`,
      registration_endpoint: `${base}/api/v1/oauth/register`,
      revocation_endpoint: `${base}/api/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...OAUTH_SCOPES],
    });
  });

  const protectedResource = async (req: FastifyRequest, reply: FastifyReply) => {
    const base = baseOf(req);
    return reply.headers(CORS).send({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Kinote',
    });
  };
  app.get('/.well-known/oauth-protected-resource', publicCors, protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', publicCors, protectedResource);

  // RFC 7591. Anyone may register (that is the point); a registration grants nothing until a member approves it.
  app.post(
    '/api/v1/oauth/register',
    { config: { auth: 'public', rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const fail = (error: string, description: string) =>
        reply.status(400).headers({ ...CORS, 'cache-control': 'no-store' }).send({ error, error_description: description });
      const parsed = RegisterSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        const onUris = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris');
        return onUris
          ? fail('invalid_redirect_uri', 'redirect_uris must list 1 to 10 addresses.')
          : fail('invalid_client_metadata', 'The registration is not valid.');
      }
      const body = parsed.data;
      const bad = body.redirect_uris.find((u) => !isAllowedRedirectUri(u));
      if (bad !== undefined) {
        return fail('invalid_redirect_uri', 'Redirect addresses must be https, http to localhost, or an app scheme, without a fragment.');
      }
      if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
        return fail('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none", with PKCE) can register.');
      }
      const grants = body.grant_types ?? ['authorization_code', 'refresh_token'];
      if (!grants.includes('authorization_code') || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
        return fail('invalid_client_metadata', 'grant_types may be authorization_code and refresh_token.');
      }
      if (body.response_types && body.response_types.some((r) => r !== 'code')) {
        return fail('invalid_client_metadata', 'response_types may only be code.');
      }
      // eslint-disable-next-line no-control-regex
      const name = (body.client_name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || DEFAULT_CLIENT_NAME;
      const [client] = await getDb().insert(oauthClients).values({ name, redirectUris: body.redirect_uris }).returning();
      return reply
        .status(201)
        .headers({ ...CORS, 'cache-control': 'no-store' })
        .send({
          client_id: client!.id,
          client_id_issued_at: Math.floor(client!.createdAt.getTime() / 1000),
          client_name: client!.name,
          redirect_uris: client!.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
    }
  );

  // What the console's sign-in page shows: the client, and the workspaces and spaces the member can offer it.
  app.get('/api/v1/oauth/authorize', { config: { auth: 'session' } }, async (req, reply) => {
    const session = req.authSession;
    if (!session) throw new AppError('unauthenticated');
    const params = OAuthAuthorizeParamsSchema.parse(req.query ?? {});
    const check = await checkAuthorizeRequest(params, baseOf(req));
    if (check.kind === 'invalid') throw new AppError('oauth_request_invalid', undefined, { reason: check.reason });
    let body: OAuthAuthorizeCheck;
    if (check.kind === 'redirect') {
      body = { status: 'redirect', to: check.to };
    } else {
      body = {
        status: 'ask',
        client: { name: check.client.name, redirectUri: check.redirectUri },
        scopes: check.scopes as Array<(typeof OAUTH_SCOPES)[number]>,
        workspaces: await workspacesOf(session.userId),
      };
    }
    return reply.header('cache-control', 'no-store').send(parseReply(OAuthAuthorizeCheckSchema, body));
  });

  // The member's answer. Cancel needs no workspace (someone in none can still send the app back); Allow names the
  // workspace picked and stores a one-time code there. The agent comes at the exchange.
  app.post('/api/v1/oauth/authorize', { config: { auth: 'session' } }, async (req, reply) => {
    const session = req.authSession;
    if (!session) throw new AppError('unauthenticated');
    const base = baseOf(req);
    const params = OAuthAuthorizeParamsSchema.parse(req.body ?? {});
    const check = await checkAuthorizeRequest(params, base);
    if (check.kind === 'invalid') throw new AppError('oauth_request_invalid', undefined, { reason: check.reason });
    if (check.kind === 'redirect') return reply.send(parseReply(OAuthDecisionResponseSchema, { to: check.to }));
    const decision = OAuthDecisionSchema.parse(req.body);
    if (decision.decision === 'deny') {
      const to = redirectWith(check.redirectUri, {
        error: 'access_denied',
        error_description: 'The sign-in was cancelled.',
        state: check.state,
        iss: base,
      });
      return reply.send(parseReply(OAuthDecisionResponseSchema, { to }));
    }
    const actor = await actorForUser(decision.tenant_id.toLowerCase(), session.userId);
    req.actor = actor;
    await assertNotSuspended(req);
    if (decision.capture && !check.scopes.includes('capture')) {
      throw new AppError('validation_failed', 'This app did not ask to file captures.');
    }
    if (decision.edit && !check.scopes.includes('edit')) {
      throw new AppError('validation_failed', 'This app did not ask to make edits.');
    }
    // Reading always; capture and edit only when the app asked and the person ticked them.
    const scopes = ['read', ...(decision.capture ? ['capture'] : []), ...(decision.edit ? ['edit'] : [])];
    const code = mintOAuthCode(actor.tenantId);
    await withTenantTx(actor.tenantId, async (tx) => {
      const readable = new Set((await namedSpaces(tx, actor)).map((s) => s.id));
      const spaceIds = [...new Set(decision.space_ids.map((id) => id.toLowerCase()))];
      if (spaceIds.some((id) => !readable.has(id))) throw new AppError('space_not_found');
      // Old codes are of no use to anyone: clear those that expired a day ago or more.
      await tx
        .delete(oauthCodes)
        .where(and(eq(oauthCodes.tenantId, actor.tenantId), lt(oauthCodes.expiresAt, new Date(Date.now() - 86_400_000))));
      await tx.insert(oauthCodes).values({
        tenantId: actor.tenantId,
        codeHash: code.hash,
        clientId: check.client.id,
        userId: actor.principalId,
        redirectUri: check.redirectUri,
        codeChallenge: check.codeChallenge,
        scopes,
        agentName: decision.agent_name,
        spaceIds,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
    });
    const to = redirectWith(check.redirectUri, { code: code.token, state: check.state, iss: base });
    return reply.header('cache-control', 'no-store').send(parseReply(OAuthDecisionResponseSchema, { to }));
  });

  app.post(
    '/api/v1/oauth/token',
    { config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const grantType = str(body.grant_type);
        let tokens: Tokens;
        if (grantType === 'authorization_code') tokens = await exchangeCode(body);
        else if (grantType === 'refresh_token') tokens = await refreshTokens(body);
        else if (!grantType) throw new OAuthError('invalid_request', 'grant_type is required.');
        else throw new OAuthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token.');
        return reply.headers({ ...CORS, 'cache-control': 'no-store', pragma: 'no-cache' }).send(tokens);
      } catch (err) {
        if (err instanceof OAuthError) return sendOAuthError(reply, err);
        throw err;
      }
    }
  );

  app.post(
    '/api/v1/oauth/revoke',
    { config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const raw = str((req.body as Record<string, unknown> | undefined)?.token);
      if (!raw) return sendOAuthError(reply, new OAuthError('invalid_request', 'token is required.'));
      await revokeToken(raw);
      return reply.status(200).headers({ ...CORS, 'cache-control': 'no-store' }).send({});
    }
  );
}
