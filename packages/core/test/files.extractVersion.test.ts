import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, documents, jobs, sources, versions, withTenantTx } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { AppError } from '@living-wiki/contracts';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor, extractVersion, fileObjectPath, type Extractor } from '../src/index.js';
import { seedFileDocument, seedSource, uploadFixtureFile, type FileSeed } from './fixtures/fileSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const enc = (s: string) => new TextEncoder().encode(s);
const deps = (over: Partial<{ extractor: Extractor; maxChars: number }> = {}) => ({
  storage,
  extractor: new FakeExtractor(),
  maxChars: 1_000_000,
  ...over,
});
let storage: InMemoryObjectStorage;
beforeEach(() => {
  storage = new InMemoryObjectStorage();
});

const upload = (
  seed: FileSeed,
  name: string,
  content: string | Uint8Array,
  actorType: 'user' | 'agent' | 'connector' = 'user',
  actorId?: string
) => uploadFixtureFile(seed, storage, name, content, actorType, actorId);

const reload = (seed: FileSeed, id: string) =>
  withTenantTx(seed.tenantId, async (tx) => {
    const [row] = await tx.select().from(versions).where(and(eq(versions.tenantId, seed.tenantId), eq(versions.id, id)));
    return row!;
  });
const jobsOf = (seed: FileSeed, queue: string) =>
  withTenantTx(seed.tenantId, (tx) =>
    tx.select().from(jobs).where(and(eq(jobs.tenantId, seed.tenantId), eq(jobs.queue, queue)))
  );

