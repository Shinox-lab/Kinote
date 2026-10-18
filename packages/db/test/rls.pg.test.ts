// Row-level security against a real Postgres 17 + pgvector (pnpm test:pg).
//
// TEST_DATABASE_URL is the living_wiki_app role; TEST_DATABASE_MIGRATE_URL is
// the postgres superuser, used here only to check that seeded rows exist and
// to clean them up. Every seed goes through withTenantTx as the app role, so
// the policies' WITH CHECK is exercised on the way in.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  initDb,
  jobs,
  memberships,
  rowsOf,
  spaces,
  tenants,
  users,
  withTenantTx,
} from '../src/index.js';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;

/** Compares dotted versions numerically: `0.8.1` >= `0.8.0`. */
function versionAtLeast(actual: string, minimum: string): boolean {
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

describe.skipIf(!APP_URL)('row-level security on real Postgres (app role)', () => {
  let owner: pg.Pool;
  // A pool of the app role used for raw statements outside drizzle.
  let app: pg.Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userId = randomUUID();
  let tenantTables: string[] = [];

  beforeAll(async () => {
    if (!OWNER_URL) throw new Error('TEST_DATABASE_MIGRATE_URL must be set with TEST_DATABASE_URL');
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
    app = new pg.Pool({ connectionString: APP_URL, max: 2 });
    initDb({ url: APP_URL!, max: 4 });

    // Two tenants, each with a space and a due job; tenant A has a member.
    await getDb().insert(users).values({
      id: userId,
      email: `rls-${userId}@example.test`,
      name: 'RLS',
      passwordHash: 'not-a-real-hash',
    });
    for (const id of [tenantA, tenantB]) {
      await withTenantTx(id, async (tx) => {
        await tx.insert(tenants).values({ id, name: `rls-${id}`, slug: `rls-${id}` });
        await tx.insert(spaces).values({ tenantId: id, name: 'Space', slug: 'space', createdBy: userId });
        await tx.insert(jobs).values({
          tenantId: id,
          queue: 'rls-test',
          idempotencyKey: randomUUID(),
          payload: {},
          runAt: new Date(Date.now() - 60_000),
        });
      });
    }
    await withTenantTx(tenantA, (tx) =>
      tx.insert(memberships).values({ tenantId: tenantA, userId, role: 'admin' }).then(() => undefined)
    );

    const res = await owner.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`
    );
    tenantTables = res.rows.map((r) => r.table_name);
  });

  afterAll(async () => {
    if (owner) {
      const ids = [tenantA, tenantB];
      for (const table of ['jobs', 'memberships', 'spaces', 'audit_events']) {
        await owner.query(`DELETE FROM public.${table} WHERE tenant_id = ANY($1::uuid[])`, [ids]);
      }
      await owner.query('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [ids]);
      await owner.query('DELETE FROM public.users WHERE id = $1', [userId]);
      await owner.end();
    }
    await app?.end();
    await closeDb();
  });

  it('runs as living_wiki_app without superuser or BYPASSRLS', async () => {
    const res = await getDb().execute(
      sql`SELECT current_user AS name, rolsuper, rolbypassrls
            FROM pg_roles WHERE rolname = current_user`
    );
    expect(rowsOf(res)).toEqual([{ name: 'living_wiki_app', rolsuper: false, rolbypassrls: false }]);
  });

  it('has RLS enabled and forced on every tenant table', async () => {
    expect(tenantTables.length).toBeGreaterThanOrEqual(18);
    const res = await owner.query<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced
         FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
      [[...tenantTables, 'tenants']]
    );
    expect(res.rows).toHaveLength(tenantTables.length + 1);
    for (const row of res.rows) expect(row, row.relname).toMatchObject({ on: true, forced: true });
  });

  it('every policy compares the tenant column with current_tenant_id()', async () => {
    const res = await owner.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, permissive, qual, with_check
         FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`
    );
    const byTable = new Map<string, typeof res.rows>();
    for (const row of res.rows) byTable.set(row.tablename, [...(byTable.get(row.tablename) ?? []), row]);

    for (const table of [...tenantTables, 'tenants']) {
      const policies = byTable.get(table) ?? [];
      expect(policies.length, `${table} has a policy`).toBeGreaterThan(0);
      const column = table === 'tenants' ? /\bid\b/ : /\btenant_id\b/;
      // Permissive policies are OR-ed, so every one must be tenant-scoped:
      // an extra USING (true) would open the table.
      for (const p of policies) {
        for (const expr of [p.qual, p.with_check]) {
          expect(expr, `${table}.${p.policyname}`).toContain('current_tenant_id()');
          expect(expr, `${table}.${p.policyname}`).toMatch(column);
        }
      }
    }
  });

  it('seeded rows exist (checked as the owner)', async () => {
    const res = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM public.jobs WHERE tenant_id = ANY($1::uuid[])',
      [[tenantA, tenantB]]
    );
    expect(Number(res.rows[0]!.n)).toBe(2);
  });

  it('without app.tenant_id every tenant table returns no rows', async () => {
    const client = await app.connect();
    try {
      const setting = await client.query(`SELECT current_setting('app.tenant_id', true) AS t`);
      expect([null, '']).toContain(setting.rows[0].t);
      for (const table of [...tenantTables, 'tenants']) {
        const res = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.${table}`);
        expect(Number(res.rows[0]!.n), table).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it("a tenant sees only its own rows", async () => {
    const seen = await withTenantTx(tenantA, async (tx) => {
      const t = rowsOf<{ id: string }>(await tx.execute(sql`SELECT id FROM public.tenants`));
      const j = rowsOf<{ tenant_id: string }>(await tx.execute(sql`SELECT tenant_id FROM public.jobs`));
      return { tenants: t.map((r) => r.id), jobTenants: [...new Set(j.map((r) => r.tenant_id))] };
    });
    expect(seen).toEqual({ tenants: [tenantA], jobTenants: [tenantA] });
  });

  it("inserting a row for another tenant violates the policy", async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      await expect(
        client.query(
          `INSERT INTO public.jobs (tenant_id, queue, idempotency_key, payload)
           VALUES ($1, 'rls-test', $2, '{}'::jsonb)`,
          [tenantB, randomUUID()]
        )
      ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('row-level security') });
      await client.query('ROLLBACK');

      // And with no tenant context at all.
      await expect(
        client.query(
          `INSERT INTO public.spaces (tenant_id, name, slug, created_by) VALUES ($1, 'x', 'x', $2)`,
          [tenantA, userId]
        )
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });

  it('pgvector is at least 0.8.0', async () => {
    const res = await getDb().execute(
      sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`
    );
    const [row] = rowsOf<{ extversion: string }>(res);
    expect(row, 'vector extension installed').toBeDefined();
    expect(versionAtLeast(row!.extversion, '0.8.0'), `vector ${row!.extversion}`).toBe(true);
  });

  it('SET LOCAL hnsw.iterative_scan = relaxed_order succeeds', async () => {
    const value = await getDb().transaction(async (tx) => {
      // Load the extension library first so the GUC is validated, not
      // accepted as an unknown placeholder.
      await tx.execute(sql`SELECT '[1,2,3]'::vector`);
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      return rowsOf<{ v: string }>(await tx.execute(sql`SELECT current_setting('hnsw.iterative_scan') AS v`))[0]!.v;
    });
    expect(value).toBe('relaxed_order');
  });

  it('tenants_with_due_jobs works as the app role without tenant context', async () => {
    const res = await getDb().execute(
      sql`SELECT public.tenants_with_due_jobs(now(), 300) AS tenant_id`
    );
    const ids = rowsOf<{ tenant_id: string }>(res).map((r) => r.tenant_id);
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB]));
  });

  it('my_tenants works as the app role without tenant context', async () => {
    const res = await getDb().execute(sql`SELECT * FROM public.my_tenants(${userId}::uuid)`);
    expect(rowsOf(res)).toEqual([
      { tenant_id: tenantA, name: `rls-${tenantA}`, slug: `rls-${tenantA}`, role: 'admin' },
    ]);
  });
});
