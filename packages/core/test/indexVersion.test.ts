import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
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
import { AppError } from '@living-wiki/contracts';
import {
  chunkPageBlocks,
  DeterministicEmbeddingProvider,
  indexVersion,
  type Actor,
  type EmbeddingProvider,
} from '../src/index.js';
import { archivePage, withdrawPage } from '../../../apps/api/src/routes/pages.js';
import { searchWiki } from '../../../apps/api/src/search/hybridSearch.js';
import { blocksFromMarkdown } from './fixtures/realBlocks.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

/**
 * Wraps the deterministic provider: records every batch of texts, can run a
 * hook inside `embed` (before answering) and can be told to fail or to return
 * a malformed answer.
 */
class RecordingProvider implements EmbeddingProvider {
  private readonly inner = new DeterministicEmbeddingProvider();
  readonly model = this.inner.model;
  readonly dimensions = this.inner.dimensions;
  batches: string[][] = [];
  hook: ((texts: string[]) => Promise<void>) | undefined;
  failWith: Error | undefined;
  mangle: ((out: number[][]) => number[][]) | undefined;

  async embed(texts: string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    if (this.hook) await this.hook(texts);
    if (this.failWith) throw this.failWith;
    const out = await this.inner.embed(texts);
    return this.mangle ? this.mangle(out) : out;
  }
}

/** Rejects if `p` does not settle within `ms` (a held transaction would deadlock PGlite). */
function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms)
    ),
  ]);
}

const TITLE = 'Policy';
const MD_V1 =
  '# Remote\n\nRemote work is allowed three days per week.\n\n## Equipment\n\nLaptops are provided by the company.';
const MD_V2_EDIT =
  '# Remote\n\nRemote work is allowed three days per week.\n\n## Equipment\n\nLaptops and monitors are provided by the company.';

interface Seed {
  tenantId: string;
  spaceId: string;
  documentId: string;
  actor: Actor;
}

async function seedDocument(): Promise<Seed> {
  const tenantId = randomUUID();
  const spaceId = randomUUID();
  const documentId = randomUUID();
  const userId = randomUUID();
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: 't', slug: `t-${tenantId}` });
    await tx.insert(spaces).values({ id: spaceId, tenantId, name: 's', slug: 's', createdBy: userId });
    await tx.insert(documents).values({
      id: documentId,
      tenantId,
      spaceId,
      kind: 'page',
      title: TITLE,
      createdByType: 'user',
      createdBy: userId,
    });
  });
  return {
    tenantId,
    spaceId,
    documentId,
    actor: { tenantId, principalType: 'user', principalId: userId, tenantRole: 'owner' },
  };
}

type Status = (typeof versions.$inferSelect)['status'];

/** Adds version `number` of the document and makes it the latest version. */
async function addVersion(s: Seed, number: number, markdown: string, status: Status = 'indexing') {
  const id = randomUUID();
  const blocks = await blocksFromMarkdown(markdown);
  await withTenantTx(s.tenantId, async (tx) => {
    await tx.insert(versions).values({
      id,
      tenantId: s.tenantId,
      documentId: s.documentId,
      number,
      title: TITLE,
      status,
      contentHash: `h${number}-${id}`,
      reason: 'quiet',
      createdByType: 'user',
      createdBy: s.actor.principalId,
      markdown,
      blocks,
    });
    await tx
      .update(documents)
      .set({ latestVersionId: id })
      .where(and(eq(documents.tenantId, s.tenantId), eq(documents.id, s.documentId)));
  });
  return { id, blocks };
}

async function setStatus(s: Seed, versionId: string, status: Status) {
  await withTenantTx(s.tenantId, (tx) =>
    tx
      .update(versions)
      .set({ status })
      .where(and(eq(versions.tenantId, s.tenantId), eq(versions.id, versionId)))
  );
}

async function versionRow(s: Seed, versionId: string) {
  const [row] = await withTenantTx(s.tenantId, (tx) =>
    tx.select().from(versions).where(and(eq(versions.tenantId, s.tenantId), eq(versions.id, versionId)))
  );
  return row;
}

async function documentRow(s: Seed) {
  const [row] = await withTenantTx(s.tenantId, (tx) =>
    tx
      .select()
      .from(documents)
      .where(and(eq(documents.tenantId, s.tenantId), eq(documents.id, s.documentId)))
  );
  return row;
}

async function chunkRows(s: Seed) {
  return withTenantTx(s.tenantId, (tx) =>
    tx
      .select()
      .from(chunks)
      .where(and(eq(chunks.tenantId, s.tenantId), eq(chunks.documentId, s.documentId)))
      .orderBy(asc(chunks.ordinal))
  );
}

