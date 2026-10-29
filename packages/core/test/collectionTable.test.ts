import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { documents, versions, withTenantTx } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import type { SearchPassage } from '@kinote/contracts';
import { collectionTables } from '../src/index.js';
import { addCollection, addRoutingSpace, livePage, routingWorld } from './fixtures/routingSeed.js';
import type { World } from './fixtures/placementSeed.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

/** Sets the fields of a page's indexed version (what the snapshot would have stored). */
async function indexedFields(w: World, versionId: string, fields: Record<string, unknown>) {
  await withTenantTx(w.tenantId, (tx) => tx.update(versions).set({ fields }).where(and(eq(versions.tenantId, w.tenantId), eq(versions.id, versionId))));
}

const passage = (documentId: string, spaceId: string): SearchPassage => ({
  chunkId: randomUUID(),
  documentId,
  versionId: randomUUID(),
  versionNumber: 1,
  versionTitle: 't',
  spaceId,
  icon: null,
  text: 'x',
  headingPath: [],
  blockIds: [],
  documentKind: 'page',
  pageFrom: null,
  pageTo: null,
  citeAs: 't (v1, updated 2026-10-30)',
  rrfScore: 1,
});

async function clientsWorld() {
  const w = await routingWorld();
  const space = await addRoutingSpace(w, { name: 'Clients' });
  const clients = await livePage(w, space, 'Clients', 'Our clients.');
  const [status, launch] = await addCollection(w, clients.documentId, [
    { name: 'Status', type: 'select', choices: ['Lead', 'Active'] },
    { name: 'Launch date', type: 'date' },
  ]);
  const row = async (title: string, fields: Record<string, unknown>) => {
    const page = await livePage(w, space, title, `${title} is a client.`, { parentId: clients.documentId });
    await indexedFields(w, page.versionId, fields);
    return page;
  };
  const george = await row('George', { [status!.id]: 'status:active', [launch!.id]: { start: '2026-12-01' } });
  const anna = await row('Anna', { [status!.id]: 'status:lead' });
  return { w, space, clients, status: status!, launch: launch!, george, anna, row };
}

const actorOf = (w: World) => w.actor;

