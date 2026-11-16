import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { tenantBilling, withTenantTx } from '@kinote/db';
import { defaultAnswerProvider, defaultEmbeddingProvider } from '@kinote/core';
import { registerMcpRoute, type McpDeps } from '../src/mcp/route.js';
import { defineTool } from '../src/mcp/tool.js';
import { serverInstructions } from '../src/mcp/instructions.js';
import { buildTestApp, TEST_LIMITS, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, issueAgentToken } from './support/mcpkit.js';

const TEST_PATH = '/test/mcp-writes';

const write = defineTool({
  name: 'kinote_write_echo',
  scope: 'capture',
  limit: 'capture',
  writes: true,
  description: 'A write, for tests.',
  input: { text: z.string() },
  async run(args) {
    return args.text;
  },
});
const partly = defineTool({
  name: 'kinote_partly',
  scope: 'capture',
  limit: 'capture',
  description: 'Writes only for some actions.',
  input: { action: z.enum(['look', 'change']) },
  async run(args, ctx) {
    if (args.action === 'change') await ctx.assertWritable();
    return args.action;
  },
});
const read = defineTool({
  name: 'kinote_read_echo',
  scope: 'read',
  limit: 'search',
  description: 'A read, for tests.',
  input: { text: z.string() },
  async run(args) {
    return args.text;
  },
});

const deps = (): McpDeps => ({
  embeddingProvider: defaultEmbeddingProvider,
  answerProvider: defaultAnswerProvider,
  limits: TEST_LIMITS,
  searchMaxDistance: 0.55,
  meter: (_kind, _actor, fn) => fn(),
  version: 'test',
});

const SUSPENDED = 'This workspace is suspended for billing; it is read-only until the plan is renewed.';

describe('MCP write tools', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
    registerMcpRoute(app, deps(), { path: TEST_PATH, tools: [write, partly, read] });
  });

  async function suspend(tenantId: string) {
    await withTenantTx(tenantId, (tx) =>
      tx
        .insert(tenantBilling)
        .values({ tenantId, state: 'suspended' })
        .onConflictDoUpdate({ target: tenantBilling.tenantId, set: { state: 'suspended' } })
    );
  }

  test('a write tool is refused while suspended, a read tool is not', async () => {
    const w = await agentWorld(app, 'mcp-w-susp');
    const { token } = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['read', 'capture'] });
    await suspend(w.tenant.id);
    const refused = await callTool(app, token, 'kinote_write_echo', { text: 'x' }, TEST_PATH);
    assert.deepEqual(refused, { text: SUSPENDED, isError: true });
    assert.deepEqual(await callTool(app, token, 'kinote_read_echo', { text: 'y' }, TEST_PATH), { text: 'y', isError: false });
    assert.deepEqual(await callTool(app, token, 'kinote_partly', { action: 'look' }, TEST_PATH), { text: 'look', isError: false });
    assert.deepEqual(await callTool(app, token, 'kinote_partly', { action: 'change' }, TEST_PATH), { text: SUSPENDED, isError: true });
  });

  test('the capture limit is 10 a minute per agent', async () => {
    const w = await agentWorld(app, 'mcp-w-limit');
    const { token } = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['capture'] });
    for (let i = 0; i < 10; i++) {
      assert.equal((await callTool(app, token, 'kinote_write_echo', { text: String(i) }, TEST_PATH)).isError, false);
    }
    const eleventh = await callTool(app, token, 'kinote_write_echo', { text: '11' }, TEST_PATH);
    assert.equal(eleventh.isError, true);
    assert.match(eleventh.text, /^Too many kinote_write_echo calls\. Try again in \d+ seconds\.$/);
  });

  test('instructions mention capture only for capture tokens', () => {
    const readOnly = serverInstructions(['Docs'], ['read']);
    const capture = serverInstructions(['Docs'], ['read', 'capture']);
    assert.ok(!readOnly.includes('kinote_capture'));
    assert.ok(
      capture.includes(
        'Use kinote_capture to file new information; pass preview: true to show your user where it would go before anything changes. Use the source argument so a retry never files twice.'
      )
    );
    assert.match(capture, /Spaces you can read: Docs\.$/);
  });
});
