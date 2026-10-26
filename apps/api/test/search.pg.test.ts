// Search on real Postgres 17 + pgvector (pnpm test:pg): the vector branch must
// be answered from the HNSW index, which pgvector can only use when the
// ORDER BY ranks `chunks` directly (no join, no CTE beneath it).
//
// TEST_DATABASE_URL is the living_wiki_app role (every search goes through
// withTenantTx, so RLS applies); TEST_DATABASE_MIGRATE_URL is the postgres
// superuser, used only to bulk-seed ~2,000 chunks, ANALYZE and clean up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { closeDb, initDb, rowsOf, withTenantTx } from '@living-wiki/db';
import type { Actor } from '@living-wiki/core';
import {
  BRANCH_LIMIT,
  chunkFilterFor,
  searchSql,
  searchWiki,
  vectorBranchSql,
} from '@living-wiki/core';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;

const DIMS = 2560;
const CHUNKS_PER_SPACE = 500;

/** A random unit vector as a halfvec text literal. */
function randomUnitVector(): string {
  const v = Array.from({ length: DIMS }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return `[${v.map((x) => (x / norm).toFixed(5)).join(',')}]`;
}

describe.skipIf(!APP_URL)('search on real Postgres: chunk-row filter uses the HNSW index', () => {
  let owner: pg.Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const me = randomUUID();
  const other = randomUUID();
  // Tenant A: two normal spaces and the Inbox. Tenant B: one normal space.
  const spaceA1 = randomUUID();
  const spaceA2 = randomUUID();
  const inboxA = randomUUID();
  const spaceB1 = randomUUID();
  const query = randomUnitVector();

  const member: Actor = { tenantId: tenantA, principalType: 'user', principalId: me, tenantRole: 'member' };

  beforeAll(async () => {
    if (!OWNER_URL) throw new Error('TEST_DATABASE_MIGRATE_URL must be set with TEST_DATABASE_URL');
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
    initDb({ url: APP_URL!, max: 4 });

    for (const id of [me, other]) {
      await owner.query(
        `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Search', 'not-a-real-hash')`,
        [id, `search-pg-${id}@example.test`]
      );
    }
    for (const id of [tenantA, tenantB]) {
      await owner.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)`, [id, `search-pg-${id}`]);
    }

    const layout: Array<{ tenantId: string; spaceId: string; kind: 'normal' | 'inbox' }> = [
      { tenantId: tenantA, spaceId: spaceA1, kind: 'normal' },
      { tenantId: tenantA, spaceId: spaceA2, kind: 'normal' },
      { tenantId: tenantA, spaceId: inboxA, kind: 'inbox' },
      { tenantId: tenantB, spaceId: spaceB1, kind: 'normal' },
    ];
    for (const { tenantId, spaceId, kind } of layout) {
      await owner.query(
        `INSERT INTO spaces (id, tenant_id, name, slug, kind, created_by) VALUES ($1, $2, $3, $3, $4, $5)`,
        [spaceId, tenantId, `s-${spaceId}`, kind, me]
      );
      // Two documents per space; in the Inbox one is mine, one is someone else's.
      for (const creator of [me, other]) {
        const documentId = randomUUID();
        const versionId = randomUUID();
        await owner.query(
          `INSERT INTO documents (id, tenant_id, space_id, kind, title, created_by_type, created_by)
           VALUES ($1, $2, $3, 'page', 'Seed', 'user', $4)`,
          [documentId, tenantId, spaceId, creator]
        );
        await owner.query(
          `INSERT INTO versions (id, tenant_id, document_id, number, title, status, content_hash, reason, created_by_type, created_by)
           VALUES ($1, $2, $3, 1, 'Seed', 'indexed', 'h', 'submit', 'user', $4)`,
          [versionId, tenantId, documentId, creator]
        );
        const inboxOwner = kind === 'inbox' ? `user:${creator}` : null;
        const perDoc = CHUNKS_PER_SPACE / 2;
        for (let start = 0; start < perDoc; start += 100) {
          const values: string[] = [];
          const params: unknown[] = [];
          for (let i = start; i < Math.min(start + 100, perDoc); i++) {
            const p = params.length;
            values.push(
              `($${p + 1}::uuid, $${p + 2}::uuid, $${p + 3}::uuid, $${p + 4}::uuid, $${p + 5}::int, '{}', '{}', $${p + 6}, 8, 'h', $${p + 7}::halfvec, 'test-model', $${p + 8})`
            );
            params.push(tenantId, spaceId, documentId, versionId, i, `seed passage ${i} wombat`, randomUnitVector(), inboxOwner);
          }
          await owner.query(
            `INSERT INTO chunks (tenant_id, space_id, document_id, version_id, ordinal, heading_path, block_ids, text, token_count, content_hash, embedding, embedding_model, inbox_owner)
             VALUES ${values.join(',')}`,
            params
          );
        }
      }
    }
    await owner.query('ANALYZE chunks');
  }, 120_000);

  afterAll(async () => {
    if (owner) {
      const ids = [tenantA, tenantB];
      for (const table of ['chunks', 'versions', 'documents', 'spaces']) {
        await owner.query(`DELETE FROM public.${table} WHERE tenant_id = ANY($1::uuid[])`, [ids]);
      }
      await owner.query('DELETE FROM public.tenants WHERE id = ANY($1::uuid[])', [ids]);
      await owner.query('DELETE FROM public.users WHERE id = ANY($1::uuid[])', [[me, other]]);
      await owner.end();
    }
    await closeDb();
  });

  /**
   * EXPLAIN as the app role with iterative HNSW scans on (as production) and
   * the non-HNSW plans priced out. At 2,000 rows Postgres rightly prefers an
   * exact top-N sort over the (tenant_id, space_id) btree (cost ~127 against
   * ~116..490 for the HNSW scan), so disabling only seq scans would still not
   * show the index; disabling seq scans, bitmap scans and explicit sorts
   * leaves the HNSW scan as the cheap plan IF the query shape allows it at
   * all, which is what this suite guards (the joined-CTE shape never does: see
   * the control below).
   */
  async function explain(statement: ReturnType<typeof sql>): Promise<string> {
    return withTenantTx(tenantA, async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      await tx.execute(sql`SET LOCAL enable_sort = off`);
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      const res = await tx.execute(sql`EXPLAIN ${statement}`);
      return rowsOf<{ 'QUERY PLAN': string }>(res)
        .map((r) => r['QUERY PLAN'].replace(/'\[[-0-9.,e]+\]'/g, "'[query vector]'"))
        .join('\n');
    });
  }

  it('seeded about 2,000 chunks across two tenants', async () => {
    const res = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM chunks WHERE tenant_id = ANY($1::uuid[])',
      [[tenantA, tenantB]]
    );
    expect(Number(res.rows[0]!.n)).toBe(CHUNKS_PER_SPACE * 4);
  });

  it('plans the vector branch as an index scan on chunks_embedding_hnsw_idx', async () => {
    const filter = chunkFilterFor(member, [spaceA1, inboxA], inboxA);
    const plan = await explain(vectorBranchSql(filter, query));
    console.info(`vector branch plan:\n${plan}`);
    expect(plan).toContain('chunks_embedding_hnsw_idx');
    expect(plan).toMatch(/Index Scan using chunks_embedding_hnsw_idx on chunks/);
  });

  it('control: the previous joined-CTE shape cannot use the HNSW index under the same settings', async () => {
    const plan = await explain(sql`
      WITH accessible_chunks AS (
        SELECT c.id, c.embedding, c.tsv
        FROM chunks c
        JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE c.tenant_id = ${tenantA}::uuid
          AND c.space_id = ANY(${sql.param([spaceA1, inboxA])}::uuid[])
          AND (c.space_id <> ${inboxA}::uuid OR (d.created_by_type = 'user' AND d.created_by = ${me}::uuid))
      ),
      vector_ranked AS (
        SELECT id FROM accessible_chunks ORDER BY embedding <=> ${query}::halfvec LIMIT 40
      ),
      fts_ranked AS (
        SELECT id FROM accessible_chunks WHERE tsv @@ websearch_to_tsquery('simple', 'wombat') LIMIT 40
      )
      SELECT id FROM vector_ranked UNION ALL SELECT id FROM fts_ranked
    `);
    expect(plan).not.toContain('chunks_embedding_hnsw_idx');
  });

  it('keeps the HNSW index inside the full hybrid query', async () => {
    const filter = chunkFilterFor(member, [spaceA1, inboxA], inboxA);
    const plan = await explain(searchSql(filter, 'wombat', query, 10));
    console.info(`hybrid search plan:\n${plan}`);
    expect(plan).toMatch(/Index Scan using chunks_embedding_hnsw_idx on chunks/);
  });

  /** Owner-side truth about the given chunk ids. */
  async function describeChunks(ids: string[]) {
    const res = await owner.query<{ id: string; tenant_id: string; space_id: string; inbox_owner: string | null }>(
      'SELECT id, tenant_id, space_id, inbox_owner FROM chunks WHERE id = ANY($1::uuid[])',
      [ids]
    );
    return res.rows;
  }

  it('the vector branch returns at most its limit and only permitted chunks', async () => {
    const filter = chunkFilterFor(member, [spaceA1, inboxA], inboxA);
    const ids = await withTenantTx(tenantA, async (tx) => {
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      const res = await tx.execute(vectorBranchSql(filter, query));
      return rowsOf<{ id: string }>(res).map((r) => r.id);
    });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(BRANCH_LIMIT);
    const rows = await describeChunks(ids);
    expect(rows).toHaveLength(ids.length);
    for (const row of rows) {
      expect(row.tenant_id).toBe(tenantA);
      expect([spaceA1, inboxA]).toContain(row.space_id);
      if (row.space_id === inboxA) expect(row.inbox_owner).toBe(`user:${me}`);
    }
  });

  it('searchWiki honors the limit and the space filter as the app role', async () => {
    const passages = await withTenantTx(tenantA, (tx) =>
      searchWiki(tx, member, [spaceA2, inboxA], inboxA, 'wombat', JSON.parse(query), 7)
    );
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(7);
    const rows = await describeChunks(passages.map((p) => p.chunkId));
    for (const row of rows) {
      expect(row.tenant_id).toBe(tenantA);
      expect([spaceA2, inboxA]).toContain(row.space_id);
      if (row.space_id === inboxA) expect(row.inbox_owner).toBe(`user:${me}`);
    }
    expect(passages[0]!.citeAs).toMatch(/^Seed \(v1, updated \d{4}-\d{2}-\d{2}\)$/);

    // A tenant admin also sees the Inbox chunks of others.
    const admin: Actor = { ...member, principalId: randomUUID(), tenantRole: 'admin' };
    const adminPassages = await withTenantTx(tenantA, (tx) =>
      searchWiki(tx, admin, [inboxA], inboxA, 'wombat', JSON.parse(query), 40)
    );
    const owners = new Set((await describeChunks(adminPassages.map((p) => p.chunkId))).map((r) => r.inbox_owner));
    expect(owners).toEqual(new Set([`user:${me}`, `user:${other}`]));
  });
});
