import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import {
  assertEmbeddingDimensions,
  chunks,
  documents,
  embeddingCache,
  getDb,
  halfvecCodec,
  spaces,
  tenants,
  versions,
  withTenantTx,
} from '../src/index.js';

const DIMS = 1536;
const pattern = (): number[] => Array.from({ length: DIMS }, (_, i) => ((i % 17) - 8) / 16);

beforeEach(async () => {
  const { reset } = await createTestDb();
  await reset();
});

function expectClose(actual: number[], expected: number[]): void {
  expect(Array.isArray(actual)).toBe(true);
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThan(1e-3);
  }
}

describe('halfvec custom type', () => {
  const col = halfvecCodec;

  it('encodes to the [a,b,...] literal', () => {
    expect(col.toDriver([0.5, -1, 2.25])).toBe('[0.5,-1,2.25]');
  });

  it('decodes the text form, tolerating whitespace', () => {
    expect(col.fromDriver('[0.5,-1,2.25]')).toEqual([0.5, -1, 2.25]);
    expect(col.fromDriver(' [ 0.5 , -1,\n2.25 ] ')).toEqual([0.5, -1, 2.25]);
    expect(col.fromDriver('[]')).toEqual([]);
  });

  it('passes an already parsed array through', () => {
    expect(col.fromDriver([0.5, -1, 2.25])).toEqual([0.5, -1, 2.25]);
  });
});

describe('halfvec round trip through Drizzle', () => {
  async function seedVersion() {
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
        status: 'indexed',
        contentHash: 'h',
        reason: 'quiet',
        createdByType: 'user',
        createdBy: actor,
      });
    });
    return { tenantId, spaceId, documentId, versionId };
  }

  it('chunks.embedding reads back as number[] of length 1536', async () => {
    const s = await seedVersion();
    const embedding = pattern();
    await withTenantTx(s.tenantId, (tx) =>
      tx
        .insert(chunks)
        .values({
          tenantId: s.tenantId,
          spaceId: s.spaceId,
          documentId: s.documentId,
          versionId: s.versionId,
          ordinal: 0,
          headingPath: [],
          blockIds: ['b1'],
          text: 'hello',
          tokenCount: 1,
          contentHash: 'c',
          embedding,
          embeddingModel: 'm',
        })
        .then(() => undefined)
    );
    const [row] = await withTenantTx(s.tenantId, (tx) =>
      tx.select().from(chunks).where(eq(chunks.tenantId, s.tenantId))
    );
    expectClose(row.embedding, embedding);
  });

  it('embedding_cache.embedding reads back as number[] of length 1536', async () => {
    const s = await seedVersion();
    const embedding = new Array<number>(DIMS).fill(0.25);
    await withTenantTx(s.tenantId, (tx) =>
      tx
        .insert(embeddingCache)
        .values({ tenantId: s.tenantId, model: 'm', contentHash: 'c', embedding })
        .then(() => undefined)
    );
    const [row] = await withTenantTx(s.tenantId, (tx) =>
      tx.select().from(embeddingCache).where(eq(embeddingCache.tenantId, s.tenantId))
    );
    expectClose(row.embedding, embedding);
  });
});

describe('assertEmbeddingDimensions', () => {
  it('resolves when the declared dimension matches', async () => {
    await expect(assertEmbeddingDimensions(getDb(), 1536)).resolves.toBeUndefined();
  });

  it('rejects naming the declared type and the expected dimension', async () => {
    const err = await assertEmbeddingDimensions(getDb(), 768).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('halfvec(1536)');
    expect((err as Error).message).toContain('768');
  });
});
