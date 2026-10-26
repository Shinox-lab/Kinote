import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppError } from '@living-wiki/contracts';
import {
  chunks,
  entities,
  entityEdges,
  entityExtractionCache,
  entityMentions,
  memberships,
  users,
  withTenantTx,
} from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import {
  DeterministicEmbeddingProvider,
  DeterministicPlacementModel,
  extractVersionEntities,
  type PlacementModel,
} from '../src/index.js';
import { addSpace, indexPageVersion, indexedFile, seedTenant, type World } from './fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const embedder = new DeterministicEmbeddingProvider();

/** The deterministic model, counting extraction calls and optionally failing them. */
class CountingModel implements PlacementModel {
  private readonly inner = new DeterministicPlacementModel();
  readonly model = this.inner.model;
  extractCalls = 0;
  fail = false;
  failFromCall = Infinity;
  summarizePage(input: Parameters<PlacementModel['summarizePage']>[0]) {
    return this.inner.summarizePage(input);
  }
  async extractEntities(input: Parameters<PlacementModel['extractEntities']>[0]) {
    this.extractCalls += 1;
    if (this.fail || this.extractCalls >= this.failFromCall) throw new AppError('router_unavailable');
    return this.inner.extractEntities(input);
  }
  sameEntity(input: Parameters<PlacementModel['sameEntity']>[0]) {
    return this.inner.sameEntity(input);
  }
}

const run = (w: World, versionId: string, model: PlacementModel = new DeterministicPlacementModel()) =>
  extractVersionEntities({ tenantId: w.tenantId, versionId }, model, embedder);

const all = (w: World) =>
  withTenantTx(w.tenantId, async (tx) => ({
    entities: await tx.select().from(entities),
    mentions: await tx.select().from(entityMentions),
    edges: await tx.select().from(entityEdges),
  }));