async function searchHitsForDocument(s: Seed, query: string) {
  const [embedding] = await new DeterministicEmbeddingProvider().embed([query]);
  const hits = await withTenantTx(s.tenantId, (tx) =>
    searchWiki(tx, s.actor, [s.spaceId], randomUUID(), query, embedding)
  );
  return hits.filter((h) => h.documentId === s.documentId);
}

describe('indexVersion (two-phase, locked)', () => {
  it('indexes an approved version: one chunk row per chunk, version indexed', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1);
    const provider = new RecordingProvider();

    const result = await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);

    expect(result).toEqual({ outcome: 'indexed' });
    const expected = chunkPageBlocks(TITLE, v1.blocks);
    expect(expected.length).toBeGreaterThan(1);
    const rows = await chunkRows(s);
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((r) => r.contentHash)).toEqual(expected.map((c) => c.contentHash));
    expect(rows.every((r) => r.versionId === v1.id && r.spaceId === s.spaceId)).toBe(true);
    const ver = await versionRow(s, v1.id);
    expect(ver.status).toBe('indexed');
    expect(ver.indexedAt).toBeInstanceOf(Date);
    expect((await documentRow(s)).indexedVersionId).toBe(v1.id);
  });

  it('re-indexing after editing one section embeds exactly one text', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1);
    const provider = new RecordingProvider();
    await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);
    expect(provider.batches).toHaveLength(1);

    const v2 = await addVersion(s, 2, MD_V2_EDIT);
    const result = await indexVersion({ tenantId: s.tenantId, versionId: v2.id }, provider);

    expect(result).toEqual({ outcome: 'indexed' });
    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]).toHaveLength(1);
    expect(provider.batches[1][0]).toContain('Laptops and monitors');
    const rows = await chunkRows(s);
    expect(rows).toHaveLength(chunkPageBlocks(TITLE, v2.blocks).length);
    expect(rows.every((r) => r.versionId === v2.id)).toBe(true);
    expect((await versionRow(s, v1.id)).status).toBe('superseded');
    expect((await versionRow(s, v2.id)).status).toBe('indexed');
  });

  it('a version withdrawn after approval is skipped and never gets chunks', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1);
    const provider = new RecordingProvider();
    await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);
    expect(await searchHitsForDocument(s, 'remote work')).not.toHaveLength(0);

    // v2 approved (status indexing, job queued), then the reviewer withdraws the page.
    const v2 = await addVersion(s, 2, MD_V2_EDIT);
    await withdrawPage(s.actor, s.documentId);
    expect((await versionRow(s, v2.id)).status).toBe('withdrawn');

    const result = await indexVersion({ tenantId: s.tenantId, versionId: v2.id }, provider);

    expect(result).toEqual({ outcome: 'skipped', reason: 'not_indexing' });
    expect(await chunkRows(s)).toHaveLength(0);
    expect(await searchHitsForDocument(s, 'remote work')).toHaveLength(0);
    expect((await versionRow(s, v2.id)).status).toBe('withdrawn');
    expect((await documentRow(s)).indexedVersionId).toBeNull();
  });

  it(
    'archiving the page while embedding is in flight skips the version and withdraws it',
    async () => {
      const s = await seedDocument();
      const v1 = await addVersion(s, 1, MD_V1);
      const provider = new RecordingProvider();
      await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);

      const v2 = await addVersion(s, 2, MD_V2_EDIT);
      provider.hook = async () => {
        provider.hook = undefined;
        await within(archivePage(s.actor, s.documentId), 3000, 'archivePage inside embed');
      };

      const result = await indexVersion({ tenantId: s.tenantId, versionId: v2.id }, provider);

      // archivePage withdraws every indexed/indexing/pending version itself, so
      // the commit phase finds v2 no longer indexing.
      expect(result).toEqual({ outcome: 'skipped', reason: 'not_indexing' });
      expect(await chunkRows(s)).toHaveLength(0);
      expect((await versionRow(s, v1.id)).status).toBe('withdrawn');
      expect((await versionRow(s, v2.id)).status).toBe('withdrawn');
      const doc = await documentRow(s);
      expect(doc.archivedAt).not.toBeNull();
      expect(doc.indexedVersionId).toBeNull();
    },
    5000
  );

  it(
    'withdrawing the page while embedding is in flight skips the version and leaves nothing searchable',
    async () => {
      const s = await seedDocument();
      const v1 = await addVersion(s, 1, MD_V1);
      const provider = new RecordingProvider();
      await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);
      expect(await searchHitsForDocument(s, 'remote work')).not.toHaveLength(0);

      const v2 = await addVersion(s, 2, MD_V2_EDIT);
      provider.hook = async () => {
        provider.hook = undefined;
        await within(withdrawPage(s.actor, s.documentId), 3000, 'withdrawPage inside embed');
      };

      const result = await indexVersion({ tenantId: s.tenantId, versionId: v2.id }, provider);

      expect(result).toEqual({ outcome: 'skipped', reason: 'not_indexing' });
      expect(await chunkRows(s)).toHaveLength(0);
      expect(await searchHitsForDocument(s, 'remote work')).toHaveLength(0);
      expect((await versionRow(s, v1.id)).status).toBe('withdrawn');
      expect((await versionRow(s, v2.id)).status).toBe('withdrawn');
      expect((await documentRow(s)).indexedVersionId).toBeNull();
    },
    5000
  );

  it('a stale job for an older version is skipped and the older version superseded', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1, 'pending_review');
    const v2 = await addVersion(s, 2, MD_V2_EDIT);
    const provider = new RecordingProvider();
    await indexVersion({ tenantId: s.tenantId, versionId: v2.id }, provider);
    const before = await chunkRows(s);
    expect(before.length).toBeGreaterThan(0);

    await setStatus(s, v1.id, 'indexing');
    const result = await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);

    expect(result).toEqual({ outcome: 'skipped', reason: 'older_than_indexed' });
    expect((await versionRow(s, v1.id)).status).toBe('superseded');
    expect((await versionRow(s, v2.id)).status).toBe('indexed');
    expect((await documentRow(s)).indexedVersionId).toBe(v2.id);
    const after = await chunkRows(s);
    expect(after.map((r) => [r.id, r.versionId])).toEqual(before.map((r) => [r.id, r.versionId]));
  });

  it('a provider failure rejects with embedding_unavailable and keeps the indexed version', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1);
    const provider = new RecordingProvider();
    await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);
    const before = await chunkRows(s);

    const v2 = await addVersion(s, 2, MD_V2_EDIT);
    provider.failWith = new Error('upstream 502 from embeddings');
    const err = await indexVersion({ tenantId: s.tenantId, versionId: v2.id }, provider).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('embedding_unavailable');
    expect((err as AppError).statusCode).toBe(503);
    expect(((err as Error).cause as Error).message).toBe('upstream 502 from embeddings');
    const after = await chunkRows(s);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.every((r) => r.versionId === v1.id)).toBe(true);
    expect((await versionRow(s, v1.id)).status).toBe('indexed');
    expect((await versionRow(s, v2.id)).status).toBe('indexing');
    expect((await documentRow(s)).indexedVersionId).toBe(v1.id);
  });

  it('a malformed provider answer is a NonRetryableError', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1);
    const provider = new RecordingProvider();
    provider.mangle = (out) => out.map((v) => v.slice(0, 10));

    const err = await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(NonRetryableError);
    expect(await chunkRows(s)).toHaveLength(0);
  });

  it(
    'holds no transaction while the provider is called',
    async () => {
      const s = await seedDocument();
      const v1 = await addVersion(s, 1, MD_V1);
      const provider = new RecordingProvider();
      let hookRan = false;
      provider.hook = async () => {
        await within(
          withTenantTx(s.tenantId, (tx) => tx.execute(sql`select 1`)),
          3000,
          'a transaction opened inside embed'
        );
        hookRan = true;
      };

      const result = await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);

      expect(hookRan).toBe(true);
      expect(result).toEqual({ outcome: 'indexed' });
    },
    5000
  );

  it('a version waiting for review is skipped without embedding', async () => {
    const s = await seedDocument();
    const v1 = await addVersion(s, 1, MD_V1, 'pending_review');
    const provider = new RecordingProvider();

    const result = await indexVersion({ tenantId: s.tenantId, versionId: v1.id }, provider);

    expect(result).toEqual({ outcome: 'skipped', reason: 'not_indexing' });
    expect(provider.batches).toHaveLength(0);
    expect(await chunkRows(s)).toHaveLength(0);
    expect((await versionRow(s, v1.id)).status).toBe('pending_review');
  });

  it('an unknown version is version_not_found', async () => {
    const s = await seedDocument();
    const err = await indexVersion(
      { tenantId: s.tenantId, versionId: randomUUID() },
      new RecordingProvider()
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('version_not_found');
  });
});
