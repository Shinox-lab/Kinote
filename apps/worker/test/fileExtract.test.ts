import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { jobs, versions, withTenantTx } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { ERROR_SENTENCES } from '@living-wiki/contracts';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import { seedFileDocument, uploadFixtureFile } from '../../../packages/core/test/fixtures/fileSeed.js';
import { runPendingJobsForTenant } from '../src/runner.js';
import { handlers } from '../src/registry.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

/** The extraction handler; indexing is covered elsewhere, so its queue only records that it ran. */
const extractOnly = {
  'file.extract': handlers['file.extract']!,
  'version.index': { run: async () => undefined },
};

const versionOf = (tenantId: string, id: string) =>
  withTenantTx(tenantId, async (tx) => {
    const [row] = await tx.select().from(versions).where(and(eq(versions.tenantId, tenantId), eq(versions.id, id)));
    return row!;
  });
const jobsFor = (tenantId: string, queue: string) =>
  withTenantTx(tenantId, (tx) => tx.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, queue))));

describe('the file.extract job', () => {
  it('reads an uploaded text file and queues indexing', async () => {
    const storage = new InMemoryObjectStorage();
    const seed = await seedFileDocument({ title: 'notes.txt' });
    const v = await uploadFixtureFile(seed, storage, 'notes.txt', 'hello from the worker');
    const done = await runPendingJobsForTenant(seed.tenantId, {
      handlers: extractOnly,
      storage,
      extractor: new FakeExtractor(),
    });
    expect(done.map((j) => [j.queue, j.status])).toEqual([
      ['file.extract', 'completed'],
      ['version.index', 'completed'],
    ]);
    expect((await versionOf(seed.tenantId, v.id)).status).toBe('indexing');
    expect(await jobsFor(seed.tenantId, 'version.index')).toHaveLength(1);
  });

  it('retries while the extractor is down, then fails the version with a plain sentence', async () => {
    const storage = new InMemoryObjectStorage();
    const seed = await seedFileDocument();
    const v = await uploadFixtureFile(seed, storage, 'a.pdf', '%PDF-1.7\nFAKE-EXTRACT-DOWN\n');
    let t = Date.now();
    let status = '';
    for (let i = 0; i < 20 && status !== 'dead_letter'; i++) {
      await runPendingJobsForTenant(seed.tenantId, {
        handlers: extractOnly,
        storage,
        extractor: new FakeExtractor(),
        clock: () => new Date(t),
      });
      const [job] = await jobsFor(seed.tenantId, 'file.extract');
      status = job!.status;
      t += (2 ** job!.attempts + 1) * 1000;
    }
    expect(status).toBe('dead_letter');
    const row = await versionOf(seed.tenantId, v.id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^Extraction failed after 5 attempts: /);
    expect(row.error).toContain('The document extraction service is temporarily unavailable');
    expect(row.error).not.toContain('will retry automatically');
  });

  it('fails an unreadable file at once, without retries', async () => {
    const storage = new InMemoryObjectStorage();
    const seed = await seedFileDocument();
    const v = await uploadFixtureFile(seed, storage, 'a.pdf', '%PDF-1.7\nnot a marker\n');
    const done = await runPendingJobsForTenant(seed.tenantId, { handlers: extractOnly, storage, extractor: new FakeExtractor() });
    expect(done.map((j) => [j.queue, j.status])).toEqual([['file.extract', 'dead_letter']]);
    const row = await versionOf(seed.tenantId, v.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(`Extraction failed after 1 attempt: ${ERROR_SENTENCES.file_unreadable}`);
  });

  it('leaves a version that was withdrawn meanwhile alone when the job dead-letters', async () => {
    const storage = new InMemoryObjectStorage();
    const seed = await seedFileDocument();
    const v = await uploadFixtureFile(seed, storage, 'a.pdf', '%PDF-1.7\nnot a marker\n');
    await withTenantTx(seed.tenantId, (tx) => tx.update(versions).set({ status: 'withdrawn' }).where(eq(versions.id, v.id)));
    await runPendingJobsForTenant(seed.tenantId, { handlers: extractOnly, storage, extractor: new FakeExtractor() });
    expect((await versionOf(seed.tenantId, v.id)).status).toBe('withdrawn');
  });
});
