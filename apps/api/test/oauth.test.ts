import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { agentTokens, agents, auditEvents, oauthCodes, spaceGrants, withTenantTx } from '@kinote/db';
import { buildTestApp, signUpMember, useTestDb } from './support/testkit.js';
import { agentWorld, listToolNames, mcpRequest, type AgentWorld } from './support/mcpkit.js';

const BASE = 'https://kinote.example.com';
const REDIRECT = 'http://127.0.0.1:33418/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(app: FastifyInstance, body: object) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/oauth/register', payload: body });
  return { status: res.statusCode, body: res.json() as any, headers: res.headers };
}

async function newClient(app: FastifyInstance, name = 'Claude Code', redirect = REDIRECT): Promise<string> {
  const r = await register(app, { client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.client_id as string;
}

const authParams = (clientId: string, challenge: string, extra: Record<string, string> = {}) => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'st-123',
  scope: 'read',
  resource: `${BASE}/mcp`,
  ...extra,
});

/** What the console's sign-in page asks the api about an authorization request. */
async function check(app: FastifyInstance, headers: Record<string, string>, params: Record<string, string>) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/oauth/authorize?${new URLSearchParams(params)}`,
    headers: { authorization: headers.authorization! },
  });
  return { status: res.statusCode, body: res.json() as any };
}

/** The member's decision, in the workspace they picked (x-tenant-id). */
async function decide(app: FastifyInstance, headers: Record<string, string>, params: Record<string, string>, decision: object) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/oauth/authorize', headers, payload: { ...params, ...decision } });
  return { status: res.statusCode, body: res.json() as any };
}

async function token(app: FastifyInstance, form: Record<string, string>, as: 'form' | 'json' = 'form') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/oauth/token',
    ...(as === 'form'
      ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString() }
      : { payload: form }),
  });
  return { status: res.statusCode, body: res.json() as any, headers: res.headers };
}

/** Registers a client, approves it for `spaces` and returns the code with everything needed to exchange it. */
async function approved(app: FastifyInstance, w: AgentWorld, spaceIds: string[] = [w.open.id], agentName = 'Claude Code') {
  const clientId = await newClient(app);
  const p = pkce();
  const params = authParams(clientId, p.challenge);
  const res = await decide(app, w.ownerHeaders, params, { decision: 'allow', agent_name: agentName, space_ids: spaceIds });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const to = new URL(res.body.to);
  return { clientId, verifier: p.verifier, code: to.searchParams.get('code')!, to };
}

const exchangeForm = (a: { clientId: string; verifier: string; code: string }) => ({
  grant_type: 'authorization_code',
  code: a.code,
  redirect_uri: REDIRECT,
  client_id: a.clientId,
  code_verifier: a.verifier,
});

describe('OAuth metadata', () => {
  useTestDb();

  test('the authorization server and protected resource documents name PUBLIC_URL', async () => {
    const app = buildTestApp({ publicUrl: `${BASE}/` });
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    assert.equal(as.statusCode, 200);
    assert.equal(as.headers['access-control-allow-origin'], '*');
    assert.deepEqual(as.json(), {
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/api/v1/oauth/token`,
      registration_endpoint: `${BASE}/api/v1/oauth/register`,
      revocation_endpoint: `${BASE}/api/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read'],
    });
    for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const pr = await app.inject({ method: 'GET', url });
      assert.equal(pr.statusCode, 200, url);
      assert.deepEqual(pr.json(), {
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
        scopes_supported: ['read'],
        bearer_methods_supported: ['header'],
        resource_name: 'Kinote',
      });
    }
  });

  test('without PUBLIC_URL the documents name the address the request came to', async () => {
    const app = buildTestApp();
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server', headers: { host: 'wiki.local:8080' } });
    assert.equal(as.json().issuer, 'http://wiki.local:8080');
    assert.equal(as.json().authorization_endpoint, 'http://wiki.local:8080/oauth/authorize');
  });

  test('/mcp without a valid token answers 401 pointing at the protected resource document', async () => {
    const app = buildTestApp({ publicUrl: BASE });
    for (const auth of [undefined, 'Bearer nope']) {
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['www-authenticate'], `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    }
  });
});

