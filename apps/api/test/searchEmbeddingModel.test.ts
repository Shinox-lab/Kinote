import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { chunks, rowsOf, withTenantTx } from '@kinote/db';
import { defaultEmbeddingProvider, vectorBranchSql } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

// After the embedding model changes, chunks from the old model sit in another vector space: vector search skips
// them until their document is re-indexed. Full-text search still finds the document.

describe('search: only chunks from the current embedding model rank by vector', () => {
  const app = buildTestApp();
  useTestDb();

  test('search ignores chunks from another embedding model', async () => {
    const ctx = await bootstrapTenant(app, { name: 'Old model', slug: 'old-model' });
    const space = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ctx.headers, payload: { name: 'S', slug: 's', review_required: false } });
    const page = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: ctx.headers,
      payload: { space_id: space.json().id, title: 'Laptop policy', slug: 'laptop-policy', markdown: 'Laptops arrive on the first day.' },
    });
    await app.inject({ method: 'POST', url: `/api/v1/pages/${page.json().id}/snapshot`, headers: ctx.headers });
    await runPendingJobsForTenant(ctx.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    const [vector] = await defaultEmbeddingProvider.embed(['laptops']);
    const literal = `[${vector!.join(',')}]`;
    const filter = { tenantId: ctx.tenant.id, spaceIds: [space.json().id], inboxSpaceId: ctx.tenant.id, isTenantAdmin: true, me: '' };
    const vectorHits = (model: string) =>
      withTenantTx(ctx.tenant.id, async (tx) => rowsOf(await tx.execute(vectorBranchSql({ ...filter, embeddingModel: model }, literal))).length);

    expect(await vectorHits(defaultEmbeddingProvider.model)).toBeGreaterThan(0);
    await withTenantTx(ctx.tenant.id, (tx) => tx.update(chunks).set({ embeddingModel: 'old-model' }).where(eq(chunks.tenantId, ctx.tenant.id)));
    expect(await vectorHits(defaultEmbeddingProvider.model)).toBe(0);
    expect(await vectorHits('old-model')).toBeGreaterThan(0);

    // The search route passes the provider's model: the page is still found, by its words.
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: ctx.headers, payload: { query: 'laptops' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().passages.map((p: { documentId: string }) => p.documentId)).toContain(page.json().id);
  });
});
