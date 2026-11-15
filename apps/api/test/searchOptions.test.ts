import { describe, test, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { chunks, withTenantTx } from '@kinote/db';
import { EMBEDDING_DIMENSIONS, getReadableSpaceIds, keywordSearchWiki, searchWiki, type Actor, type EmbeddingProvider } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

/**
 * Unit vectors on fixed axes, so cosine distances are exact: a text containing "alpha" lies on axis 0,
 * "beta" on axis 1, "gamma" on axis 2; anything else on axis 9. Same axis: distance 0; another: 1.
 */
class AxisEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'axis-test-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      const axis = lower.includes('alpha') ? 0 : lower.includes('beta') ? 1 : lower.includes('gamma') ? 2 : 9;
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      v[axis] = 1;
      return v;
    });
  }
}

const words = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word}${i % 7 === 0 ? '.' : ''}`).join(' ');

describe('search options: relevance cutoff, per-page cap, keyword-only', () => {
  let app: ReturnType<typeof buildTestApp>;
  const provider = new AxisEmbeddingProvider();
  useTestDb();
  beforeEach(() => {
    app = buildTestApp({ embeddingProvider: provider });
  });

  async function world() {
    const ctx = await bootstrapTenant(app, { name: 'Opts', slug: 'opts' });
    const space = (
      await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ctx.headers, payload: { name: 'S', slug: 's', review_required: false } })
    ).json() as { id: string };
    const page = async (title: string, markdown: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/pages',
        headers: ctx.headers,
        payload: { space_id: space.id, title, slug: title.toLowerCase().replaceAll(' ', '-'), markdown },
      });
      assert.equal(res.statusCode, 201, res.body);
      const id = res.json().id as string;
      await app.inject({ method: 'POST', url: `/api/v1/pages/${id}/snapshot`, headers: ctx.headers });
      return id;
    };
    const alpha = await page('Alpha guide', 'The alpha rollout plan covers the alpha cohort.');
    const gamma = await page('Gamma widget', 'The gamma team ships the widget SKU-4471 every quarter.');
    const sections = Array.from({ length: 5 }, (_, i) => `## Beta part ${i + 1}\n\n${words('beta', 420)}`).join('\n\n');
    const beta = await page('Beta handbook', sections);
    await runPendingJobsForTenant(ctx.tenant.id, { embeddingProvider: provider });
    const actor: Actor = { tenantId: ctx.tenant.id, principalType: 'user', principalId: ctx.owner.userId, tenantRole: 'owner' };
    const search = async (query: string, opts?: Parameters<typeof searchWiki>[8], limit = 10) => {
      const [vec] = await provider.embed([query]);
      return withTenantTx(ctx.tenant.id, async (tx) => {
        const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
        return searchWiki(tx, actor, readableSpaceIds, inboxSpaceId, query, vec!, limit, provider.model, opts);
      });
    };
    const keyword = (query: string, opts?: { maxPerDocument?: number }) =>
      withTenantTx(ctx.tenant.id, async (tx) => {
        const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
        return keywordSearchWiki(tx, actor, readableSpaceIds, inboxSpaceId, query, 10, opts);
      });
    return { ctx, alpha, gamma, beta, search, keyword };
  }

  test('without options, results are the same as the search route and carry vector distances', async () => {
    const w = await world();
    const plain = await w.search('alpha');
    const empty = await w.search('alpha', {});
    assert.deepEqual(empty.map((p) => p.chunkId), plain.map((p) => p.chunkId));
    const route = await app.inject({ method: 'POST', url: '/api/v1/search', headers: w.ctx.headers, payload: { query: 'alpha', limit: 10 } });
    assert.equal(route.statusCode, 200, route.body);
    assert.deepEqual(route.json().passages.map((p: { chunkId: string }) => p.chunkId), plain.map((p) => p.chunkId));
    // Every chunk is a vector candidate (fewer than 40): far ones are still returned without a cutoff.
    assert.ok(plain.some((p) => p.documentId === w.gamma));
    const top = plain[0]!;
    assert.equal(top.documentId, w.alpha);
    assert.ok(top.vectorDistance !== null && top.vectorDistance < 0.01);
  });

  test('maxVectorDistance drops vector-only hits past the cutoff but keeps keyword hits', async () => {
    const w = await world();
    const alphaOnly = await w.search('alpha', { maxVectorDistance: 0.55 });
    assert.deepEqual([...new Set(alphaOnly.map((p) => p.documentId))], [w.alpha]);
    // "widget" is on no vector axis (distance 1 from every chunk), but the gamma page says it.
    const widget = await w.search('widget', { maxVectorDistance: 0.55 });
    assert.deepEqual([...new Set(widget.map((p) => p.documentId))], [w.gamma]);
  });

  test('an off-topic query with a cutoff returns []', async () => {
    const w = await world();
    assert.deepEqual(await w.search('zebra migration', { maxVectorDistance: 0.55 }), []);
    assert.ok((await w.search('zebra migration')).length > 0, 'without the cutoff the nearest noise comes back');
  });

  test('maxPerDocument: 2 keeps at most two chunks of a page that has five matching chunks', async () => {
    const w = await world();
    const all = await withTenantTx(w.ctx.tenant.id, (tx) => tx.select().from(chunks).where(eq(chunks.documentId, w.beta)));
    assert.ok(all.length >= 5, `beta has ${all.length} chunks`);
    const uncapped = await w.search('beta');
    assert.ok(uncapped.filter((p) => p.documentId === w.beta).length >= 5);
    const capped = await w.search('beta', { maxPerDocument: 2 });
    assert.equal(capped.filter((p) => p.documentId === w.beta).length, 2);
    // The two kept are the page's best two, in rank order.
    const best = uncapped.filter((p) => p.documentId === w.beta).slice(0, 2).map((p) => p.chunkId);
    assert.deepEqual(capped.filter((p) => p.documentId === w.beta).map((p) => p.chunkId), best);
  });

  test('keywordSearchWiki finds an exact product code and returns vectorDistance null', async () => {
    const w = await world();
    const hits = await w.keyword('SKU-4471');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.documentId, w.gamma);
    assert.equal(hits[0]!.vectorDistance, null);
    assert.match(hits[0]!.citeAs, /^Gamma widget \(v1, updated \d{4}-\d{2}-\d{2}\)$/);
    assert.equal((await w.keyword('beta', { maxPerDocument: 2 })).length, 2);
    assert.deepEqual(await w.keyword('zebra'), []);
  });
});
