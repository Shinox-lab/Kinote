import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import { defaultAnswerProvider, defaultEmbeddingProvider } from '@kinote/core';
import { registerMcpRoute, type McpDeps } from '../src/mcp/route.js';
import { defineTool, MCP_UPLOAD_PER_MINUTE } from '../src/mcp/tool.js';
import type { AppResource } from '../src/mcp/resources.js';
import { buildTestApp, TEST_LIMITS, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, mcpRequest } from './support/mcpkit.js';

const PATH = '/test/mcp-apps';

const panelTool = defineTool({
  name: 'kinote_panel',
  annotations: { title: 'Test tool', readOnlyHint: false, openWorldHint: false },
  scope: 'read',
  limit: 'search',
  meta: { ui: { resourceUri: 'ui://t/x', visibility: ['app'] } },
  description: 'Shows a panel.',
  input: {},
  async run() {
    return { text: 'hi', structured: { a: 1 } };
  },
});
const plainTool = defineTool({
  name: 'kinote_plain',
  annotations: { title: 'Test tool', readOnlyHint: false, openWorldHint: false },
  scope: 'read',
  limit: 'upload',
  description: 'Plain.',
  input: {},
  async run() {
    return 'plain';
  },
});
const resource: AppResource = {
  uri: 'ui://t/x',
  name: 'Test panel',
  description: 'A test panel.',
  html: async () => '<p>x</p>',
};

function deps(): McpDeps {
  return {
    embeddingProvider: defaultEmbeddingProvider,
    answerProvider: defaultAnswerProvider,
    limits: TEST_LIMITS,
    searchMaxDistance: 0.55,
    meter: (_kind, _actor, fn) => fn(),
    version: 'test',
  };
}

describe('MCP Apps plumbing', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();
  beforeEach(() => {
    app = buildTestApp();
    registerMcpRoute(app, deps(), { path: PATH, tools: [panelTool, plainTool], resources: [resource] });
  });

  test('tools/list carries a tool _meta, and none on a tool without meta', async () => {
    const w = await agentWorld(app, 'apps-meta');
    const res = await mcpRequest(app, w.token, 'tools/list', undefined, PATH);
    const tools = res.body.result.tools as Array<{ name: string; _meta?: unknown }>;
    assert.deepEqual(tools.find((t) => t.name === 'kinote_panel')!._meta, { ui: { resourceUri: 'ui://t/x', visibility: ['app'] } });
    assert.equal('_meta' in tools.find((t) => t.name === 'kinote_plain')!, false);
  });

  test('a structured result answers text and structuredContent', async () => {
    const w = await agentWorld(app, 'apps-structured');
    const res = await mcpRequest(app, w.token, 'tools/call', { name: 'kinote_panel', arguments: {} }, PATH);
    assert.equal(res.body.result.content[0].text, 'hi');
    assert.deepEqual(res.body.result.structuredContent, { a: 1 });
  });

  test('the upload limit allows MCP_UPLOAD_PER_MINUTE calls a minute', async () => {
    assert.equal(MCP_UPLOAD_PER_MINUTE, 120);
    const w = await agentWorld(app, 'apps-upload-limit');
    for (let i = 0; i < 120; i++) assert.equal((await callTool(app, w.token, 'kinote_plain', {}, PATH)).isError, false);
    const over = await callTool(app, w.token, 'kinote_plain', {}, PATH);
    assert.equal(over.isError, true);
    assert.match(over.text, /^Too many kinote_plain calls/);
  });

  test('resources/list and resources/read serve the panel with the app mime type', async () => {
    const w = await agentWorld(app, 'apps-resources');
    const list = await mcpRequest(app, w.token, 'resources/list', undefined, PATH);
    assert.deepEqual(list.body.result.resources, [
      { uri: 'ui://t/x', name: 'Test panel', description: 'A test panel.', mimeType: 'text/html;profile=mcp-app' },
    ]);
    const read = await mcpRequest(app, w.token, 'resources/read', { uri: 'ui://t/x' }, PATH);
    const content = read.body.result.contents[0];
    assert.equal(content.text, '<p>x</p>');
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.equal(content._meta.ui.prefersBorder, true);
    const missing = await mcpRequest(app, w.token, 'resources/read', { uri: 'ui://nope' }, PATH);
    assert.match(JSON.stringify(missing.body.error), /Resource not found/);
  });
});

