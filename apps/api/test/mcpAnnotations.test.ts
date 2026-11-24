import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, issueAgentToken, mcpRequest } from './support/mcpkit.js';

type Listed = { name: string; annotations?: { title?: unknown; readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown } };

/** Every tool tells MCP clients whether it only reads, so read tools can default to "always allow". */
describe('MCP tool annotations', () => {
  useTestDb();

  async function listed(): Promise<Map<string, Listed>> {
    const app = buildTestApp();
    const w = await agentWorld(app, 'annotations');
    const { token } = await issueAgentToken(w.tenant.id, w.agentId, { scopes: ['read', 'capture', 'edit'] });
    const res = await mcpRequest(app, token, 'tools/list');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return new Map((res.body.result.tools as Listed[]).map((t) => [t.name, t]));
  }

  test('every listed tool has annotations with a title and openWorldHint false', async () => {
    const tools = await listed();
    assert.ok(tools.size > 10);
    for (const t of tools.values()) {
      assert.ok(t.annotations, `${t.name} has no annotations`);
      assert.equal(typeof t.annotations.title, 'string', t.name);
      assert.equal(t.annotations.openWorldHint, false, t.name);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    }
  });

  test('read tools are read-only and kinote_delete is destructive', async () => {
    const tools = await listed();
    const hint = (name: string) => {
      const t = tools.get(name);
      assert.ok(t, `${name} is not listed`);
      return t.annotations!;
    };
    for (const name of ['kinote_browse', 'kinote_search', 'kinote_read', 'kinote_related', 'kinote_ask', 'kinote_review', 'kinote_review_list']) {
      assert.equal(hint(name).readOnlyHint, true, name);
    }
    const writers = [
      'kinote_capture',
      'kinote_capture_action',
      'kinote_edit',
      'kinote_create',
      'kinote_move',
      'kinote_restore',
      'kinote_delete',
      'kinote_review_decide',
      ...[...tools.keys()].filter((n) => n.startsWith('kinote_upload')),
    ];
    for (const name of writers) assert.equal(hint(name).readOnlyHint, false, name);
    assert.equal(hint('kinote_delete').destructiveHint, true);
    assert.equal(hint('kinote_edit').destructiveHint, false);
  });
});
