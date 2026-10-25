import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { chunks, documents, embeddingCache, spaces, tenants, versions, withTenantTx } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { DeterministicEmbeddingProvider, indexVersion } from '../src/index.js';
import { blocksFromMarkdown } from './fixtures/realBlocks.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

describe('indexVersion embedding cache hit', () => {
  it('re-indexing unchanged content reuses cached embeddings without throwing', async () => {
    const tenantId = randomUUID();
    const spaceId = randomUUID();
    const documentId = randomUUID();
    const actor = randomUUID();
    const v1 = randomUUID();
    const v2 = randomUUID();
    const provider = new DeterministicEmbeddingProvider();
    const blocks = await blocksFromMarkdown('Remote work is allowed three days per week.');

    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` });
      await tx.insert(spaces).values({ id: spaceId, tenantId, name: 's', slug: 's', createdBy: actor });
      await tx.insert(documents).values({
        id: documentId,
        tenantId,
        spaceId,
        kind: 'page',
        title: 'Policy',
        createdByType: 'user',
        createdBy: actor,
      });
      for (const [id, number] of [
        [v1, 1],
        [v2, 2],
      ] as const) {
        await tx.insert(versions).values({
          id,
          tenantId,
          documentId,
          number,
          title: 'Policy',
          status: 'indexing',
          contentHash: `h${number}`,
          reason: 'quiet',
          createdByType: 'user',
          createdBy: actor,
          markdown: 'Remote work is allowed three days per week.',
          blocks,
        });
      }
    });

    await indexVersion({ tenantId, versionId: v1 }, provider);
    expect(provider.callCount).toBe(1);

    await expect(indexVersion({ tenantId, versionId: v2 }, provider)).resolves.toEqual({ outcome: 'indexed' });
    expect(provider.callCount).toBe(1); // cache HIT: no new embed call

    const rows = await withTenantTx(tenantId, (tx) =>
      tx.select().from(chunks).where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].versionId).toBe(v2);
    expect(rows[0].blockIds).toEqual([blocks[0].id]);
    expect(rows[0].text).toBe('# Policy\n\nRemote work is allowed three days per week.');
    expect(Array.isArray(rows[0].embedding)).toBe(true);
    expect(rows[0].embedding).toHaveLength(2560);

    const cache = await withTenantTx(tenantId, (tx) =>
      tx.select().from(embeddingCache).where(eq(embeddingCache.tenantId, tenantId))
    );
    expect(cache).toHaveLength(1);
    expect(cache[0].embedding).toHaveLength(2560);
  });
});
