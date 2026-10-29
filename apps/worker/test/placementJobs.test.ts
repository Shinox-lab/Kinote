import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { entityMentions, pageCards, withTenantTx } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import { runPendingJobsForTenant } from '../src/runner.js';
import { addSpace, indexPageVersion, seedTenant } from '../../../packages/core/test/fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

describe('placement jobs', () => {
  it('the worker builds the card and the graph of a newly indexed page', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const page = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');

    const processed = await runPendingJobsForTenant(w.tenantId);
    expect(processed.map((p) => [p.queue, p.status]).sort()).toEqual([
      ['version.card', 'completed'],
      ['version.entities', 'completed'],
    ]);
    const cards = await withTenantTx(w.tenantId, (tx) => tx.select().from(pageCards));
    expect(cards.map((c) => c.documentId)).toEqual([page.documentId]);
    const mentions = await withTenantTx(w.tenantId, (tx) => tx.select().from(entityMentions));
    expect(mentions.length).toBeGreaterThan(0);
  });
});
