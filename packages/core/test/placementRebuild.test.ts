import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueuePlacementRebuild, jobs, withTenantTx } from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import { addSpace, indexPageVersion, indexedFile, seedTenant } from './fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

describe('enqueuePlacementRebuild', () => {
  it('queues a card per indexed page and entities per indexed document, outside the Inbox, for every tenant', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const page = await indexPageVersion(a, await addSpace(a), 'billing', 'Aisha Rahman owns Billing Service.');
    const file = await indexedFile(b, await addSpace(b), 'contract', 'Acme Corp uses Billing Service.');
    await indexPageVersion(a, await addSpace(a, 'inbox'), 'note', 'Private.');
    for (const w of [a, b]) await withTenantTx(w.tenantId, (tx) => tx.delete(jobs));

    // The rebuild runs as the schema owner across tenants, like a migration.
    await testDb.pglite.exec('RESET ROLE;');
    let queued: number;
    try {
      queued = await enqueuePlacementRebuild(testDb.db);
    } finally {
      await testDb.pglite.exec('SET ROLE living_wiki_app;');
    }

    expect(queued).toBe(3);
    const keys = async (tenantId: string) =>
      (await withTenantTx(tenantId, (tx) => tx.select().from(jobs))).map((j) => [j.queue, j.idempotencyKey]).sort();
    expect(await keys(a.tenantId)).toEqual([
      ['version.card', `card:${page.versionId}`],
      ['version.entities', `entities:${page.versionId}`],
    ]);
    expect(await keys(b.tenantId)).toEqual([['version.entities', `entities:${file.versionId}`]]);
  });
});
