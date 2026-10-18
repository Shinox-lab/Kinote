import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  chunks,
  documents,
  NonRetryableError,
  spaces,
  tenants,
  versions,
  withTenantTx,
} from '@living-wiki/db';
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

async function seedVersion(blocks: unknown, markdown: string) {
  const tenantId = randomUUID();
  const spaceId = randomUUID();
  const documentId = randomUUID();
  const versionId = randomUUID();
  const actor = randomUUID();
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` });
    await tx.insert(spaces).values({ id: spaceId, tenantId, name: 's', slug: 's', createdBy: actor });
    await tx.insert(documents).values({
      id: documentId,
      tenantId,
      spaceId,
      kind: 'page',
      title: 'Doc',
      createdByType: 'user',
      createdBy: actor,
    });
    await tx.insert(versions).values({
      id: versionId,
      tenantId,
      documentId,
      number: 1,
      title: 'Doc',
      status: 'indexing',
      contentHash: 'h1',
      reason: 'quiet',
      createdByType: 'user',
      createdBy: actor,
      markdown,
      blocks: blocks as never,
    });
  });
  return { tenantId, documentId, versionId };
}

describe('indexVersion with real blocks', () => {
  it('stores one chunk per heading section with the real block ids', async () => {
    const blocks = await blocksFromMarkdown('# Alpha\n\npara a\n\n## Beta\n\npara b');
    const { tenantId, documentId, versionId } = await seedVersion(blocks, 'ignored');
    await indexVersion({ tenantId, versionId }, new DeterministicEmbeddingProvider());

    const rows = await withTenantTx(tenantId, (tx) =>
      tx
        .select()
        .from(chunks)
        .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
        .orderBy(asc(chunks.ordinal))
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].headingPath).toEqual(['Alpha']);
    expect(rows[1].headingPath).toEqual(['Alpha', 'Beta']);
    expect(rows[0].blockIds).toEqual([blocks[0].id, blocks[1].id]);
    expect(rows[1].blockIds).toEqual([blocks[2].id, blocks[3].id]);
    expect(rows.every((r) => r.text.startsWith('# Doc > Alpha'))).toBe(true);
  });

  it('throws NonRetryableError when the version has no blocks', async () => {
    const { tenantId, versionId } = await seedVersion(null, 'some markdown');
    const err = await indexVersion({ tenantId, versionId }, new DeterministicEmbeddingProvider()).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toBe('version has no blocks');
  });

  it('throws NonRetryableError when the version is blank', async () => {
    const blocks = await blocksFromMarkdown('   \n\n  ');
    const { tenantId, versionId } = await seedVersion(blocks, '');
    const err = await indexVersion({ tenantId, versionId }, new DeterministicEmbeddingProvider()).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err.message).toBe('version has no indexable content');
  });
});
