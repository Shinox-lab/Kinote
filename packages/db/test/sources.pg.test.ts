// The sources tables against a real Postgres as the app role (pnpm test:pg):
// tenant isolation, and that a source can never be deleted (only paused).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initDb, sourceItems, sources, sourceTokens, spaces, tenants, users, withTenantTx, documents } from '../src/index.js';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;

describe.skipIf(!APP_URL)('sources on real Postgres (app role)', () => {
  let owner: pg.Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userId = randomUUID();
  const sourceA = randomUUID();
  const docA = randomUUID();

  beforeAll(async () => {
    if (!OWNER_URL) throw new Error('TEST_DATABASE_MIGRATE_URL must be set with TEST_DATABASE_URL');
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
    initDb({ url: APP_URL!, max: 4 });
    await getDb().insert(users).values({ id: userId, email: `src-${userId}@example.test`, name: 'Src', passwordHash: 'x' });
    for (const id of [tenantA, tenantB]) {
      await withTenantTx(id, async (tx) => {
        await tx.insert(tenants).values({ id, name: `src-${id}`, slug: `src-${id}` });
      });
    }
    const spaceA = randomUUID();
    await withTenantTx(tenantA, async (tx) => {
      await tx.insert(spaces).values({ id: spaceA, tenantId: tenantA, name: 'S', slug: 's', createdBy: userId });
      await tx.insert(sources).values({ id: sourceA, tenantId: tenantA, kind: 'upload_api', name: 'Reports', targetSpaceId: spaceA, createdBy: userId });
      await tx.insert(documents).values({ id: docA, tenantId: tenantA, spaceId: spaceA, kind: 'file', title: 'a', createdByType: 'connector', createdBy: sourceA, sourceId: sourceA });
      await tx.insert(sourceItems).values({ tenantId: tenantA, sourceId: sourceA, externalId: 'e', documentId: docA, contentHash: 'h' });
      await tx.insert(sourceTokens).values({ tenantId: tenantA, sourceId: sourceA, name: 't', tokenHash: `h-${sourceA}`, tokenPrefix: 'abcd1234', createdBy: userId });
    });
  });

  afterAll(async () => {
    if (owner) {
      const ids = [tenantA, tenantB];
      for (const table of ['source_items', 'source_tokens', 'documents', 'sources', 'spaces', 'audit_events']) {
        await owner.query(`DELETE FROM public.${table} WHERE tenant_id = ANY($1::uuid[])`, [ids]);
      }
      await owner.query('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [ids]);
      await owner.query('DELETE FROM public.users WHERE id = $1', [userId]);
      await owner.end();
    }
    await closeDb();
  });

  it("another tenant sees none of a tenant's sources, items or tokens", async () => {
    const seen = await withTenantTx(tenantB, async (tx) => ({
      sources: await tx.select().from(sources),
      items: await tx.select().from(sourceItems),
      tokens: await tx.select().from(sourceTokens),
    }));
    expect(seen).toEqual({ sources: [], items: [], tokens: [] });
    const own = await withTenantTx(tenantA, (tx) => tx.select().from(sources));
    expect(own).toHaveLength(1);
  });

  it('the app role cannot delete a source, but can update one', async () => {
    const refused = await withTenantTx(tenantA, (tx) => tx.delete(sources).where(eq(sources.id, sourceA))).then(
      () => null,
      (err: { cause?: { code?: string; message?: string } }) => err
    );
    expect(refused?.cause).toMatchObject({ code: '42501', message: expect.stringMatching(/permission denied/i) });
    await withTenantTx(tenantA, (tx) => tx.update(sources).set({ trusted: true }).where(eq(sources.id, sourceA)));
    const [row] = await withTenantTx(tenantA, (tx) => tx.select().from(sources));
    expect(row!.trusted).toBe(true);
  });

  it('a source in another tenant cannot be written to', async () => {
    await expect(
      withTenantTx(tenantB, (tx) =>
        tx.insert(sourceItems).values({ tenantId: tenantA, sourceId: sourceA, externalId: 'x', documentId: randomUUID(), contentHash: 'h' })
      )
    ).rejects.toThrow();
  });
});
