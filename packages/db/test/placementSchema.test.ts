import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../src/testing.js';
import { entities, normalizeEntityName, rowsOf, tenants, withTenantTx } from '../src/index.js';

async function seedTenant() {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) =>
    tx.insert(tenants).values({ id: tenantId, name: `t-${tenantId}`, slug: `t-${tenantId}` })
  );
  return tenantId;
}

const entity = (tenantId: string, name: string) => ({
  tenantId,
  kind: 'person' as const,
  name,
  normalizedName: normalizeEntityName(name),
  aliases: [],
  nameEmbedding: new Array<number>(2560).fill(0.01),
});

describe('placement schema', () => {
  it('normalizes entity names', () => {
    expect(normalizeEntityName('  Aisha   RAHMAN ')).toBe('aisha rahman');
    expect(normalizeEntityName('@aisha')).toBe('aisha');
  });

  it('keeps one entity per tenant, kind and normalized name', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    await withTenantTx(tenantId, (tx) => tx.insert(entities).values(entity(tenantId, 'Aisha Rahman')));
    await expect(
      withTenantTx(tenantId, (tx) => tx.insert(entities).values(entity(tenantId, 'aisha  rahman')))
    ).rejects.toThrow();
  });

  it('has pg_trgm loaded', async () => {
    const { reset } = await createTestDb();
    await reset();
    const tenantId = await seedTenant();
    const rows = await withTenantTx(tenantId, async (tx) =>
      rowsOf<{ close: boolean }>(
        await tx.execute(sql`SELECT similarity('aisha rahman', 'aisha rahmn') > 0.5 AS close`)
      )
    );
    expect(rows[0]!.close).toBe(true);
  });

  it('hides another tenant\'s entities', async () => {
    const { reset } = await createTestDb();
    await reset();
    const a = await seedTenant();
    const b = await seedTenant();
    await withTenantTx(b, (tx) => tx.insert(entities).values(entity(b, 'Secret')));
    const seen = await withTenantTx(a, (tx) => tx.select().from(entities));
    expect(seen).toEqual([]);
  });
});
