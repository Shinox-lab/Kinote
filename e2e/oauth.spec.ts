import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { PASSWORD, seedWorld } from './support.js';

// The app's own callback; the browser never reaches a real server there, the spec catches the redirect.
const REDIRECT = 'http://127.0.0.1:9/callback';

test('an MCP client signs in through the browser: sign in, pick spaces, allow, exchange the code, use /mcp', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });

  // What the app does first: discover the server, register itself.
  const meta = await (await request.get('/.well-known/oauth-authorization-server')).json();
  expect(meta.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
  const reg = await request.post('/api/v1/oauth/register', {
    data: { client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
  });
  expect(reg.status()).toBe(201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: '{"n":1}',
    scope: 'read',
  })) {
    authorize.searchParams.set(k, v);
  }

  // The person, signed out, opens the link: sign in first, then the sign-in page with the request intact.
  const context = await browser.newContext();
  const page = await context.newPage();
  let landed: URL | null = null;
  await page.route('http://127.0.0.1:9/**', async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'You can close this tab.' });
  });
  await page.goto(authorize.pathname + authorize.search);
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel('Email').fill(world.owner.user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Connect Claude Code' })).toBeVisible();
  await expect(page.getByText(REDIRECT)).toBeVisible();
  const allow = page.getByRole('button', { name: 'Allow' });
  await expect(allow).toBeDisabled();
  await page.getByLabel('Agent name').fill('Laptop agent');
  await page.getByLabel('Docs').check();
  await allow.click();

  await expect.poll(() => landed?.searchParams.get('code') ?? null).toMatch(/^lwaco_/);
  const back = landed as unknown as URL;
  expect(back.searchParams.get('state')).toBe('{"n":1}');

  // The app exchanges the code and calls /mcp with the token.
  const tokenRes = await request.post('/api/v1/oauth/token', {
    form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: REDIRECT, client_id, code_verifier: verifier },
  });
  expect(tokenRes.status()).toBe(200);
  const tokens = await tokenRes.json();
  const mcp = await request.post('/mcp', {
    headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(mcp.status()).toBe(200);
  expect(JSON.stringify(await mcp.json())).toContain('kinote_search');

  // The agent is listed on the Agents page, owned by the person, with its sign-in token.
  await page.goto(`/w/${world.slug}/admin/agents`);
  await page.getByRole('button', { name: /^Laptop agent Olive Owner/ }).click();
  const panel = page.getByRole('region', { name: 'Agent Laptop agent' });
  await expect(panel).toContainText('Docs');
  await expect(panel.getByRole('list', { name: 'Tokens of Laptop agent' })).toContainText('Claude Code');
  await context.close();
});

test('cancelling sends access_denied back to the app', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const reg = await request.post('/api/v1/oauth/register', { data: { client_name: 'Some app', redirect_uris: [REDIRECT] } });
  const { client_id } = await reg.json();
  const challenge = createHash('sha256').update('x'.repeat(43)).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });

  const context = await browser.newContext();
  const page = await context.newPage();
  let landed: URL | null = null;
  await page.route('http://127.0.0.1:9/**', async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
  });
  await page.goto(`/sign-in`);
  await page.getByLabel('Email').fill(world.owner.user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/w\//);
  await page.goto(`/oauth/authorize?${query}`);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => landed?.searchParams.get('error') ?? null).toBe('access_denied');
  expect((landed as unknown as URL).searchParams.get('state')).toBe('s1');
  await context.close();
});

test('an invalid request is shown, never followed on its own: the person chooses to go back', async ({ browser, request }) => {
  const world = await seedWorld(request, { reviewRequired: false });
  const reg = await request.post('/api/v1/oauth/register', { data: { client_name: 'Odd app', redirect_uris: [REDIRECT] } });
  const { client_id } = await reg.json();
  const query = new URLSearchParams({ response_type: 'token', client_id, redirect_uri: REDIRECT, state: 's2' });

  const context = await browser.newContext();
  const page = await context.newPage();
  let landed: URL | null = null;
  await page.route('http://127.0.0.1:9/**', async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
  });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(world.owner.user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/w\//);
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByRole('alert')).toContainText('This sign-in request is not valid');
  await expect(page.getByText(REDIRECT)).toBeVisible();
  await page.waitForTimeout(500);
  expect(landed).toBeNull();
  await page.getByRole('link', { name: 'Return to the app' }).click();
  await expect.poll(() => landed?.searchParams.get('error') ?? null).toBe('unsupported_response_type');
  await context.close();
});