describe('extractVersionEntities', () => {
  it('extracts mentions and edges for an indexed page', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const page = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');

    expect(await run(w, page.versionId)).toEqual({ outcome: 'extracted', entities: 2, edges: 1 });
    const { entities: rows, mentions, edges } = await all(w);
    expect(rows.map((e) => e.name).sort()).toEqual(['Aisha Rahman', 'Billing Service']);
    const [chunk] = await withTenantTx(w.tenantId, (tx) =>
      tx.select().from(chunks).where(eq(chunks.versionId, page.versionId))
    );
    expect(mentions).toHaveLength(2);
    for (const m of mentions) {
      expect(m).toMatchObject({ documentId: page.documentId, spaceId: space, chunkId: chunk!.id, blockIds: chunk!.blockIds });
    }
    expect(edges).toHaveLength(1);
    const byId = new Map(rows.map((e) => [e.id, e.name]));
    expect(edges[0]).toMatchObject({ type: 'owns', spaceId: space });
    expect([byId.get(edges[0]!.fromEntityId), byId.get(edges[0]!.toEntityId)]).toEqual(['Aisha Rahman', 'Billing Service']);
  });

  it('extracts from files too', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const file = await indexedFile(w, space, 'contract', 'Acme Corp uses Billing Service.');
    expect(await run(w, file.versionId)).toEqual({ outcome: 'extracted', entities: 2, edges: 1 });
  });

  it('resolves spelling variants to one entity', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const p1 = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');
    const p2 = await indexPageVersion(w, space, 'approvals', 'It was approved by Aisha.');
    await run(w, p1.versionId);
    await run(w, p2.versionId);

    const { entities: rows, mentions } = await all(w);
    const aisha = rows.filter((e) => e.normalizedName.startsWith('aisha'));
    expect(aisha).toHaveLength(1);
    expect(aisha[0]!.aliases).toContain('aisha');
    expect(mentions.filter((m) => m.entityId === aisha[0]!.id).map((m) => m.documentId).sort()).toEqual(
      [p1.documentId, p2.documentId].sort()
    );
  });

  it('resolves spelling variants inside one document to one entity', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const page = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service. It was approved by Aisha.');
    await run(w, page.versionId);
    const { entities: rows, mentions } = await all(w);
    const aisha = rows.filter((e) => e.normalizedName.startsWith('aisha'));
    expect(aisha).toHaveLength(1);
    expect(aisha[0]).toMatchObject({ name: 'Aisha Rahman', normalizedName: 'aisha rahman' });
    expect(aisha[0]!.aliases).toContain('aisha');
    expect(mentions.filter((m) => m.entityId === aisha[0]!.id)).toHaveLength(1);
  });

  it('links a person to the one member with that name', async () => {
    const w = await seedTenant();
    const userId = randomUUID();
    await withTenantTx(w.tenantId, async (tx) => {
      await tx.insert(users).values({ id: userId, email: `aisha-${userId}@x.test`, name: 'Aisha Rahman', passwordHash: 'x' });
      await tx.insert(memberships).values({ tenantId: w.tenantId, userId, role: 'member' });
    });
    const space = await addSpace(w);
    const page = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');
    // The deterministic model calls everything `other`; ask for a person.
    const personModel: PlacementModel = {
      ...new DeterministicPlacementModel(),
      model: 'person-model',
      summarizePage: (i) => new DeterministicPlacementModel().summarizePage(i),
      sameEntity: (i) => new DeterministicPlacementModel().sameEntity(i),
      async extractEntities(i) {
        const out = await new DeterministicPlacementModel().extractEntities(i);
        return {
          ...out,
          entities: out.entities.map((e) => (e.name === 'Aisha Rahman' ? { ...e, kind: 'person' as const } : e)),
        };
      },
    };
    await run(w, page.versionId, personModel);
    const { entities: rows } = await all(w);
    expect(rows.find((e) => e.name === 'Aisha Rahman')).toMatchObject({ kind: 'person', userId });
    expect(rows.find((e) => e.name === 'Billing Service')!.userId).toBeNull();
  });

  it('uses the cache', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const md = 'Aisha Rahman owns Billing Service.';
    const v1 = await indexPageVersion(w, space, 'billing', md);
    const model = new CountingModel();
    await run(w, v1.versionId, model);
    expect(model.extractCalls).toBe(1);
    const v2 = await indexPageVersion(w, space, 'billing', md, v1.documentId, 2);
    await run(w, v2.versionId, model);
    expect(model.extractCalls).toBe(1);
    const { mentions } = await all(w);
    expect(new Set(mentions.map((m) => m.versionId))).toEqual(new Set([v2.versionId]));
  });

  it('concurrent extraction of the same name creates one entity', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const a = await indexPageVersion(w, space, 'a', 'Billing Service is down.');
    const b = await indexPageVersion(w, space, 'b', 'Billing Service is back.');
    await Promise.all([run(w, a.versionId), run(w, b.versionId)]);
    const { entities: rows, mentions } = await all(w);
    expect(rows.filter((e) => e.name === 'Billing Service')).toHaveLength(1);
    expect(mentions).toHaveLength(2);
  });

  it('a model failure leaves the previous mentions untouched', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const v1 = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');
    const model = new CountingModel();
    await run(w, v1.versionId, model);
    const v2 = await indexPageVersion(w, space, 'billing', 'Ben Tan owns Billing Service.', v1.documentId, 2);
    model.fail = true;
    await expect(run(w, v2.versionId, model)).rejects.toMatchObject({ code: 'router_unavailable' });
    const { mentions, entities: rows } = await all(w);
    expect(mentions).toHaveLength(2);
    expect(rows.map((e) => e.name).sort()).toEqual(['Aisha Rahman', 'Billing Service']);
  });

  it('keeps the extractions of earlier chunks when a later chunk fails', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const page = await indexPageVersion(
      w,
      space,
      'billing',
      '# Owners\n\nAisha Rahman owns Billing Service.\n\n# Stack\n\nBilling Service uses Adyen.'
    );
    const chunkCount = (
      await withTenantTx(w.tenantId, (tx) => tx.select().from(chunks).where(eq(chunks.versionId, page.versionId)))
    ).length;
    expect(chunkCount).toBeGreaterThan(1);
    const model = new CountingModel();
    model.failFromCall = 2;
    await expect(run(w, page.versionId, model)).rejects.toMatchObject({ code: 'router_unavailable' });
    const cached = await withTenantTx(w.tenantId, (tx) => tx.select().from(entityExtractionCache));
    expect(cached).toHaveLength(1);
  });

  it('orphans are removed', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const v1 = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');
    const other = await indexPageVersion(w, space, 'people', 'Aisha Rahman joined.');
    await run(w, v1.versionId);
    await run(w, other.versionId);
    const v2 = await indexPageVersion(w, space, 'billing', 'nothing named here.', v1.documentId, 2);
    await run(w, v2.versionId);

    const { entities: rows, edges } = await all(w);
    expect(rows.map((e) => e.name)).toEqual(['Aisha Rahman']);
    expect(edges).toEqual([]);
  });

  it('skips Inbox documents and stale versions', async () => {
    const w = await seedTenant();
    const inbox = await addSpace(w, 'inbox');
    const note = await indexPageVersion(w, inbox, 'note', 'Aisha Rahman owns Billing Service.');
    expect(await run(w, note.versionId)).toEqual({ outcome: 'skipped', reason: 'inbox' });

    const space = await addSpace(w);
    const v1 = await indexPageVersion(w, space, 'billing', 'Aisha Rahman owns Billing Service.');
    await indexPageVersion(w, space, 'billing', 'Newer.', v1.documentId, 2);
    expect(await run(w, v1.versionId)).toEqual({ outcome: 'skipped', reason: 'not_indexed' });
    expect((await all(w)).entities).toEqual([]);
  });
});