describe('collectionTables', () => {
  it('builds a table of indexed rows with their field values', async () => {
    const c = await clientsWorld();
    const tables = await withTenantTx(c.w.tenantId, (tx) =>
      collectionTables(tx, actorOf(c.w), [c.space], [passage(c.george.documentId, c.space)])
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ collectionId: c.clients.documentId, title: 'Clients', fields: ['Status', 'Launch date'], truncated: false });
    expect(tables[0]!.rows.map((r) => [r.title, r.values])).toEqual([
      ['Anna', { Status: 'Lead' }],
      ['George', { Status: 'Active', 'Launch date': '2026-12-01 (1 December 2026)' }],
    ]);
    const george = tables[0]!.rows.find((r) => r.title === 'George')!;
    expect(george).toMatchObject({ documentId: c.george.documentId, versionId: c.george.versionId, versionNumber: 1, spaceId: c.space });
    expect(george.citeAs).toMatch(/^George \(v1, updated \d{4}-\d{2}-\d{2}\)$/);
    expect(george.chunkId).toBeTruthy();
  });

  it('a row whose newer version waits for review shows its indexed value', async () => {
    const c = await clientsWorld();
    const newer = randomUUID();
    await withTenantTx(c.w.tenantId, async (tx) => {
      await tx.insert(versions).values({
        id: newer, tenantId: c.w.tenantId, documentId: c.anna.documentId, number: 2, title: 'Anna', status: 'pending_review',
        contentHash: `h-${newer}`, reason: 'quiet', createdByType: 'user', createdBy: c.w.userId, markdown: 'Anna.', blocks: [],
        fields: { [c.status.id]: 'status:active' },
      });
      await tx.update(documents).set({ latestVersionId: newer }).where(eq(documents.id, c.anna.documentId));
    });
    const [table] = await withTenantTx(c.w.tenantId, (tx) => collectionTables(tx, actorOf(c.w), [c.space], [passage(c.clients.documentId, c.space)]));
    expect(table!.rows.find((r) => r.title === 'Anna')!.values).toEqual({ Status: 'Lead' });
  });

  it('rows without an indexed version and archived rows are left out', async () => {
    const c = await clientsWorld();
    const ghost = randomUUID();
    await withTenantTx(c.w.tenantId, async (tx) => {
      await tx.insert(documents).values({
        id: ghost, tenantId: c.w.tenantId, spaceId: c.space, parentId: c.clients.documentId, kind: 'page', title: 'Unindexed',
        createdByType: 'user', createdBy: c.w.userId,
      });
      await tx.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, c.anna.documentId));
    });
    const [table] = await withTenantTx(c.w.tenantId, (tx) => collectionTables(tx, actorOf(c.w), [c.space], [passage(c.george.documentId, c.space)]));
    expect(table!.rows.map((r) => r.title)).toEqual(['George']);
  });

  it('stops at 200 rows and says so', async () => {
    const c = await clientsWorld();
    const source = await withTenantTx(c.w.tenantId, async (tx) => (await tx.select().from(versions).where(eq(versions.id, c.george.versionId)))[0]!);
    await withTenantTx(c.w.tenantId, async (tx) => {
      for (let i = 0; i < 200; i++) {
        const id = randomUUID();
        const versionId = randomUUID();
        await tx.insert(documents).values({
          id, tenantId: c.w.tenantId, spaceId: c.space, parentId: c.clients.documentId, kind: 'page', title: `Row ${String(i).padStart(3, '0')}`,
          createdByType: 'user', createdBy: c.w.userId,
        });
        await tx.insert(versions).values({
          id: versionId, tenantId: c.w.tenantId, documentId: id, number: 1, title: `Row ${i}`, status: 'indexed', contentHash: `h-${versionId}`,
          reason: 'quiet', createdByType: 'user', createdBy: c.w.userId, markdown: 'r', blocks: source.blocks, fields: {},
        });
        await tx.update(documents).set({ latestVersionId: versionId, indexedVersionId: versionId }).where(eq(documents.id, id));
        // Its chunk 0: a copy of George's.
        await tx.execute(sql`
          INSERT INTO chunks (tenant_id, space_id, document_id, version_id, ordinal, heading_path, block_ids, page_from, page_to, text, token_count, content_hash, embedding, embedding_model, inbox_owner)
          SELECT tenant_id, space_id, ${id}::uuid, ${versionId}::uuid, ordinal, heading_path, block_ids, page_from, page_to, text, token_count, content_hash, embedding, embedding_model, inbox_owner
            FROM chunks WHERE version_id = ${c.george.versionId}::uuid AND ordinal = 0`);
      }
    });
    const [table] = await withTenantTx(c.w.tenantId, (tx) => collectionTables(tx, actorOf(c.w), [c.space], [passage(c.george.documentId, c.space)]));
    expect(table!.rows).toHaveLength(200);
    expect(table!.truncated).toBe(true);
  });

  it('no table when no retrieved passage is a row or a collection', async () => {
    const c = await clientsWorld();
    const plain = await livePage(c.w, c.space, 'Plain', 'Nothing to see.');
    const tables = await withTenantTx(c.w.tenantId, (tx) => collectionTables(tx, actorOf(c.w), [c.space], [passage(plain.documentId, c.space)]));
    expect(tables).toEqual([]);
  });

  it('a collection in a space the reader cannot read gives no table', async () => {
    const c = await clientsWorld();
    const other = await addRoutingSpace(c.w, { name: 'Other' });
    const tables = await withTenantTx(c.w.tenantId, (tx) => collectionTables(tx, actorOf(c.w), [other], [passage(c.george.documentId, c.space)]));
    expect(tables).toEqual([]);
  });
});
