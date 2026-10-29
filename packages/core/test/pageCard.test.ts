import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { documents, pageCards, withTenantTx } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import {
  DeterministicEmbeddingProvider,
  DeterministicPlacementModel,
  buildPageCard,
  pageOutline,
  type EmbeddingProvider,
} from '../src/index.js';
import { blocksFromMarkdown } from './fixtures/realBlocks.js';
import { addSpace, indexPageVersion, indexedFile, seedTenant } from './fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

const model = new DeterministicPlacementModel();
const embedder = new DeterministicEmbeddingProvider();
const MD = 'Billing runs on Adyen. Aisha owns it. More text here.\n\n## Owners\n\nAisha.\n\n### Backup\n\nBen.';

async function cards(tenantId: string) {
  return withTenantTx(tenantId, (tx) => tx.select().from(pageCards));
}

describe('pageOutline', () => {
  it('lists headings in order with their level', async () => {
    expect(pageOutline(await blocksFromMarkdown(MD))).toEqual(['## Owners', '### Backup']);
  });
});

describe('buildPageCard', () => {
  it('builds a card for the indexed version', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const page = await indexPageVersion(w, space, 'Billing service', MD);

    expect(await buildPageCard({ tenantId: w.tenantId, versionId: page.versionId }, model, embedder)).toEqual({
      outcome: 'built',
    });
    const [card] = await cards(w.tenantId);
    expect(card).toMatchObject({
      documentId: page.documentId,
      spaceId: space,
      versionId: page.versionId,
      summary: 'Billing runs on Adyen. Aisha owns it.',
      outline: ['## Owners', '### Backup'],
    });
    expect(card!.embedding).toHaveLength(2560);
  });

  it('replaces the card when a newer version is indexed', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const v1 = await indexPageVersion(w, space, 'Billing service', MD);
    await buildPageCard({ tenantId: w.tenantId, versionId: v1.versionId }, model, embedder);
    const v2 = await indexPageVersion(w, space, 'Billing service', 'Billing runs on Stripe.', v1.documentId, 2);
    await buildPageCard({ tenantId: w.tenantId, versionId: v2.versionId }, model, embedder);

    const rows = await cards(w.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ versionId: v2.versionId, summary: 'Billing runs on Stripe.' });
  });

  it('skips when a newer version was indexed meanwhile', async () => {
    const w = await seedTenant();
    const space = await addSpace(w);
    const v1 = await indexPageVersion(w, space, 'Billing service', MD);
    const v2 = await indexPageVersion(w, space, 'Billing service', 'Newer.', v1.documentId, 2);
    // Point back at v1 so phase A accepts it, then flip to v2 while embedding.
    const setIndexed = (versionId: string) =>
      withTenantTx(w.tenantId, (tx) =>
        tx
          .update(documents)
          .set({ indexedVersionId: versionId })
          .where(and(eq(documents.tenantId, w.tenantId), eq(documents.id, v1.documentId)))
      );
    await setIndexed(v1.versionId);
    const flipping: EmbeddingProvider = {
      model: embedder.model,
      dimensions: embedder.dimensions,
      async embed(texts) {
        await setIndexed(v2.versionId);
        return embedder.embed(texts);
      },
    };

    expect(await buildPageCard({ tenantId: w.tenantId, versionId: v1.versionId }, model, flipping)).toEqual({
      outcome: 'skipped',
      reason: 'not_indexed',
    });
    expect(await cards(w.tenantId)).toEqual([]);
  });

  it('skips Inbox pages and files', async () => {
    const w = await seedTenant();
    const inbox = await addSpace(w, 'inbox');
    const page = await indexPageVersion(w, inbox, 'Note', MD);
    expect(await buildPageCard({ tenantId: w.tenantId, versionId: page.versionId }, model, embedder)).toEqual({
      outcome: 'skipped',
      reason: 'inbox',
    });

    const space = await addSpace(w);
    const file = await indexedFile(w, space, 'Contract', 'Aisha Rahman owns Billing Service.');
    expect(await buildPageCard({ tenantId: w.tenantId, versionId: file.versionId }, model, embedder)).toEqual({
      outcome: 'skipped',
      reason: 'not_a_page',
    });
    expect(await cards(w.tenantId)).toEqual([]);
  });
});