describe('OAuth client registration', () => {
  useTestDb();
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildTestApp({ publicUrl: BASE });
  });

  test('a public client registers with loopback, https or app-scheme redirect addresses', async () => {
    const r = await register(app, {
      client_name: 'Claude Code (kinote)',
      redirect_uris: ['http://localhost:4567/callback', 'https://claude.ai/api/mcp/auth_callback', 'cursor://anysphere.cursor-mcp/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.client_id, /^[0-9a-f-]{36}$/);
    assert.equal(r.headers['access-control-allow-origin'], '*');
    assert.deepEqual({ ...r.body, client_id: 'x', client_id_issued_at: 0 }, {
      client_id: 'x',
      client_id_issued_at: 0,
      client_name: 'Claude Code (kinote)',
      redirect_uris: ['http://localhost:4567/callback', 'https://claude.ai/api/mcp/auth_callback', 'cursor://anysphere.cursor-mcp/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  test('a client without a name is called "MCP client"', async () => {
    const r = await register(app, { redirect_uris: [REDIRECT] });
    assert.equal(r.status, 201);
    assert.equal(r.body.client_name, 'MCP client');
  });

  test('unsafe or malformed redirect addresses are refused', async () => {
    for (const uri of [
      'http://evil.example/callback',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'https://ok.example/cb#frag',
      '/relative',
      'not a url',
    ]) {
      const r = await register(app, { redirect_uris: [uri] });
      assert.equal(r.status, 400, uri);
      assert.equal(r.body.error, 'invalid_redirect_uri', uri);
    }
    const none = await register(app, { redirect_uris: [] });
    assert.equal(none.body.error, 'invalid_redirect_uri');
  });

  test('a confidential client (with a secret) is refused: only PKCE public clients', async () => {
    const r = await register(app, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_client_metadata');
  });
});

describe('OAuth sign-in', () => {
  useTestDb();
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildTestApp({ publicUrl: BASE });
  });

  test('the sign-in page learns the client and the spaces it may offer in each workspace', async () => {
    const w = await agentWorld(app, 'oauth-check');
    const clientId = await newClient(app, 'Claude Code');
    const res = await check(app, w.ownerHeaders, authParams(clientId, pkce().challenge));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
      status: 'ask',
      client: { name: 'Claude Code', redirectUri: REDIRECT },
      scopes: ['read'],
      workspaces: [
        {
          tenantId: w.tenant.id,
          name: 'oauth-check Co',
          slug: 'oauth-check',
          spaces: [
            { id: w.hidden.id, name: 'Hidden' },
            { id: w.open.id, name: 'Open' },
            { id: w.strict.id, name: 'Strict' },
          ],
        },
      ],
    });
  });

  test('a loopback redirect may use another port, as native apps pick a free one', async () => {
    const w = await agentWorld(app, 'oauth-port');
    const clientId = await newClient(app);
    const res = await check(app, w.ownerHeaders, authParams(clientId, pkce().challenge, { redirect_uri: 'http://127.0.0.1:50001/callback' }));
    assert.equal(res.body.status, 'ask', JSON.stringify(res.body));
    assert.equal(res.body.client.redirectUri, 'http://127.0.0.1:50001/callback');
  });

  test('an unknown client or a redirect it never registered is shown as an error, never followed', async () => {
    const w = await agentWorld(app, 'oauth-bad');
    const clientId = await newClient(app);
    for (const params of [
      authParams('00000000-0000-4000-8000-000000000000', 'c'),
      authParams('not-a-uuid', 'c'),
      authParams(clientId, 'c', { redirect_uri: 'http://127.0.0.1:33418/other' }),
      authParams(clientId, 'c', { redirect_uri: 'https://evil.example/callback' }),
    ]) {
      const res = await check(app, w.ownerHeaders, params);
      assert.equal(res.status, 400, JSON.stringify(params));
      assert.equal(res.body.error, 'oauth_request_invalid');
    }
  });

  test('other mistakes go back to the client as OAuth errors with its state', async () => {
    const w = await agentWorld(app, 'oauth-redirect');
    const clientId = await newClient(app);
    const cases: Array<[Record<string, string>, string]> = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: '' }, 'invalid_request'],
      [{ scope: 'edit' }, 'invalid_scope'],
      [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
    ];
    for (const [extra, error] of cases) {
      const res = await check(app, w.ownerHeaders, authParams(clientId, pkce().challenge, extra));
      assert.equal(res.status, 200, JSON.stringify(extra));
      assert.equal(res.body.status, 'redirect', JSON.stringify(res.body));
      const to = new URL(res.body.to);
      assert.equal(`${to.origin}${to.pathname}`, REDIRECT);
      assert.equal(to.searchParams.get('error'), error, JSON.stringify(extra));
      assert.equal(to.searchParams.get('state'), 'st-123');
      assert.equal(to.searchParams.get('iss'), BASE);
    }
    // No scope or resource at all is fine: read, for this server.
    const bare = authParams(clientId, pkce().challenge);
    delete (bare as Partial<typeof bare>).scope;
    delete (bare as Partial<typeof bare>).resource;
    assert.equal((await check(app, w.ownerHeaders, bare)).body.status, 'ask');
  });

  test('the sign-in page needs a session', async () => {
    const clientId = await newClient(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/oauth/authorize?${new URLSearchParams(authParams(clientId, 'c'))}` });
    assert.equal(res.statusCode, 401);
  });

  test('cancelling sends access_denied back, and nothing is created', async () => {
    const w = await agentWorld(app, 'oauth-deny');
    const clientId = await newClient(app);
    const res = await decide(app, w.ownerHeaders, authParams(clientId, pkce().challenge), { decision: 'deny' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const to = new URL(res.body.to);
    assert.equal(to.searchParams.get('error'), 'access_denied');
    assert.equal(to.searchParams.get('state'), 'st-123');
    assert.equal(to.searchParams.get('iss'), BASE);
    const codes = await withTenantTx(w.tenant.id, (tx) => tx.select().from(oauthCodes));
    assert.equal(codes.length, 0);
  });

  test('allowing returns a one-time code to the redirect; the agent waits for the exchange', async () => {
    const w = await agentWorld(app, 'oauth-allow');
    const a = await approved(app, w, [w.open.id]);
    assert.equal(`${a.to.origin}${a.to.pathname}`, REDIRECT);
    assert.match(a.code, /^lwaco_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(a.to.searchParams.get('state'), 'st-123');
    assert.equal(a.to.searchParams.get('iss'), BASE);
    const external = await withTenantTx(w.tenant.id, (tx) => tx.select().from(agents).where(eq(agents.name, 'Claude Code')));
    assert.equal(external.length, 0);
  });

  test('allowing needs a name and at least one space the member can read, never the Inbox', async () => {
    const w = await agentWorld(app, 'oauth-spaces');
    const clientId = await newClient(app);
    const params = authParams(clientId, pkce().challenge);
    for (const body of [
      { decision: 'allow', agent_name: 'Bot', space_ids: [] },
      { decision: 'allow', agent_name: '', space_ids: [w.open.id] },
      { decision: 'allow', agent_name: 'Bot', space_ids: ['nope'] },
    ]) {
      const res = await decide(app, w.ownerHeaders, params, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    for (const id of [w.inboxSpace.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await decide(app, w.ownerHeaders, params, { decision: 'allow', agent_name: 'Bot', space_ids: [w.open.id, id] });
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error, 'space_not_found');
    }
    const codes = await withTenantTx(w.tenant.id, (tx) => tx.select().from(oauthCodes));
    assert.equal(codes.length, 0);
  });

  test('a decision for a client and redirect that do not match is refused', async () => {
    const w = await agentWorld(app, 'oauth-decide-bad');
    const clientId = await newClient(app);
    const res = await decide(app, w.ownerHeaders, authParams(clientId, 'c', { redirect_uri: 'https://evil.example/cb' }), {
      decision: 'allow',
      agent_name: 'Bot',
      space_ids: [w.open.id],
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'oauth_request_invalid');
  });
});

describe('OAuth tokens', () => {
  useTestDb();
  let app: FastifyInstance;
  beforeEach(() => {
    app = buildTestApp({ publicUrl: BASE });
  });

  test('the code exchange creates an agent owned by the member, with viewer grants and a 1-hour read token', async () => {
    const w = await agentWorld(app, 'oauth-exchange');
    const a = await approved(app, w, [w.open.id, w.strict.id], 'My laptop');
    const before = Date.now();
    const res = await token(app, exchangeForm(a));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(res.body.access_token, /^lwagt_/);
    assert.match(res.body.refresh_token, /^lwagr_/);
    assert.deepEqual({ ...res.body, access_token: 'a', refresh_token: 'r' }, {
      access_token: 'a',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'r',
      scope: 'read',
    });

    const [agent] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(agents).where(eq(agents.name, 'My laptop')));
    assert.ok(agent);
    assert.equal(agent.kind, 'external');
    assert.equal(agent.createdBy, w.owner.userId);
    const grants = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(spaceGrants).where(and(eq(spaceGrants.principalType, 'agent'), eq(spaceGrants.principalId, agent.id)))
    );
    assert.deepEqual(grants.map((g) => [g.spaceId, g.role]).sort(), [[w.open.id, 'viewer'], [w.strict.id, 'viewer']].sort());
    const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(agentTokens).where(eq(agentTokens.agentId, agent.id)));
    assert.equal(row!.name, 'Claude Code');
    assert.deepEqual(row!.scopes, ['read']);
    assert.equal(row!.createdBy, w.owner.userId);
    assert.equal(row!.oauthClientId, a.clientId);
    assert.ok(Math.abs(row!.expiresAt!.getTime() - (before + 3_600_000)) < 60_000);
    assert.ok(Math.abs(row!.refreshExpiresAt!.getTime() - (before + 90 * 86_400_000)) < 60_000);

    // The token works on /mcp, and its agent reads only what it was given.
    assert.deepEqual(await listToolNames(app, res.body.access_token), ['kinote_ask', 'kinote_browse', 'kinote_read', 'kinote_related', 'kinote_search']);
    const init = await mcpRequest(app, res.body.access_token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    assert.match(init.body.result.instructions, /Spaces you can read: Open, Strict\./);

    const audit = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.subjectType, 'agent'), eq(auditEvents.subjectId, agent.id)))
    );
    const created = audit.find((e) => e.type === 'agent.created');
    assert.equal(created?.actorId, w.owner.userId);
    assert.deepEqual(created?.payload, { name: 'My laptop', dailyAiLimit: null, via: 'sign-in', client: 'Claude Code' });
    assert.ok(audit.some((e) => e.type === 'agent.token_issued'));
  });

  test('JSON bodies work too', async () => {
    const w = await agentWorld(app, 'oauth-json');
    const a = await approved(app, w);
    const res = await token(app, exchangeForm(a), 'json');
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test('a wrong verifier, redirect, client or an expired code is invalid_grant', async () => {
    const w = await agentWorld(app, 'oauth-wrong');
    const other = await newClient(app, 'Other');
    const cases: Array<(f: Record<string, string>) => Record<string, string>> = [
      (f) => ({ ...f, code_verifier: pkce().verifier }),
      (f) => ({ ...f, redirect_uri: 'http://127.0.0.1:33418/other' }),
      (f) => ({ ...f, client_id: other }),
      (f) => ({ ...f, code: f.code!.slice(0, -2) + 'AA' }),
      (f) => ({ ...f, code: 'garbage' }),
    ];
    for (const change of cases) {
      const a = await approved(app, w);
      const res = await token(app, change(exchangeForm(a)));
      assert.equal(res.status, 400, JSON.stringify(change(exchangeForm(a))));
      assert.equal(res.body.error, 'invalid_grant');
      assert.equal(typeof res.body.error_description, 'string');
    }
    const late = await approved(app, w);
    await withTenantTx(w.tenant.id, (tx) => tx.update(oauthCodes).set({ expiresAt: new Date(Date.now() - 1000) }));
    const expired = await token(app, exchangeForm(late));
    assert.equal(expired.body.error, 'invalid_grant');
  });

  test('a code used twice fails and revokes the token it gave', async () => {
    const w = await agentWorld(app, 'oauth-replay');
    const a = await approved(app, w);
    const first = await token(app, exchangeForm(a));
    assert.equal(first.status, 200);
    const again = await token(app, exchangeForm(a));
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'invalid_grant');
    assert.equal((await mcpRequest(app, first.body.access_token, 'tools/list')).status, 401);
    const refresh = await token(app, { grant_type: 'refresh_token', refresh_token: first.body.refresh_token, client_id: a.clientId });
    assert.equal(refresh.body.error, 'invalid_grant');
  });

  test('a member who left by the exchange gets nothing', async () => {
    const w = await agentWorld(app, 'oauth-left');
    const member = await signUpMember(app, w.tenant.id, 'member');
    const grant = await app.inject({
      method: 'POST',
      url: `/api/v1/spaces/${w.open.id}/grants`,
      headers: w.ownerHeaders,
      payload: { principal_type: 'user', principal_id: member.userId, role: 'viewer' },
    });
    assert.equal(grant.statusCode, 201, grant.body);
    const clientId = await newClient(app);
    const p = pkce();
    const params = authParams(clientId, p.challenge);
    const ok = await decide(app, member.headers, params, { decision: 'allow', agent_name: 'Bot', space_ids: [w.open.id] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/members/${member.userId}`, headers: w.ownerHeaders });
    assert.ok(del.statusCode < 300, del.body);
    const res = await token(app, { grant_type: 'authorization_code', code: new URL(ok.body.to).searchParams.get('code')!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: p.verifier });
    assert.equal(res.body.error, 'invalid_grant');
  });

  test('refreshing rotates both tokens; the old ones stop working', async () => {
    const w = await agentWorld(app, 'oauth-refresh');
    const a = await approved(app, w);
    const first = (await token(app, exchangeForm(a))).body;
    const res = await token(app, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: a.clientId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.access_token, first.access_token);
    assert.notEqual(res.body.refresh_token, first.refresh_token);
    assert.equal(res.body.expires_in, 3600);
    assert.equal((await mcpRequest(app, first.access_token, 'tools/list')).status, 401);
    assert.equal((await mcpRequest(app, res.body.access_token, 'tools/list')).status, 200);
    const old = await token(app, { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: a.clientId });
    assert.equal(old.body.error, 'invalid_grant');
    const tokens = await withTenantTx(w.tenant.id, (tx) => tx.select().from(agentTokens).where(eq(agentTokens.oauthClientId, a.clientId)));
    assert.equal(tokens.length, 1, 'one row per sign-in, rotated in place');
  });

  test('a refresh from another client, after the token was revoked, the agent disabled or the refresh expired fails', async () => {
    const w = await agentWorld(app, 'oauth-refresh-no');
    const other = await newClient(app, 'Other');
    const refreshOf = async () => {
      const a = await approved(app, w);
      const t = (await token(app, exchangeForm(a))).body;
      const [row] = await withTenantTx(w.tenant.id, (tx) => tx.select().from(agentTokens).where(eq(agentTokens.oauthClientId, a.clientId)));
      return { a, t, row: row! };
    };
    const refresh = (r: string, clientId: string) => token(app, { grant_type: 'refresh_token', refresh_token: r, client_id: clientId });

    const x = await refreshOf();
    assert.equal((await refresh(x.t.refresh_token, other)).body.error, 'invalid_grant');

    const revoked = await refreshOf();
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/${revoked.row.agentId}/tokens/${revoked.row.id}`,
      headers: w.ownerHeaders,
    });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal((await refresh(revoked.t.refresh_token, revoked.a.clientId)).body.error, 'invalid_grant');

    const disabled = await refreshOf();
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${disabled.row.agentId}`, headers: w.ownerHeaders, payload: { disabled: true } });
    assert.equal(patch.statusCode, 200, patch.body);
    assert.equal((await refresh(disabled.t.refresh_token, disabled.a.clientId)).body.error, 'invalid_grant');

    const stale = await refreshOf();
    await withTenantTx(w.tenant.id, (tx) =>
      tx.update(agentTokens).set({ refreshExpiresAt: new Date(Date.now() - 1000) }).where(eq(agentTokens.id, stale.row.id))
    );
    assert.equal((await refresh(stale.t.refresh_token, stale.a.clientId)).body.error, 'invalid_grant');
  });

  test('unknown grant types and missing fields', async () => {
    assert.equal((await token(app, { grant_type: 'client_credentials' })).body.error, 'unsupported_grant_type');
    assert.equal((await token(app, { grant_type: 'authorization_code' })).body.error, 'invalid_request');
    assert.equal((await token(app, {})).body.error, 'invalid_request');
  });

  test('revocation (RFC 7009) with either token ends the sign-in; an unknown token is still 200', async () => {
    const w = await agentWorld(app, 'oauth-revoke');
    for (const which of ['access_token', 'refresh_token'] as const) {
      const a = await approved(app, w);
      const t = (await token(app, exchangeForm(a))).body;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/oauth/revoke',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ token: t[which], client_id: a.clientId }).toString(),
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await mcpRequest(app, t.access_token, 'tools/list')).status, 401, which);
      const refresh = await token(app, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: a.clientId });
      assert.equal(refresh.body.error, 'invalid_grant', which);
    }
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=whatever',
    });
    assert.equal(unknown.statusCode, 200);
  });
});
