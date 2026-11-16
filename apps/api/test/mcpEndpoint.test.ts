import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents, withTenantTx } from '@kinote/db';
import { AppError } from '@kinote/contracts';
import { defaultAnswerProvider, defaultEmbeddingProvider, estimateTokens } from '@kinote/core';
import { registerMcpRoute, type McpDeps } from '../src/mcp/route.js';
import { defineTool } from '../src/mcp/tool.js';
import { ToolError } from '../src/mcp/refs.js';
import { buildTestApp, TEST_LIMITS, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, issueAgentToken, listToolNames, mcpRequest } from './support/mcpkit.js';
import { bearer } from './support/sourcekit.js';

const TEST_PATH = '/test/mcp';

const echo = defineTool({
  name: 'kinote_echo',
  scope: 'read',
  limit: 'search',
  description: 'Echo the text back.',
  input: { text: z.string().max(1_000_000), fail: z.enum(['tool', 'app', 'crash']).optional() },
  async run(args, ctx) {
    if (args.fail === 'tool') throw new ToolError('Nothing to echo. Try other words.');
    if (args.fail === 'app') throw new AppError('forbidden');
    if (args.fail === 'crash') throw new Error('database exploded');
    ctx.touch(['11111111-1111-4111-8111-111111111111']);
    return args.text;
  },
});
const captureEcho = defineTool({
  name: 'kinote_capture_echo',
  scope: 'capture',
  limit: 'search',
  description: 'Echo, for capture tokens.',
  input: { text: z.string() },
  async run(args) {
    return args.text;
  },
});

function testDeps(o: Partial<McpDeps> = {}): McpDeps {
  return {
    embeddingProvider: defaultEmbeddingProvider,
    answerProvider: defaultAnswerProvider,
    limits: TEST_LIMITS,
    searchMaxDistance: 0.55,
    meter: (_kind, _actor, fn) => fn(),
    version: 'test',
    ...o,
  };
}

