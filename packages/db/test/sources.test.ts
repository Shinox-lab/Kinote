import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../src/testing.js';
import {
  documents,
  sourceItems,
  sourceTokens,
  sources,
  spaces,
  tenants,
  withTenantTx,
} from '../src/index.js';

async function seed() {
  const { reset } = await createTestDb();
  await reset();
  const tenantId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  await withTenantTx(tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` });
    await tx.insert(spaces).values({ id: spaceId, tenantId, name: 'S', slug: 's', createdBy: userId });
  });
  return { tenantId, userId, spaceId };
}

const newSource = (tenantId: string, spaceId: string, userId: string, name: string) => ({
  id: randomUUID(), tenantId, kind: 'upload_api' as const, name, targetSpaceId: spaceId, createdBy: userId,
});

describe('sources tables', () => {
  it('stores a source with defaults and its token and item rows', async () => {
    const { tenantId, userId, spaceId } = await seed();
    const docId = randomUUID();
    const src = newSource(tenantId, spaceId, userId, 'Reports');
    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(sources).values(src);
      await tx.insert(documents).values({
        id: docId, tenantId, spaceId, kind: 'file', title: 'a.pdf', createdByType: 'connector', createdBy: src.id,
        sourceId: src.id, externalId: 'ext-1', placement: 'synced',
      });
      await tx.insert(sourceItems).values({ tenantId, sourceId: src.id, externalId: 'ext-1', documentId: docId, contentHash: 'h' });
      await tx.insert(sourceTokens).values({
        tenantId, sourceId: src.id, name: 'ci', tokenHash: 'hash-1', tokenPrefix: 'abcd1234', createdBy: userId,
      });
    });
    const [row] = await withTenantTx(tenantId, (tx) => tx.select().from(sources));
    expect(row).toMatchObject({ kind: 'upload_api', trusted: false, status: 'active', lastSyncAt: null });
    const [item] = await withTenantTx(tenantId, (tx) => tx.select().from(sourceItems));
    expect(item).toMatchObject({ externalId: 'ext-1', deletedAt: null });
  });

  it('keeps source names unique per tenant, ignoring case', async () => {
    const a = await seed();
    await withTenantTx(a.tenantId, (tx) => tx.insert(sources).values(newSource(a.tenantId, a.spaceId, a.userId, 'Reports')));
    await expect(
      withTenantTx(a.tenantId, (tx) => tx.insert(sources).values(newSource(a.tenantId, a.spaceId, a.userId, 'REPORTS')))
    ).rejects.toThrow();

    const otherTenant = randomUUID();
    const otherSpace = randomUUID();
    await withTenantTx(otherTenant, async (tx) => {
      await tx.insert(tenants).values({ id: otherTenant, name: `t-${otherTenant}`, slug: `t-${otherTenant}` });
      await tx.insert(spaces).values({ id: otherSpace, tenantId: otherTenant, name: 'S', slug: 's', createdBy: a.userId });
      await tx.insert(sources).values(newSource(otherTenant, otherSpace, a.userId, 'Reports'));
    });
  });

  it('allows one item per external id and one item per document', async () => {
    const { tenantId, userId, spaceId } = await seed();
    const src = newSource(tenantId, spaceId, userId, 'S1');
    const mkDoc = async (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], id: string) =>
      tx.insert(documents).values({ id, tenantId, spaceId, kind: 'file', title: 'f', createdByType: 'connector', createdBy: src.id });
    const d1 = randomUUID();
    const d2 = randomUUID();
    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(sources).values(src);
      await mkDoc(tx, d1);
      await mkDoc(tx, d2);
      await tx.insert(sourceItems).values({ tenantId, sourceId: src.id, externalId: 'e', documentId: d1, contentHash: 'h' });
    });
    await expect(
      withTenantTx(tenantId, (tx) => tx.insert(sourceItems).values({ tenantId, sourceId: src.id, externalId: 'e', documentId: d2, contentHash: 'h' }))
    ).rejects.toThrow();
    await expect(
      withTenantTx(tenantId, (tx) => tx.insert(sourceItems).values({ tenantId, sourceId: src.id, externalId: 'other', documentId: d1, contentHash: 'h' }))
    ).rejects.toThrow();
  });

  it('refuses to delete a source that a document references', async () => {
    const { tenantId, userId, spaceId } = await seed();
    const src = newSource(tenantId, spaceId, userId, 'S2');
    await withTenantTx(tenantId, async (tx) => {
      await tx.insert(sources).values(src);
      await tx.insert(documents).values({
        id: randomUUID(), tenantId, spaceId, kind: 'file', title: 'f', createdByType: 'connector', createdBy: src.id, sourceId: src.id,
      });
    });
    await expect(withTenantTx(tenantId, (tx) => tx.delete(sources))).rejects.toThrow();
  });
});
