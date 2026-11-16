import { describe, test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld } from './support/mcpkit.js';

/** An MCP client's own storage, as Claude Code keeps it: the registration, the PKCE verifier and the tokens. */
class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  readonly redirectUrl = 'http://127.0.0.1:45871/callback';
  get clientMetadata() {
    return {
      client_name: 'SDK test client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** The MCP SDK's OAuth client (what Claude Code uses) signs in through Kinote's sign-in page, then uses the tools. */
describe('browser sign-in with the MCP SDK client', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp> | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await app?.close();
  });

  test('discovers the server from the 401, registers, signs in, connects, and refreshes', async () => {
    app = buildTestApp();
    const w = await agentWorld(app, 'sdk-oauth');
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const serverUrl = new URL(`${address}/mcp`);
    const provider = new MemoryProvider();

    // 1. No token: the client follows the 401 to the metadata, registers, and is sent to the sign-in page.
    client = new Client({ name: 'sdk-oauth', version: '1.0.0' });
    const first = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider });
    await assert.rejects(client.connect(first), UnauthorizedError);
    const url = provider.authorizationUrl!;
    assert.ok(url, 'redirected to sign in');
    assert.equal(`${url.origin}${url.pathname}`, `${address}/oauth/authorize`);
    assert.equal(url.searchParams.get('client_id'), (provider.info as { client_id: string }).client_id);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), `${address}/mcp`);

    // 2. The console's sign-in page, as the owner: what to show, then Allow for Open only. The console is served
    //    from the same address, so its calls carry the same Host.
    const params = Object.fromEntries(url.searchParams);
    const host = new URL(address).host;
    const shown = await app.inject({
      method: 'GET',
      url: `/api/v1/oauth/authorize${url.search}`,
      headers: { authorization: w.ownerHeaders.authorization!, host },
    });
    assert.equal(shown.statusCode, 200, shown.body);
    assert.equal(shown.json().status, 'ask', shown.body);
    assert.equal(shown.json().client.name, 'SDK test client');
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize',
      headers: { authorization: w.ownerHeaders.authorization!, host },
      payload: { ...params, decision: 'allow', tenant_id: w.tenant.id, agent_name: 'SDK agent', space_ids: [w.open.id] },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    const back = new URL(allowed.json().to);
    assert.equal(back.searchParams.get('state'), url.searchParams.get('state'));

    // 3. The client exchanges the code, then connects with its token.
    await first.finishAuth(back.searchParams.get('code')!);
    assert.match(provider.saved!.access_token, /^lwagt_/);
    await client.close();
    client = new Client({ name: 'sdk-oauth', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }));
    assert.match(client.getInstructions() ?? '', /Spaces you can read: Open\./);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'kinote_search'));

    // 4. A refresh rotates the tokens, and the new access token works.
    const before = provider.saved!;
    assert.equal(await auth(provider, { serverUrl }), 'AUTHORIZED');
    assert.notEqual(provider.saved!.access_token, before.access_token);
    assert.notEqual(provider.saved!.refresh_token, before.refresh_token);
    await client.close();
    client = new Client({ name: 'sdk-oauth', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }));
    assert.ok((await client.listTools()).tools.length > 0);
  });
});