describe('the /mcp endpoint', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
    registerMcpRoute(app, testDeps(), { path: TEST_PATH, tools: [echo, captureEcho] });
  });

  test('tools/list shows only the tools whose scope the token holds', async () => {
    const w = await agentWorld(app, 'mcp-list');
    assert.deepEqual(await listToolNames(app, w.token, TEST_PATH), ['kinote_echo']);
    const both = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['read', 'capture'] });
    assert.deepEqual(await listToolNames(app, both.token, TEST_PATH), ['kinote_capture_echo', 'kinote_echo']);
  });

  test('a capture-only token does not see the read tools, and calling one answers the missing-scope text', async () => {
    const w = await agentWorld(app, 'mcp-scope');
    const capture = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['capture'] });
    assert.deepEqual(await listToolNames(app, capture.token, TEST_PATH), ['kinote_capture_echo']);
    assert.deepEqual(await listToolNames(app, capture.token), ['kinote_capture', 'kinote_capture_action']);
    const real = await callTool(app, capture.token, 'kinote_search', { query: 'x' });
    assert.equal(real.text, 'This token cannot use kinote_search. Ask a workspace admin for a token with the "read" scope.');
    const res = await callTool(app, capture.token, 'kinote_echo', { text: 'hi' }, TEST_PATH);
    assert.equal(res.isError, true);
    assert.equal(res.text, 'This token cannot use kinote_echo. Ask a workspace admin for a token with the "read" scope.');
  });

  test('a tool runs without initialize first (stateless)', async () => {
    const w = await agentWorld(app, 'mcp-stateless');
    const res = await callTool(app, w.token, 'kinote_echo', { text: 'hello' }, TEST_PATH);
    assert.deepEqual(res, { text: 'hello', isError: false });
  });

  test('initialize returns the instructions with the granted space names only', async () => {
    const w = await agentWorld(app, 'mcp-init');
    const res = await mcpRequest(app, w.token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const text: string = res.body.result.instructions;
    assert.match(text, /^Kinote is this workspace's wiki\./);
    assert.match(text, /Spaces you can read: Open, Strict\.$/);
    assert.ok(!text.includes('Hidden'));
    assert.ok(!text.includes('Inbox'));
    assert.equal(res.body.result.serverInfo.name, 'kinote');
  });

  test('a bad token gets 401 before the SDK runs', async () => {
    for (const path of ['/mcp', TEST_PATH]) {
      const res = await mcpRequest(app, 'lwagt_nonsense', 'tools/list', undefined, path);
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'unauthenticated');
    }
    const w = await agentWorld(app, 'mcp-401');
    const session = await app.inject({ method: 'POST', url: '/mcp', headers: bearer(w.owner.token), payload: {} });
    assert.equal(session.statusCode, 401);
  });

  test('GET and DELETE /mcp answer 405', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/mcp' });
      assert.equal(res.statusCode, 405, `${method}: ${res.body}`);
      assert.equal(res.headers.allow, 'POST');
    }
  });

  test('errors are tool results whose text says what to do next', async () => {
    const w = await agentWorld(app, 'mcp-errors');
    assert.deepEqual(await callTool(app, w.token, 'kinote_echo', { text: 'x', fail: 'tool' }, TEST_PATH), {
      text: 'Nothing to echo. Try other words.',
      isError: true,
    });
    const app_ = await callTool(app, w.token, 'kinote_echo', { text: 'x', fail: 'app' }, TEST_PATH);
    assert.equal(app_.isError, true);
    assert.equal(app_.text, 'You do not have permission to perform this action.');
    const crash = await callTool(app, w.token, 'kinote_echo', { text: 'x', fail: 'crash' }, TEST_PATH);
    assert.equal(crash.isError, true);
    assert.ok(!crash.text.includes('database exploded'));
    const unknown = await callTool(app, w.token, 'kinote_nope', {}, TEST_PATH);
    assert.equal(unknown.isError, true);
  });

  test('each call writes one mcp.tool_call audit row with the tool, token, pages and cut arguments', async () => {
    const w = await agentWorld(app, 'mcp-audit');
    await callTool(app, w.token, 'kinote_echo', { text: 'a'.repeat(800) }, TEST_PATH);
    await callTool(app, w.token, 'kinote_echo', { text: 'x', fail: 'tool' }, TEST_PATH);
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.type, 'mcp.tool_call'), eq(auditEvents.actorId, w.agentId)))
    );
    assert.equal(rows.length, 2);
    const ok = rows.find((r) => (r.payload as any).error === null)!;
    assert.equal(ok.actorType, 'agent');
    assert.equal(ok.subjectType, 'agent');
    assert.equal(ok.subjectId, w.agentId);
    const p = ok.payload as any;
    assert.equal(p.tool, 'kinote_echo');
    assert.equal(p.tokenId, w.tokenId);
    assert.equal(p.args.text.length, 500);
    assert.deepEqual(p.pages, ['11111111-1111-4111-8111-111111111111']);
    assert.equal(p.resultTokens, estimateTokens('a'.repeat(800)));
    const failed = rows.find((r) => (r.payload as any).error !== null)!;
    assert.equal((failed.payload as any).error, 'Nothing to echo. Try other words.');
  });

  test('refused calls are audited too: a missing scope and an unknown tool', async () => {
    const w = await agentWorld(app, 'mcp-audit-refused');
    const capture = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['capture'] });
    await callTool(app, capture.token, 'kinote_echo', { text: 'probe' }, TEST_PATH);
    await callTool(app, w.token, 'kinote_nope', {}, TEST_PATH);
    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.type, 'mcp.tool_call'), eq(auditEvents.actorId, w.agentId)))
    );
    const byTool = new Map(rows.map((r) => [(r.payload as any).tool, r.payload as any]));
    assert.equal(byTool.get('kinote_echo')?.tokenId, capture.tokenId);
    assert.match(byTool.get('kinote_echo')?.error, /^This token cannot use kinote_echo\./);
    assert.match(byTool.get('kinote_nope')?.error, /^No tool named kinote_nope\./);
  });

  test('results are cut at 6,000 tokens on a line boundary', async () => {
    const w = await agentWorld(app, 'mcp-cap');
    const line = 'word '.repeat(19) + 'end';
    const text = Array.from({ length: 2000 }, (_, i) => `${i} ${line}`).join('\n');
    const res = await callTool(app, w.token, 'kinote_echo', { text }, TEST_PATH);
    assert.ok(estimateTokens(res.text) <= 6000);
    assert.match(res.text, /\n\[Result cut at 6,000 tokens\.\]$/);
    const body = res.text.replace(/\n\[Result cut at 6,000 tokens\.\]$/, '');
    assert.ok(text.startsWith(body + '\n'));
  });

  test('rate limits count per agent and answer the retry text', async () => {
    const limited = buildTestApp({ limits: { ...TEST_LIMITS, searchPerMinute: 2 } });
    registerMcpRoute(limited, testDeps({ limits: { ...TEST_LIMITS, searchPerMinute: 2 } }), { path: TEST_PATH, tools: [echo] });
    const w = await agentWorld(limited, 'mcp-limit');
    await callTool(limited, w.token, 'kinote_echo', { text: '1' }, TEST_PATH);
    await callTool(limited, w.token, 'kinote_echo', { text: '2' }, TEST_PATH);
    const third = await callTool(limited, w.token, 'kinote_echo', { text: '3' }, TEST_PATH);
    assert.equal(third.isError, true);
    assert.match(third.text, /^Too many kinote_echo calls\. Try again in \d+ seconds\.$/);
    // Another token of the same agent shares the count; another agent does not.
    const second = await issueAgentToken(w.tenant.id, w.agentId);
    assert.equal((await callTool(limited, second.token, 'kinote_echo', { text: '4' }, TEST_PATH)).isError, true);
  });

  test('a read token lists exactly the five read tools', async () => {
    const w = await agentWorld(app, 'mcp-five');
    assert.deepEqual(await listToolNames(app, w.token), ['kinote_ask', 'kinote_browse', 'kinote_read', 'kinote_related', 'kinote_search']);
  });

  test('combined tool definitions stay under 2,000 tokens', async () => {
    const w = await agentWorld(app, 'mcp-budget');
    const res = await mcpRequest(app, w.token, 'tools/list');
    const tools = res.body.result.tools as object[];
    assert.equal(tools.length, 5);
    const total = tools.reduce((n, t) => n + estimateTokens(JSON.stringify(t)), 0);
    assert.ok(total < 2000, `tool definitions use ${total} tokens`);
  });
});
