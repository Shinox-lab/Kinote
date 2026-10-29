import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantTx, type DbTransaction } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import {
  DeterministicEmbeddingProvider,
  DeterministicPlacementModel,
  buildPageCard,
  extractVersionEntities,
  findEntities,
  pagesForEntities,
  searchPageCards,
  type PlacementFilter,
} from '../src/index.js';
import { addSpace, indexPageVersion, seedTenant, type World } from './fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const model = new DeterministicPlacementModel();
const embedder = new DeterministicEmbeddingProvider();

async function placed(w: World, spaceId: string, title: string, text: string) {
  const page = await indexPageVersion(w, spaceId, title, text);
  await buildPageCard({ tenantId: w.tenantId, versionId: page.versionId }, model, embedder);
  await extractVersionEntities({ tenantId: w.tenantId, versionId: page.versionId }, model, embedder);
  return page.documentId;
}

/**
 * S1 is readable, S2 is not.
 * S1: owners "Aisha Rahman owns Billing Service.", stack "Billing Service uses Adyen.", people "Ben Tan joined."
 * S2: secret "Secret Project depends on Billing Service.", shadow "Ben Tan owns Billing Service."
 */
async function world() {
  const w = await seedTenant();
  const s1 = await addSpace(w);
  const s2 = await addSpace(w);
  const owners = await placed(w, s1, 'owners', 'Aisha Rahman owns Billing Service.');
  const stack = await placed(w, s1, 'stack', 'Billing Service uses Adyen.');
  const people = await placed(w, s1, 'people', 'Ben Tan joined.');
  const secret = await placed(w, s2, 'secret', 'Secret Project depends on Billing Service.');
  await placed(w, s2, 'shadow', 'Ben Tan owns Billing Service.');
  const filter: PlacementFilter = { tenantId: w.tenantId, spaceIds: [s1] };
  return { w, s1, s2, owners, stack, people, secret, filter };
}

const inTx = <T>(w: World, fn: (tx: DbTransaction) => Promise<T>) => withTenantTx(w.tenantId, fn);

describe('placement queries', () => {
  it('searchPageCards returns only readable spaces\' cards, nearest first', async () => {
    const { w, s1, owners, filter } = await world();
    const [vector] = await embedder.embed(['owners Aisha Rahman owns Billing Service']);
    const hits = await inTx(w, (tx) => searchPageCards(tx, filter, vector!));
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.spaceId === s1)).toBe(true);
    expect(hits[0]!.documentId).toBe(owners);
    expect(hits.map((h) => h.distance)).toEqual([...hits.map((h) => h.distance)].sort((a, b) => a - b));
  });

  it('findEntities matches exactly, by trigram and only through readable spaces', async () => {
    const { w, filter } = await world();
    const exact = await inTx(w, (tx) => findEntities(tx, filter, 'Aisha Rahman'));
    expect(exact[0]).toMatchObject({ name: 'Aisha Rahman', match: 'exact' });
    const fuzzy = await inTx(w, (tx) => findEntities(tx, filter, 'aisha rahmn'));
    expect(fuzzy[0]).toMatchObject({ name: 'Aisha Rahman', match: 'trigram' });
  });

  it('names and spellings seen only in an unreadable space are never shown or matched', async () => {
    const w = await seedTenant();
    const open = await addSpace(w);
    const hidden = await addSpace(w);
    await placed(w, hidden, 'falcon', 'Aisha Rahman owns Falcon Project.');
    await placed(w, open, 'approvals', 'It was approved by Aisha.');
    const filter: PlacementFilter = { tenantId: w.tenantId, spaceIds: [open] };

    const hits = await inTx(w, (tx) => findEntities(tx, filter, 'aisha'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: 'Aisha', match: 'exact' });
  });

  it('entity found only through an unreadable space is not returned', async () => {
    const { w, filter } = await world();
    expect(await inTx(w, (tx) => findEntities(tx, filter, 'Secret Project'))).toEqual([]);
  });

  it('pagesForEntities follows readable edges one hop out', async () => {
    const { w, owners, stack, filter } = await world();
    const [aisha] = await inTx(w, (tx) => findEntities(tx, filter, 'Aisha Rahman'));
    const hits = await inTx(w, (tx) => pagesForEntities(tx, filter, [aisha!.entityId], 1));
    expect(hits.map((h) => [h.documentId, h.hops]).sort()).toEqual([[owners, 0], [stack, 1]].sort());
  });

  it('an edge recorded only in an unreadable space is not followed', async () => {
    const { w, people, filter } = await world();
    const [billing] = await inTx(w, (tx) => findEntities(tx, filter, 'Billing Service'));
    const hits = await inTx(w, (tx) => pagesForEntities(tx, filter, [billing!.entityId], 2));
    // Ben Tan owns Billing Service only in S2, so the S1 "people" page is not reached.
    expect(hits.map((h) => h.documentId)).not.toContain(people);
    expect(hits.every((h) => h.spaceId === filter.spaceIds[0])).toBe(true);
  });
});
