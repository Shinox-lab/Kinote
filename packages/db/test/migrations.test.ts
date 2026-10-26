import { test, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
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
    client = new PGlite({ extensions: { vector, pg_trgm } });
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

  test('a seeded 1536 database clears old vectors and rebuilds the index at 2560', async () => {
    const legacy = new PGlite({ extensions: { vector, pg_trgm } });
    try {
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.sql'))
        .sort();
      const apply = async (file: string) => {
        const sql = fs
          .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
          .replaceAll('--> statement-breakpoint', '');
        await legacy.exec(sql);
      };

      for (const file of files.filter((file) => file < '0016')) await apply(file);

      await legacy.exec(`
        INSERT INTO tenants (id, name, slug) VALUES
          ('11111111-1111-1111-1111-111111111111', 'legacy', 'legacy');
        INSERT INTO spaces (id, tenant_id, name, slug, created_by) VALUES
          ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Docs', 'docs', '33333333-3333-3333-3333-333333333333');
        INSERT INTO documents (id, tenant_id, space_id, kind, title, latest_version_id, indexed_version_id, created_by_type, created_by) VALUES
          ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'page', 'Old page', '55555555-5555-5555-5555-555555555555', '55555555-5555-5555-5555-555555555555', 'user', '33333333-3333-3333-3333-333333333333');
        INSERT INTO versions (id, tenant_id, document_id, number, title, status, content_hash, reason, created_by_type, created_by) VALUES
          ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 1, 'Old page', 'indexed', 'h', 'quiet', 'user', '33333333-3333-3333-3333-333333333333');
        INSERT INTO chunks (tenant_id, space_id, document_id, version_id, ordinal, heading_path, block_ids, text, token_count, content_hash, embedding, embedding_model) VALUES
          ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', 0, '{}', '{}', 'old text', 2, 'c', ('[' || array_to_string(array_fill(0.1::real, ARRAY[1536]), ',') || ']')::halfvec(1536), 'old-model');
        INSERT INTO embedding_cache (tenant_id, model, content_hash, embedding) VALUES
          ('11111111-1111-1111-1111-111111111111', 'old-model', 'c', ('[' || array_to_string(array_fill(0.1::real, ARRAY[1536]), ',') || ']')::halfvec(1536));
      `);

      for (const file of files.filter((file) => file >= '0016')) await apply(file);

      const dimension = async (table: string) =>
        (
          await legacy.query<{ type: string }>(
            `SELECT format_type(atttypid, atttypmod) AS type
               FROM pg_attribute
              WHERE attrelid = '${table}'::regclass AND attname = 'embedding'`
          )
        ).rows[0]!.type;
      assert.equal(await dimension('chunks'), 'halfvec(2560)');
      assert.equal(await dimension('embedding_cache'), 'halfvec(2560)');

      const counts = await legacy.query<{ chunks: number; cache: number; versions: number; jobs: number }>(`
        SELECT
          (SELECT count(*)::int FROM chunks) AS chunks,
          (SELECT count(*)::int FROM embedding_cache) AS cache,
          (SELECT count(*)::int FROM versions) AS versions,
          (SELECT count(*)::int FROM jobs WHERE queue = 'version.index') AS jobs
      `);
      assert.deepEqual(counts.rows[0], { chunks: 0, cache: 0, versions: 1, jobs: 1 });

      const status = await legacy.query<{ status: string }>(
        `SELECT status FROM versions WHERE id = '55555555-5555-5555-5555-555555555555'`
      );
      assert.equal(status.rows[0]!.status, 'indexing');
      const index = await legacy.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'chunks'
            AND indexname = 'chunks_embedding_hnsw_idx'`
      );
      assert.equal(index.rows.length, 1);
    } finally {
      await legacy.close();
    }
  });

  test('the 2560 reindex step requeues each indexed version once', async () => {
    const tenantId = randomUUID();
    const spaceId = randomUUID();
    const documentId = randomUUID();
    const versionId = randomUUID();
    const actor = randomUUID();

    await client.exec(`
      INSERT INTO tenants (id, name, slug) VALUES ('${tenantId}', 't', 't-${tenantId}');
      INSERT INTO spaces (id, tenant_id, name, slug, created_by)
        VALUES ('${spaceId}', '${tenantId}', 's', 's', '${actor}');
      INSERT INTO documents (id, tenant_id, space_id, kind, title, created_by_type, created_by)
        VALUES ('${documentId}', '${tenantId}', '${spaceId}', 'page', 'Doc', 'user', '${actor}');
      INSERT INTO versions
        (id, tenant_id, document_id, number, title, status, content_hash, reason, created_by_type, created_by)
        VALUES ('${versionId}', '${tenantId}', '${documentId}', 1, 'Doc', 'indexed', 'h', 'quiet', 'user', '${actor}');
      DROP INDEX chunks_embedding_hnsw_idx;
    `);

    const sqlText = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '0018_embedding_2560_reindex.sql'),
      'utf8'
    );
    await client.exec(sqlText.replaceAll('--> statement-breakpoint', ''));

    const versions = await rows<{ status: string }>(
      `SELECT status FROM versions WHERE id = '${versionId}'`
    );
    assert.equal(versions[0]!.status, 'indexing');

    const jobs = await rows<{ idempotency_key: string; payload: { versionId: string }; status: string }>(
      `SELECT idempotency_key, payload, status FROM jobs WHERE tenant_id = '${tenantId}'`
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.idempotency_key, `index:${versionId}`);
    assert.equal(jobs[0]!.payload.versionId, versionId);
    assert.equal(jobs[0]!.status, 'queued');
  });

  test('no migration file contains a password', () => {
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
      const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      assert.doesNotMatch(sqlText, /password\s+'/i, `${file} contains a hard-coded password`);
    }
  });
});