describe('extractVersion', () => {
  it('reads a text file in the worker and sends it straight to indexing in a space without review', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'hello world');
    const result = await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps());
    expect(result).toEqual({ outcome: 'extracted', status: 'indexing' });
    const row = await reload(seed, v.id);
    expect(row.status).toBe('indexing');
    expect(row.extractedKey).toBe(`${seed.tenantId}/${fileObjectPath(seed.documentId, v.id, 'extracted.json')}`);
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(seed.tenantId, row.extractedKey!)).bytes));
    expect(stored.sections[0].text).toBe('hello world');
    const [job] = await jobsOf(seed, 'version.index');
    expect(job).toMatchObject({ idempotencyKey: `index:${v.id}`, payload: { versionId: v.id } });
  });

  it('holds the version for review in a review space', async () => {
    const seed = await seedFileDocument({ reviewRequired: true, title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'hello');
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps())).toEqual({
      outcome: 'extracted',
      status: 'pending_review',
    });
    expect((await reload(seed, v.id)).status).toBe('pending_review');
    expect(await jobsOf(seed, 'version.index')).toEqual([]);
  });

  it('always holds an agent version, and a connector version, for review', async () => {
    for (const actor of ['agent', 'connector'] as const) {
      const seed = await seedFileDocument({ title: 'notes.txt' });
      const v = await upload(seed, 'notes.txt', 'hello', actor);
      await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps());
      expect((await reload(seed, v.id)).status).toBe('pending_review');
    }
  });

  it('removes NUL characters from what an extractor returns (Postgres text cannot hold them)', async () => {
    const seed = await seedFileDocument({ title: 'scan.pdf' });
    const v = await upload(seed, 'scan.pdf', '%PDF-1.7\nFAKE-EXTRACT\nplaceholder');
    const extractor: Extractor = {
      extract: async () => ({
        pageCount: 1,
        ocrUsed: false,
        sections: [{ headingPath: ['Chap\u0000ter'], pageFrom: 1, pageTo: 1, kind: 'text', text: 'before\u0000after\u0000' }],
      }),
    };
    const result = await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps({ extractor }));
    expect(result).toEqual({ outcome: 'extracted', status: 'indexing' });
    const row = await reload(seed, v.id);
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(seed.tenantId, row.extractedKey!)).bytes));
    expect(stored.sections[0].text).toBe('beforeafter');
    expect(stored.sections[0].headingPath).toEqual(['Chapter']);
  });

  describe('the trusted switch', () => {
    const extract = (seed: FileSeed, id: string) => extractVersion({ tenantId: seed.tenantId, versionId: id }, deps());

    it('sends a trusted source\'s version straight to indexing in a space without review', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt' });
      const source = await seedSource(seed, { trusted: true });
      const v = await upload(seed, 'notes.txt', 'hello', 'connector', source);
      expect(await extract(seed, v.id)).toEqual({ outcome: 'extracted', status: 'indexing' });
      expect(await jobsOf(seed, 'version.index')).toHaveLength(1);
    });

    it('holds an untrusted source\'s version for review', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt' });
      const source = await seedSource(seed, { trusted: false });
      const v = await upload(seed, 'notes.txt', 'hello', 'connector', source);
      expect(await extract(seed, v.id)).toEqual({ outcome: 'extracted', status: 'pending_review' });
      expect(await jobsOf(seed, 'version.index')).toEqual([]);
    });

    it('still holds a trusted source\'s version when the space requires review', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt', reviewRequired: true });
      const source = await seedSource(seed, { trusted: true });
      const v = await upload(seed, 'notes.txt', 'hello', 'connector', source);
      expect(await extract(seed, v.id)).toEqual({ outcome: 'extracted', status: 'pending_review' });
    });

    it('never lets an agent skip review, whatever id it carries', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt' });
      const source = await seedSource(seed, { trusted: true });
      const v = await upload(seed, 'notes.txt', 'hello', 'agent', source);
      expect(await extract(seed, v.id)).toEqual({ outcome: 'extracted', status: 'pending_review' });
    });

    it('treats a connector version whose source is unknown as untrusted', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt' });
      const v = await upload(seed, 'notes.txt', 'hello', 'connector', randomUUID());
      expect(await extract(seed, v.id)).toEqual({ outcome: 'extracted', status: 'pending_review' });
    });

    it('leaves a version already waiting for review waiting when the source becomes trusted', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt' });
      const source = await seedSource(seed, { trusted: false });
      const v = await upload(seed, 'notes.txt', 'hello', 'connector', source);
      await extract(seed, v.id);
      await withTenantTx(seed.tenantId, (tx) => tx.update(sources).set({ trusted: true }).where(eq(sources.id, source)));
      expect((await reload(seed, v.id)).status).toBe('pending_review');
    });
  });

  describe('one waiting version per file', () => {
    /** v1 (set back to waiting, as a move into a review space does) and a newer v2 still being read. */
    async function waitingOlderAndNewerExtracting() {
      const seed = await seedFileDocument({ title: 'notes.txt', reviewRequired: true });
      const v1 = await upload(seed, 'notes.txt', 'first');
      const v2 = await upload(seed, 'notes.txt', 'second');
      await withTenantTx(seed.tenantId, (tx) =>
        tx.update(versions).set({ status: 'pending_review' }).where(eq(versions.id, v1.id))
      );
      return { seed, v1, v2 };
    }

    it('supersedes the other waiting version when the newer one enters review', async () => {
      const { seed, v1, v2 } = await waitingOlderAndNewerExtracting();
      expect(await extractVersion({ tenantId: seed.tenantId, versionId: v2.id }, deps())).toEqual({
        outcome: 'extracted',
        status: 'pending_review',
      });
      expect((await reload(seed, v1.id)).status).toBe('superseded');
      expect((await reload(seed, v2.id)).status).toBe('pending_review');
    });

    it('leaves the older waiting version waiting when the newer one ends up stored', async () => {
      const seed = await seedFileDocument({ title: 'notes.txt', reviewRequired: true });
      const v1 = await upload(seed, 'notes.txt', 'first');
      const v2 = await upload(seed, 'scan.pdf', enc('%PDF-1.7\nblank scan'));
      await withTenantTx(seed.tenantId, (tx) =>
        tx.update(versions).set({ status: 'pending_review' }).where(eq(versions.id, v1.id))
      );
      const blank = {
        extract: async () => ({
          pageCount: 1,
          sections: [{ headingPath: [], pageFrom: 1, pageTo: 1, kind: 'text' as const, text: ' ' }],
          ocrUsed: true,
        }),
      };
      expect(await extractVersion({ tenantId: seed.tenantId, versionId: v2.id }, deps({ extractor: blank }))).toEqual({
        outcome: 'extracted',
        status: 'stored',
      });
      expect((await reload(seed, v1.id)).status).toBe('pending_review');
    });
  });

  it('stores a file whose extraction has no text, with a plain reason', async () => {
    const seed = await seedFileDocument();
    const bytes = new Uint8Array([...enc('%PDF-1.7\n'), ...enc('x')]);
    const v = await upload(seed, 'a.pdf', bytes);
    const result = await extractVersion(
      { tenantId: seed.tenantId, versionId: v.id },
      deps({ extractor: { extract: async () => ({ pageCount: 1, sections: [{ headingPath: [], pageFrom: 1, pageTo: 1, kind: 'text', text: '  ' }], ocrUsed: true }) } })
    );
    expect(result).toEqual({ outcome: 'extracted', status: 'stored' });
    const row = await reload(seed, v.id);
    expect(row).toMatchObject({ status: 'stored', error: 'No text could be read from this file.' });
    expect(row.extractedKey).not.toBeNull();
    expect(await jobsOf(seed, 'version.index')).toEqual([]);
  });

  it('keeps pages from the extractor in the stored text', async () => {
    const seed = await seedFileDocument();
    const v = await upload(seed, 'a.pdf', enc('%PDF-1.7\nx'));
    const extractor: Extractor = {
      extract: async () => ({
        pageCount: 2,
        ocrUsed: false,
        sections: [
          { headingPath: [], pageFrom: 1, pageTo: 1, kind: 'text', text: 'first page text' },
          { headingPath: [], pageFrom: 2, pageTo: 2, kind: 'text', text: 'second page text' },
        ],
      }),
    };
    await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps({ extractor }));
    const row = await reload(seed, v.id);
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(seed.tenantId, row.extractedKey!)).bytes));
    expect(stored.sections.map((s: { pageFrom: number }) => s.pageFrom)).toEqual([1, 2]);
  });

  it('leaves the version extracting and throws extractor_unavailable when the extractor is down', async () => {
    const seed = await seedFileDocument();
    const v = await upload(seed, 'a.pdf', enc('%PDF-1.7\nx'));
    const down: Extractor = { extract: async () => { throw new AppError('extractor_unavailable'); } };
    await expect(extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps({ extractor: down }))).rejects.toMatchObject({
      code: 'extractor_unavailable',
    });
    expect((await reload(seed, v.id)).status).toBe('extracting');
  });

  it('rejects an unreadable file with file_unreadable', async () => {
    const seed = await seedFileDocument();
    const v = await upload(seed, 'a.pdf', enc('%PDF-1.7\nx'));
    await expect(extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps())).rejects.toMatchObject({ code: 'file_unreadable' });
  });

  it('rejects text over the limit with file_text_too_large and writes no extracted text', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'this is more than ten characters');
    await expect(extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps({ maxChars: 10 }))).rejects.toMatchObject({
      code: 'file_text_too_large',
    });
    expect((await reload(seed, v.id)).extractedKey).toBeNull();
  });

  it('does nothing the second time', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'hello');
    await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps());
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps())).toEqual({
      outcome: 'skipped',
      reason: 'not_extracting',
    });
    expect(await jobsOf(seed, 'version.index')).toHaveLength(1);
  });

  it('skips a version that a newer upload replaced', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const first = await upload(seed, 'notes.txt', 'one');
    await upload(seed, 'notes.txt', 'two');
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: first.id }, deps())).toEqual({
      outcome: 'skipped',
      reason: 'not_extracting',
    });
  });

  it('supersedes a version that is no longer the document\'s latest when its extraction finishes', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'one');
    const slow: Extractor = {
      extract: async () => {
        throw new Error('not used');
      },
    };
    // a newer version appears while the first is being read
    const racing = deps({ extractor: slow });
    const original = racing.storage.get.bind(racing.storage);
    racing.storage.get = async (tenantId: string, key: string) => {
      const out = await original(tenantId, key);
      await withTenantTx(tenantId, (tx) =>
        tx.update(documents).set({ latestVersionId: randomUUID() }).where(eq(documents.id, seed.documentId))
      );
      return out;
    };
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, racing)).toEqual({
      outcome: 'skipped',
      reason: 'superseded',
    });
    expect((await reload(seed, v.id)).status).toBe('superseded');
  });

  it('withdraws the version when the document was archived meanwhile', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'one');
    await withTenantTx(seed.tenantId, (tx) =>
      tx.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, seed.documentId))
    );
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps())).toEqual({
      outcome: 'skipped',
      reason: 'archived',
    });
    expect((await reload(seed, v.id)).status).toBe('withdrawn');
  });

  it('withdraws the version and drops its text when the file was removed at its source meanwhile', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'one');
    await withTenantTx(seed.tenantId, (tx) =>
      tx.update(documents).set({ sourceDeletedAt: new Date() }).where(eq(documents.id, seed.documentId))
    );
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps())).toEqual({
      outcome: 'skipped',
      reason: 'source_deleted',
    });
    const row = await reload(seed, v.id);
    expect([row.status, row.extractedKey]).toEqual(['withdrawn', null]);
    expect(await storage.get(seed.tenantId, `${seed.tenantId}/files/${seed.documentId}/${v.id}/extracted.json`).catch(() => null)).toBeNull();
  });

  it('a run that lost the race leaves the winner\'s extracted text alone', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'shared text');
    // A slow run reads the bytes first, is overtaken by a complete run, then finishes.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gated = Object.create(storage) as InMemoryObjectStorage;
    gated.get = async (tenantId: string, key: string) => {
      const out = await storage.get(tenantId, key);
      await held;
      return out;
    };
    const loser = extractVersion({ tenantId: seed.tenantId, versionId: v.id }, { ...deps(), storage: gated });
    await new Promise((r) => setTimeout(r, 50));
    expect(await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps())).toEqual({
      outcome: 'extracted',
      status: 'indexing',
    });
    release();
    expect(await loser).toEqual({ outcome: 'skipped', reason: 'not_extracting' });
    const row = await reload(seed, v.id);
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(seed.tenantId, row.extractedKey!)).bytes));
    expect(stored.sections[0].text).toBe('shared text');
  });

  it('audits the extraction', async () => {
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await upload(seed, 'notes.txt', 'hello');
    await extractVersion({ tenantId: seed.tenantId, versionId: v.id }, deps());
    const events = await withTenantTx(seed.tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, seed.tenantId), eq(auditEvents.subjectId, v.id)))
    );
    expect(events.map((e) => e.type).sort()).toEqual(['file.extracted', 'version.created']);
  });
});
