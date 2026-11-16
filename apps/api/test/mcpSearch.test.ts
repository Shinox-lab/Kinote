import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { defaultEmbeddingProvider, type EmbeddingProvider } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, useTestDb } from './support/testkit.js';
import { agentWorld, callTool, mcpRequest, publishPage, unwrap, type AgentWorld } from './support/mcpkit.js';

const short = (id: string) => id.replaceAll('-', '').slice(0, 8);

/** Embeds documents normally, but every query fails: meaning search is down. */
const queriesFail: EmbeddingProvider = {
  model: defaultEmbeddingProvider.model,
  dimensions: defaultEmbeddingProvider.dimensions,
  embed: (texts, kind) => (kind === 'query' ? Promise.reject(new Error('provider down')) : defaultEmbeddingProvider.embed(texts)),
};

describe('kinote_search', () => {
  let app: ReturnType<typeof buildTestApp>;
  useTestDb();

  async function world(slug: string, opts: { publicUrl?: string; embeddingProvider?: EmbeddingProvider } = {}) {
    app = buildTestApp({ ...opts });
    const w = await agentWorld(app, slug);
    const laptop = await publishPage(
      app,
      w.ownerHeaders,
      w.open.id,
      'Laptop policy',
      '## Hardware\n\nNew starters receive a laptop on their first day. The laptop model is the ThinkPad X1 with code SKU-4471.\n\n## Returns\n\nReturn the laptop to IT when you leave.'
    );
    const secret = await publishPage(app, w.ownerHeaders, w.hidden.id, 'Laptop secrets', 'The secret laptop budget is twelve million.');
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    return { w, laptop, secret };
  }

  const search = (w: AgentWorld, args: object) => callTool(app, w.token, 'kinote_search', args);

  test('passages carry title, heading path, short id, block ids and content tags', async () => {
    const { w, laptop } = await world('mcp-search-passages', { publicUrl: 'https://wiki.example.com' });
    const res = await search(w, { query: 'laptop first day' });
    assert.equal(res.isError, false, res.text);
    const first = res.text.split('\n')[0]!;
    assert.match(first, new RegExp(`^1\\. ${short(laptop)}, v1, updated \\d{4}-\\d{2}-\\d{2}  https://wiki\\.example\\.com/w/mcp-search-passages/p/${laptop}$`));
    assert.ok(res.text.includes(`<kinote:content page="${short(laptop)}">\n# Laptop policy › Hardware\n\n`), res.text);
    assert.match(res.text, /\n {3}blocks: [0-9a-f]{8}(, [0-9a-f]{8})*\n/);
    assert.ok(res.text.includes(`<kinote:content page="${short(laptop)}">\n`));
    assert.ok(res.text.includes('New starters receive a laptop on their first day.'));
    assert.ok(res.text.includes('</kinote:content>'));
  });

  test('without PUBLIC_URL there are no links', async () => {
    const { w } = await world('mcp-search-nolink');
    const res = await search(w, { query: 'laptop' });
    assert.ok(!res.text.includes('http'));
  });

  test('an ungranted space never appears, and space limits results to that space', async () => {
    const { w } = await world('mcp-search-spaces');
    const res = await search(w, { query: 'laptop budget' });
    assert.ok(!res.text.includes('twelve million'));
    assert.ok(!res.text.includes('Laptop secrets'));
    const inStrict = await search(w, { query: 'laptop', space: 'Strict' });
    assert.match(inStrict.text, /^No passages match "laptop" in the spaces this agent can read\./);
    const hidden = await search(w, { query: 'laptop', space: 'Hidden' });
    assert.equal(hidden.isError, true);
    assert.equal(hidden.text, 'No space "Hidden". Spaces you can read: Open, Strict.');
  });

  test('an off-topic query returns the no-match text', async () => {
    const { w } = await world('mcp-search-offtopic');
    const res = await search(w, { query: 'volcano eruption forecast' });
    assert.equal(res.isError, false);
    assert.equal(
      res.text,
      'No passages match "volcano eruption forecast" in the spaces this agent can read. Try other words, or call kinote_browse to see what exists.'
    );
  });

  test('when the query cannot be embedded, keyword results come back with a note', async () => {
    const { w } = await world('mcp-search-keyword', { embeddingProvider: queriesFail });
    const res = await search(w, { query: 'SKU-4471' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /^Keyword-only results: meaning search is unavailable right now\.\n/);
    assert.ok(res.text.includes('SKU-4471'));
  });

  test('find "pages" lists a page by its card summary', async () => {
    const { w, laptop } = await world('mcp-search-pages');
    const res = await search(w, { query: 'laptop policy', find: 'pages' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /^<kinote:content source="results">\n/);
    assert.match(unwrap(res.text), new RegExp(`^1\\. Laptop policy \\(${short(laptop)}, Open\\) — .+`));
    assert.ok(!res.text.includes('Laptop secrets'));
  });

  test('limit is 1 to 10', async () => {
    const { w } = await world('mcp-search-limit');
    const res = await search(w, { query: 'laptop', limit: 11 });
    assert.equal(res.isError, true);
    assert.match(res.text, /^Invalid arguments for kinote_search: limit/);
    const ok = await search(w, { query: 'laptop', limit: 1 });
    assert.ok(!ok.text.includes('\n2. '));
  });

  test('the tool is listed with its description', async () => {
    const { w } = await world('mcp-search-list');
    const res = await mcpRequest(app, w.token, 'tools/list');
    const tool = res.body.result.tools.find((t: { name: string }) => t.name === 'kinote_search');
    assert.ok(tool);
    assert.match(tool.description, /^Search the wiki\./);
    assert.deepEqual(tool.inputSchema.required, ['query']);
  });

  test('ten long passages are not cut mid-passage: whole passages are left out and counted', async () => {
    const { w } = await world('mcp-search-budget');
    const section = (n: number) => `## Part ${n}\n\n` + Array.from({ length: 560 }, (_, i) => (i % 9 === 0 ? 'rollout.' : 'rollout')).join(' ');
    for (let p = 0; p < 6; p++) await publishPage(app, w.ownerHeaders, w.open.id, `Rollout ${p}`, [section(1), section(2)].join('\n\n'));
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    const res = await search(w, { query: 'rollout', limit: 10 });
    assert.equal(res.isError, false, res.text);
    assert.ok(!res.text.includes('[Result cut at'), 'not cut by the last-resort cap');
    assert.equal((res.text.match(/<kinote:content/g) ?? []).length, (res.text.match(/<\/kinote:content>/g) ?? []).length);
    assert.match(res.text, /\n\d+ more passages? left out to stay under 6,000 tokens\. Lower limit or narrow the query to see them\.$/);
  });
});
