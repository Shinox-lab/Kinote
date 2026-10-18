import { test, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// Guard test for the migration chain. Every case runs against a FRESH PGlite
// database that only has the pgvector extension *available* (not created):
// nothing is pre-created, the Drizzle migrator alone must build everything.

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations'
);

type Journal = { entries: { idx: number; when: number; tag: string }[] };

function readJournal(): Journal {
  const file = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
}

describe('migration chain', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  async function rows<T = Record<string, unknown>>(query: string): Promise<T[]> {
    return (await client.query<T>(query)).rows;
  }

  let vectorBefore = -1;
  let migrateError: unknown = null;

  beforeAll(async () => {
    client = new PGlite({ extensions: { vector } });
    db = drizzle({ client });
    vectorBefore = (await rows(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).length;
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    } catch (err) {
      migrateError = err;
    }
  });

  afterAll(async () => {
    await client.close();
  });

  test('meta/_journal.json `when` values are strictly increasing', () => {
    const { entries } = readJournal();
    assert.ok(entries.length > 0, 'journal has no entries');
    for (let i = 1; i < entries.length; i++) {
      assert.ok(
        entries[i]!.when > entries[i - 1]!.when,
        `journal entry ${entries[i]!.tag} (when=${entries[i]!.when}) is not after ` +
          `${entries[i - 1]!.tag} (when=${entries[i - 1]!.when}); the Drizzle migrator would skip it`
      );
    }
  });

  test('a fresh database with nothing pre-created migrates (vector extension created by the chain)', async () => {
    assert.equal(vectorBefore, 0, 'vector extension must not exist before migrating');
    assert.equal(migrateError, null, `fresh migrate failed: ${String(migrateError)}`);

    const after = await rows(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    assert.equal(after.length, 1, 'migration chain must create the vector extension');

    const applied = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
    );
    assert.equal(applied[0]!.n, readJournal().entries.length, 'every journal entry is applied');
  });

  test('migrating twice is a no-op', async () => {
    const snapshot = async () =>
      rows(`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
    const first = await snapshot();
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    const second = await snapshot();
    assert.deepEqual(second, first);
  });

  test('every tenant table has RLS enabled and forced with a policy; only tenants/users/sessions lack tenant_id', async () => {
    const tables = await rows<{
      relname: string;
      has_tenant_id: boolean;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(`
      SELECT c.relname,
             EXISTS (
               SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public' AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id'
             ) AS has_tenant_id,
             c.relrowsecurity,
             c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    assert.ok(tables.length > 0, 'no public tables were created');

    const tenantTables = tables.filter((t) => t.has_tenant_id);
    assert.ok(tenantTables.length > 0, 'no tables with a tenant_id column');
    for (const t of tenantTables) {
      assert.equal(t.relrowsecurity, true, `${t.relname}: row level security not enabled`);
      assert.equal(t.relforcerowsecurity, true, `${t.relname}: row level security not forced`);
      assert.ok(t.policies >= 1, `${t.relname}: no RLS policy`);
    }

    const withoutTenantId = tables
      .filter((t) => !t.has_tenant_id)
      .map((t) => t.relname)
      .sort();
    assert.deepEqual(withoutTenantId, ['sessions', 'tenants', 'users']);

    const tenants = tables.find((t) => t.relname === 'tenants')!;
    assert.equal(tenants.relrowsecurity, true, 'tenants: row level security not enabled');
    assert.equal(tenants.relforcerowsecurity, true, 'tenants: row level security not forced');
    assert.ok(tenants.policies >= 1, 'tenants: no RLS policy');
  });

  test('the app role exists and cannot bypass RLS', async () => {
    const role = await rows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'living_wiki_app'`
    );
    assert.equal(role.length, 1, 'living_wiki_app role missing');
    assert.equal(role[0]!.rolsuper, false);
    assert.equal(role[0]!.rolbypassrls, false);
  });

  test('chunks has the HNSW embedding index and a GIN index on tsv', async () => {
    const indexes = await rows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'chunks'`
    );
    const hnsw = indexes.find((i) => i.indexname === 'chunks_embedding_hnsw_idx');
    assert.ok(hnsw, 'chunks_embedding_hnsw_idx missing');
    assert.match(hnsw.indexdef, /USING hnsw \(embedding halfvec_cosine_ops\)/);

    const gin = indexes.find((i) => /USING gin \(tsv\)/.test(i.indexdef));
    assert.ok(gin, `no GIN index on chunks.tsv (indexes: ${indexes.map((i) => i.indexname).join(', ')})`);

    const tsv = await rows<{ data_type: string; is_generated: string; generation_expression: string }>(
      `SELECT data_type, is_generated, generation_expression FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'chunks' AND column_name = 'tsv'`
    );
    assert.equal(tsv.length, 1, 'chunks.tsv missing');
    assert.equal(tsv[0]!.data_type, 'tsvector');
    assert.equal(tsv[0]!.is_generated, 'ALWAYS');
    assert.match(tsv[0]!.generation_expression, /to_tsvector\('simple'::regconfig, text\)/);
  });

  test('no migration file contains a password', () => {
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
      const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      assert.doesNotMatch(sqlText, /password\s+'/i, `${file} contains a hard-coded password`);
    }
  });
});
