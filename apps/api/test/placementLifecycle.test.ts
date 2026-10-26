import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  entities,
  entityEdges,
  entityMentions,
  jobs,
  pageCards,
  spaceGrants,
  spaces,
  withTenantTx,
} from '@living-wiki/db';
import { createTestDb, type TestDb } from '@living-wiki/db/testing';
import {
  DeterministicEmbeddingProvider,
  DeterministicPlacementModel,
  buildPageCard,
  extractVersionEntities,
  type Actor,
} from '@living-wiki/core';
import { movePage, withdrawPage } from '../src/routes/pages.js';
import { moveFile } from '../src/routes/files.js';
import {
  addSpace,
  indexPageVersion,
  indexedFile,
  seedTenant,
  type World,
} from '../../../packages/core/test/fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const model = new DeterministicPlacementModel();
const embedder = new DeterministicEmbeddingProvider();
const TEXT = 'Aisha Rahman owns Billing Service.';

/** An indexed page with its card, mentions and edges built. */
async function placedPage(w: World, spaceId: string) {
  const page = await indexPageVersion(w, spaceId, 'billing', TEXT);
  await buildPageCard({ tenantId: w.tenantId, versionId: page.versionId }, model, embedder);
  await extractVersionEntities({ tenantId: w.tenantId, versionId: page.versionId }, model, embedder);
  return page;
}

const derived = (w: World) =>
  withTenantTx(w.tenantId, async (tx) => ({
    cards: await tx.select().from(pageCards),
    mentions: await tx.select().from(entityMentions),
    edges: await tx.select().from(entityEdges),
    entities: await tx.select().from(entities),
  }));

async function setReview(w: World, spaceId: string) {
  await withTenantTx(w.tenantId, (tx) =>
    tx.update(spaces).set({ reviewRequired: true }).where(and(eq(spaces.tenantId, w.tenantId), eq(spaces.id, spaceId)))
  );
}

/** A member who is editor (only) of the given spaces. */
async function editorOf(w: World, spaceIds: string[]): Promise<Actor> {
  const userId = randomUUID();
  await withTenantTx(w.tenantId, (tx) =>
    tx.insert(spaceGrants).values(
      spaceIds.map((spaceId) => ({ tenantId: w.tenantId, spaceId, principalType: 'user' as const, principalId: userId, role: 'editor' as const }))
    )
  );
  return { tenantId: w.tenantId, principalType: 'user', principalId: userId, tenantRole: 'member' };
}

describe('cards and the entity graph follow the document', () => {
  it('withdraw deletes the card, mentions, edges and orphan entities', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const page = await placedPage(w, space);
    expect((await derived(w)).cards).toHaveLength(1);

    await withdrawPage(w.actor, page.documentId);
    expect(await derived(w)).toEqual({ cards: [], mentions: [], edges: [], entities: [] });
  });

  it('moving into a review space as a non-reviewer deletes them', async () => {
    const w = await seedTenant();
    const from = await addSpace(w);
    const to = await addSpace(w);
    await setReview(w, to);
    const page = await placedPage(w, from);
    const actor = await editorOf(w, [from, to]);

    await movePage(actor, page.documentId, { target_space_id: to });
    expect(await derived(w)).toEqual({ cards: [], mentions: [], edges: [], entities: [] });
  });

  it('moving between normal spaces updates space_id on all three', async () => {
    const w = await seedTenant();
    const from = await addSpace(w);
    const to = await addSpace(w);
    const page = await placedPage(w, from);

    await movePage(w.actor, page.documentId, { target_space_id: to });
    const { cards, mentions, edges } = await derived(w);
    expect(cards.map((c) => c.spaceId)).toEqual([to]);
    expect(new Set(mentions.map((m) => m.spaceId))).toEqual(new Set([to]));
    expect(edges.map((e) => e.spaceId)).toEqual([to]);
  });

  it('moving into the Inbox deletes the card, mentions and edges', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const inbox = await addSpace(w, 'inbox');
    const page = await placedPage(w, space);

    await movePage(w.actor, page.documentId, { target_space_id: inbox });
    expect(await derived(w)).toEqual({ cards: [], mentions: [], edges: [], entities: [] });
  });

  it('moving out of the Inbox enqueues card and entity jobs', async () => {
    const w = await seedTenant();
    const inbox = await addSpace(w, 'inbox');
    const space = await addSpace(w);
    const page = await indexPageVersion(w, inbox, 'note', TEXT);
    await withTenantTx(w.tenantId, (tx) => tx.delete(jobs));

    await movePage(w.actor, page.documentId, { target_space_id: space });
    const queued = await withTenantTx(w.tenantId, (tx) => tx.select().from(jobs));
    expect(queued.map((j) => [j.queue, j.idempotencyKey]).sort()).toEqual([
      ['version.card', `card:${page.versionId}`],
      ['version.entities', `entities:${page.versionId}`],
    ]);
  });

  it('a moved file updates its mentions too', async () => {
    const w = await seedTenant();
    const from = await addSpace(w);
    const to = await addSpace(w);
    const file = await indexedFile(w, from, 'contract', TEXT);
    await extractVersionEntities({ tenantId: w.tenantId, versionId: file.versionId }, model, embedder);

    await moveFile(w.actor, file.documentId, { target_space_id: to });
    const { mentions, edges } = await derived(w);
    expect(new Set(mentions.map((m) => m.spaceId))).toEqual(new Set([to]));
    expect(edges.map((e) => e.spaceId)).toEqual([to]);
  });
});
