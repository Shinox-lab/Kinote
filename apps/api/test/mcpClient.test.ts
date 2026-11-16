import { describe, test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agents, auditEvents, withTenantTx } from '@kinote/db';
import { defaultEmbeddingProvider } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, createAgent, useTestDb } from './support/testkit.js';
import { agentWorld, issueAgentToken, publishPage } from './support/mcpkit.js';
import { useCaptureKit } from './support/capturekit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join('\n');

/** The MCP SDK's own client, over real HTTP, as Claude Code and other clients connect. */
describe('a real MCP client over HTTP', () => {
  useTestDb();
  let app: ReturnType<typeof buildTestApp> | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await app?.close();
  });

  test('connects with an agent token and uses every read tool', async () => {
    app = buildTestApp();
    const w = await agentWorld(app, 'real-client');
    const page = await publishPage(
      app,
      w.ownerHeaders,
      w.open.id,
      'Onboarding',
      '## Laptops\n\nNew starters receive a laptop on their first day.\n\n## Accounts\n\nIT creates accounts the week before.'
    );
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    client = new Client({ name: 'kinote-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { authorization: `Bearer ${w.token}` } } })
    );
    assert.match(client.getInstructions() ?? '', /Spaces you can read: Open, Strict\./);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['kinote_ask', 'kinote_browse', 'kinote_read', 'kinote_related', 'kinote_search']);

    const map = textOf(await client.callTool({ name: 'kinote_browse', arguments: {} }));
    assert.ok(map.includes(`- Onboarding (${short(page)})`), map);
    const found = textOf(await client.callTool({ name: 'kinote_search', arguments: { query: 'laptop first day' } }));
    assert.ok(found.includes('New starters receive a laptop'), found);
    const outline = textOf(await client.callTool({ name: 'kinote_read', arguments: { page_id: short(page) } }));
    const section = /## Accounts {2}\[([0-9a-f]{8})\]/.exec(outline)![1]!;
    const accounts = textOf(await client.callTool({ name: 'kinote_read', arguments: { page_id: short(page), level: 'section', section_id: section } }));
    assert.ok(accounts.includes('IT creates accounts') && !accounts.includes('laptop on their first day'), accounts);
    const rel = await client.callTool({ name: 'kinote_related', arguments: { page_id: short(page) } });
    assert.equal(rel.isError ?? false, false, textOf(rel));
    const answer = textOf(await client.callTool({ name: 'kinote_ask', arguments: { question: 'When do new starters get a laptop?' } }));
    assert.match(answer, /\nSources:\n- Onboarding \(v1/);

    const rows = await withTenantTx(w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.type, 'mcp.tool_call'), eq(auditEvents.actorId, w.agentId)))
    );
    assert.equal(rows.length, 6);
  });
});

describe('a real MCP client files a capture', () => {
  const k = useCaptureKit();
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  test('a real client previews, applies and undoes a capture', async () => {
    const w = await k.world('real-capture');
    const agentId = await createAgent(w.tenant.id, w.owner.userId, { name: 'Laptop agent' });
    await withTenantTx(w.tenant.id, (tx) => tx.update(agents).set({ alwaysReview: false }).where(eq(agents.id, agentId)));
    await k.post(w.headers, `/api/v1/spaces/${w.clients}/grants`, { principal_type: 'agent', principal_id: agentId, role: 'editor' });
    const { token } = await issueAgentToken(w.tenant.id, agentId, { scopes: ['read', 'capture'] });
    const address = await k.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      client = new Client({ name: 'kinote-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      assert.match(client.getInstructions() ?? '', /Use kinote_capture to file new information/);
      assert.equal((await client.listTools()).tools.length, 7);

      setTimeout(() => void w.run(), 100);
      const previewed = textOf(
        await client.callTool({ name: 'kinote_capture', arguments: { text: 'George launch moved to December.', preview: true, wait: true } })
      );
      assert.match(previewed, /^Capture [0-9a-f]{8} · preview ready/);
      const id = /^Capture ([0-9a-f]{8})/.exec(previewed)![1]!;
      assert.equal(await k.pageText(w.tenant.id, w.george), 'George is a client. Launch is in November.');

      const applied = textOf(await client.callTool({ name: 'kinote_capture_action', arguments: { capture_id: id, action: 'apply' } }));
      assert.match(applied, /^Applying the preview/);
      let status = '';
      for (let i = 0; i < 20 && !/· done/.test(status.split('\n')[0] ?? ''); i++) {
        await w.run();
        status = textOf(await client.callTool({ name: 'kinote_capture_action', arguments: { capture_id: id, action: 'status' } }));
      }
      assert.match(status, /^Capture [0-9a-f]{8} · done/);
      assert.ok((await k.pageText(w.tenant.id, w.george)).includes('December'));

      const undone = textOf(await client.callTool({ name: 'kinote_capture_action', arguments: { capture_id: id, action: 'undo' } }));
      assert.match(undone, /^Undone: 1 change;/);
      assert.equal(await k.pageText(w.tenant.id, w.george), 'George is a client. Launch is in November.');
    } finally {
      await client?.close().catch(() => undefined);
      client = undefined;
      await k.app.close();
    }
  });
});
