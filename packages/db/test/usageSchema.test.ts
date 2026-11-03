import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import {
  documents,
  getDb,
  rowsOf,
  spaces,
  tenantStorage,
  tenants,
  versions,
  withTenantTx,
} from '../src/index.js';

async function seedTenant(createdAt?: Date) {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}`, createdAt })
  );
  return tenantId;
}

async function seedDocument(tenantId: string) {
  return withTenantTx(tenantId, async (tx) => {
    const [space] = await tx
      .insert(spaces)
      .values({ tenantId, name: 'S', slug: 's', createdBy: randomUUID() })
      .returning();
    const [doc] = await tx
      .insert(documents)
      .values({ tenantId, spaceId: space!.id, kind: 'file', title: 'F', createdByType: 'user', createdBy: randomUUID() })
      .returning();
    return doc!.id;
  });
}

function versionRow(tenantId: string, documentId: string, sizeBytes: number | null, number = 1) {
  return {
    tenantId,
    documentId,
    number,
    title: 'F',
    status: 'stored' as const,
    contentHash: `h${number}`,
    reason: 'upload' as const,
    createdByType: 'user' as const,
    createdBy: randomUUID(),
    sizeBytes,
  };
}

async function storageBytes(tenantId: string): Promise<number> {
  const rows = await withTenantTx(tenantId, (tx) =>
    tx.select().from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId))
  );
  return rows[0]?.bytes ?? 0;
}

describe('plans and usage schema', () => {
  it('the new tables exist with RLS forced', async () => {
    const { reset } = await createTestDb();
    await reset();
    const rows = rowsOf<{ relname: string; forced: boolean }>(
      await getDb().execute(sql`
        SELECT relname, relforcerowsecurity AS forced FROM pg_class
        WHERE relname IN ('tenant_limits','usage_events','tenant_usage','credit_topups','tenant_storage')
        ORDER BY relname`)
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'credit_topups',
      'tenant_limits',
      'tenant_storage',
      'tenant_usage',
      'usage_events',
    ]);
    expect(rows.every((r) => r.forced)).toBe(true);
  });

  it('storing a file version counts its bytes; deleting it uncounts them', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const documentId = await seedDocument(tenantId);
    const [v] = await withTenantTx(tenantId, (tx) =>
      tx.insert(versions).values(versionRow(tenantId, documentId, 1000)).returning()
    );
    expect(await storageBytes(tenantId)).toBe(1000);
    await withTenantTx(tenantId, (tx) => tx.delete(versions).where(eq(versions.id, v!.id)));
    expect(await storageBytes(tenantId)).toBe(0);
  });

  it('a page version (size_bytes null) leaves storage alone', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const documentId = await seedDocument(tenantId);
    await withTenantTx(tenantId, (tx) => tx.insert(versions).values(versionRow(tenantId, documentId, null)));
    expect(await storageBytes(tenantId)).toBe(0);
  });

  it('cp_list_tenants works as kinote_app with no tenant set', async () => {
    const { reset } = await createTestDb();
    await reset();
    const first = await seedTenant(new Date('2026-01-01T00:00:00Z'));
    const second = await seedTenant(new Date('2026-02-01T00:00:00Z'));
    const page1 = rowsOf<{ id: string }>(await getDb().execute(sql`SELECT id FROM cp_list_tenants(NULL, 1)`));
    expect(page1.map((r) => r.id)).toEqual([first]);
    const page2 = rowsOf<{ id: string }>(
      await getDb().execute(sql`SELECT id FROM cp_list_tenants(${first}::uuid, 10)`)
    );
    expect(page2.map((r) => r.id)).toEqual([second]);
  });
});
