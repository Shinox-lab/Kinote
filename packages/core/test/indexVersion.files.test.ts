import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { chunks, documents, NonRetryableError, versions, withTenantTx } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import {
  DeterministicEmbeddingProvider,
  FakeExtractor,
  extractVersion,
  indexVersion,
  type EmbeddingProvider,
} from '../src/index.js';
import { seedFileDocument, uploadFixtureFile, type FileSeed } from './fixtures/fileSeed.js';

let testDb: TestDb;
let storage: InMemoryObjectStorage;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  storage = new InMemoryObjectStorage();
});

const section = (headingPath: string[], page: number, text: string) => ({
  headingPath, pageFrom: page, pageTo: page, kind: 'text', text,
});
/** A "PDF" whose fake extraction is the given sections. */
const pdf = (...sections: ReturnType<typeof section>[]) =>
  `%PDF-1.7\nFAKE-EXTRACT\n${JSON.stringify({ pageCount: sections.length, ocrUsed: false, sections })}`;

/** Uploads, extracts and returns a version that is `indexing` (a space without review). */
async function ready(seed: FileSeed, name: string, content: string) {
  const v = await uploadFixtureFile(seed, storage, name, content);
  const done = await extractVersion(
    { tenantId: seed.tenantId, versionId: v.id },
    { storage, extractor: new FakeExtractor(), maxChars: 1_000_000 }
  );
  expect(done).toEqual({ outcome: 'extracted', status: 'indexing' });
  return v;
}

const chunksOf = (seed: FileSeed) =>
  withTenantTx(seed.tenantId, (tx) =>
    tx.select().from(chunks).where(eq(chunks.tenantId, seed.tenantId)).orderBy(asc(chunks.ordinal))
  );
const versionRow = (seed: FileSeed, id: string) =>
  withTenantTx(seed.tenantId, async (tx) => {
    const [row] = await tx.select().from(versions).where(and(eq(versions.tenantId, seed.tenantId), eq(versions.id, id)));
    return row!;
  });

const TWO_PAGES = pdf(
  section(['Leave'], 1, 'Staff accrue one and a half days of annual leave each month.'),
  section(['Expenses'], 2, 'Receipts must be submitted within thirty days of travel.')
);

describe('indexVersion for file versions', () => {
  it('indexes the extracted text with page numbers and no block ids', async () => {
    const seed = await seedFileDocument();
    const v = await ready(seed, 'handbook.pdf', TWO_PAGES);
    const provider = new DeterministicEmbeddingProvider();
    expect(await indexVersion({ tenantId: seed.tenantId, versionId: v.id }, provider, { storage })).toEqual({
      outcome: 'indexed',
    });
    const rows = await chunksOf(seed);
    expect(rows.map((r) => [r.headingPath, r.pageFrom, r.pageTo, r.blockIds])).toEqual([
      [['Leave'], 1, 1, []],
      [['Expenses'], 2, 2, []],
    ]);
    expect(rows[0]!.text).toBe('# handbook.pdf > Leave\n\nStaff accrue one and a half days of annual leave each month.');
    expect(rows.every((r) => r.spaceId === seed.spaceId && r.inboxOwner === null)).toBe(true);
    expect((await versionRow(seed, v.id)).status).toBe('indexed');
    const [doc] = await withTenantTx(seed.tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, seed.documentId)));
    expect(doc).toMatchObject({ indexedVersionId: v.id, title: 'handbook.pdf' });
  });

  it('stamps the creator on the chunks of a file in the Inbox', async () => {
    const seed = await seedFileDocument({ spaceKind: 'inbox' });
    const v = await ready(seed, 'handbook.pdf', TWO_PAGES);
    await indexVersion({ tenantId: seed.tenantId, versionId: v.id }, new DeterministicEmbeddingProvider(), { storage });
    expect((await chunksOf(seed)).every((r) => r.inboxOwner === `user:${seed.userId}`)).toBe(true);
  });

  it('reuses cached embeddings for text it has already embedded', async () => {
    const seed = await seedFileDocument();
    const provider = new DeterministicEmbeddingProvider();
    const v1 = await ready(seed, 'handbook.pdf', TWO_PAGES);
    await indexVersion({ tenantId: seed.tenantId, versionId: v1.id }, provider, { storage });
    expect(provider.callCount).toBe(1);
    const v2 = await ready(seed, 'handbook.pdf', `${TWO_PAGES}\n`);
    await indexVersion({ tenantId: seed.tenantId, versionId: v2.id }, provider, { storage });
    expect(provider.callCount).toBe(1);
  });

  it('replaces the old version only when the new one is indexed, in one step', async () => {
    const seed = await seedFileDocument();
    const provider = new DeterministicEmbeddingProvider();
    const v1 = await ready(seed, 'handbook.pdf', TWO_PAGES);
    await indexVersion({ tenantId: seed.tenantId, versionId: v1.id }, provider, { storage });
    const v2 = await ready(
      seed,
      'handbook-2026.pdf',
      pdf(section(['Leave'], 1, 'Staff now accrue two days of annual leave each month.'))
    );
    expect((await chunksOf(seed)).every((r) => r.versionId === v1.id)).toBe(true);
    await indexVersion({ tenantId: seed.tenantId, versionId: v2.id }, provider, { storage });
    const rows = await chunksOf(seed);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ versionId: v2.id });
    expect((await versionRow(seed, v1.id)).status).toBe('superseded');
    const [doc] = await withTenantTx(seed.tenantId, (tx) => tx.select().from(documents).where(eq(documents.id, seed.documentId)));
    expect(doc).toMatchObject({ indexedVersionId: v2.id, title: 'handbook-2026.pdf' });
  });

  it('keeps the old chunks when the embedding service fails for the new version', async () => {
    const seed = await seedFileDocument();
    const v1 = await ready(seed, 'handbook.pdf', TWO_PAGES);
    await indexVersion({ tenantId: seed.tenantId, versionId: v1.id }, new DeterministicEmbeddingProvider(), { storage });
    const v2 = await ready(seed, 'handbook.pdf', pdf(section([], 1, 'A completely different sentence.')));
    const down: EmbeddingProvider = {
      model: 'living-wiki-deterministic-2560-v1',
      dimensions: 2560,
      embed: async () => {
        throw new Error('down');
      },
    };
    await expect(indexVersion({ tenantId: seed.tenantId, versionId: v2.id }, down, { storage })).rejects.toMatchObject({
      code: 'embedding_unavailable',
    });
    expect((await chunksOf(seed)).every((r) => r.versionId === v1.id)).toBe(true);
    expect((await versionRow(seed, v1.id)).status).toBe('indexed');
  });

  it('cannot index a file version without object storage', async () => {
    const seed = await seedFileDocument();
    const v = await ready(seed, 'handbook.pdf', TWO_PAGES);
    await expect(
      indexVersion({ tenantId: seed.tenantId, versionId: v.id }, new DeterministicEmbeddingProvider())
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('a file version of a document removed at its source is withdrawn and writes no chunks', async () => {
    const seed = await seedFileDocument();
    const v = await ready(seed, 'a.pdf', TWO_PAGES);
    await withTenantTx(seed.tenantId, (tx) =>
      tx.update(documents).set({ sourceDeletedAt: new Date() }).where(eq(documents.id, seed.documentId))
    );
    const result = await indexVersion(
      { tenantId: seed.tenantId, versionId: v.id },
      new DeterministicEmbeddingProvider(),
      { storage }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: 'source_deleted' });
    expect((await versionRow(seed, v.id)).status).toBe('withdrawn');
    expect(await chunksOf(seed)).toEqual([]);
  });
});
