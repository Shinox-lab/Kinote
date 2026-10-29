// The upload-API source on real Postgres 17 + pgvector (pnpm test:pg), as the app role:
// a script's PUT is read and indexed, a replacing PUT swaps the chunks, DELETE takes the
// file out of the index in the same transaction as the removal mark, and a PUT racing a
// DELETE always ends in one of the two consistent states.
//
// TEST_DATABASE_URL is the kinote_app role; TEST_DATABASE_MIGRATE_URL is the postgres
// superuser, used only to look at rows (one statement, one snapshot) and to clean up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb, getDb, initDb, sources } from '@kinote/db';
import { eq } from 'drizzle-orm';
import { InMemoryObjectStorage } from '@kinote/shared';
import { FakeExtractor } from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildApiServer } from '../src/server.js';
import { uploadRequest } from './support/multipart.js';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;

const pdf = (text: string) =>
  `%PDF-1.7\nFAKE-EXTRACT\n${JSON.stringify({
    pageCount: 1,
    ocrUsed: false,
    sections: [{ headingPath: [], pageFrom: 1, pageTo: 1, kind: 'text', text }],
  })}`;

describe.skipIf(!APP_URL)('sources on real Postgres', () => {
  const storage = new InMemoryObjectStorage();
  const app = buildApiServer({ storage, authRateLimit: { max: 1000, timeWindow: '1 minute' } });
  const extractor = new FakeExtractor();
  let owner: pg.Pool;
  const emails: string[] = [];
  let tenantId = '';
  let ownerHeaders: Record<string, string> = {};
  let sourceId = '';
  let token = '';

  const put = (id: string, text: string) =>
    app.inject({
      ...uploadRequest(`/api/v1/source/files/${encodeURIComponent(id)}`, { authorization: `Bearer ${token}` }, { name: `${id}.pdf`, data: pdf(text) }),
      method: 'PUT',
    });
  const del = (id: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/source/files/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${token}` } });
  const settle = () => runPendingJobsForTenant(tenantId, { storage, extractor });
  const search = async (query: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers: ownerHeaders, payload: { query } });
    expect(res.statusCode).toBe(200);
    return res.json().passages as Array<{ documentId: string; text: string }>;
  };
  /** One statement, so one snapshot: the removal mark and the chunk count are read together. */
  const snapshot = async (documentId: string) => {
    const res = await owner.query<{ removed: boolean; chunks: string; live: string }>(
      `SELECT d.source_deleted_at IS NOT NULL AS removed,
              (SELECT count(*) FROM chunks c WHERE c.document_id = d.id) AS chunks,
              (SELECT count(*) FROM versions v WHERE v.document_id = d.id
                 AND v.status IN ('extracting','pending_review','indexing','indexed')) AS live
         FROM documents d WHERE d.id = $1`,
      [documentId]
    );
    const row = res.rows[0]!;
    return { removed: row.removed, chunks: Number(row.chunks), live: Number(row.live) };
  };

  beforeAll(async () => {
    if (!OWNER_URL) throw new Error('TEST_DATABASE_MIGRATE_URL must be set with TEST_DATABASE_URL');
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 4 });
    initDb({ url: APP_URL!, max: 8 });

    const email = `src-pg-${randomUUID()}@example.test`;
    emails.push(email);
    const signUp = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-up',
      payload: { email, name: 'Src PG', password: 'correct-horse-battery' },
    });
    expect(signUp.statusCode).toBe(201);
    const session = signUp.json().session.token as string;
    const slug = `src-pg-${randomUUID().slice(0, 8)}`;
    const created = await app.inject({
      method: 'POST', url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${session}` }, payload: { name: slug, slug },
    });
    expect(created.statusCode).toBe(201);
    tenantId = created.json().tenant.id;
    ownerHeaders = { authorization: `Bearer ${session}`, 'x-tenant-id': tenantId };
    const space = await app.inject({
      method: 'POST', url: '/api/v1/spaces', headers: ownerHeaders,
      payload: { name: 'Feed', slug: 'feed', review_required: false },
    });
    expect(space.statusCode).toBe(201);
    const source = await app.inject({
      method: 'POST', url: '/api/v1/sources', headers: ownerHeaders,
      payload: { name: 'PG feed', target_space_id: space.json().id },
    });
    expect(source.statusCode).toBe(201);
    sourceId = source.json().id;
    // A trusted source in a space without review: its files are indexed with no human step.
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/sources/${sourceId}`, headers: ownerHeaders, payload: { trusted: true } })).statusCode).toBe(200);
    const issued = await app.inject({ method: 'POST', url: `/api/v1/sources/${sourceId}/tokens`, headers: ownerHeaders, payload: { name: 'pg' } });
    expect(issued.statusCode).toBe(201);
    token = issued.json().token;
  });

  afterAll(async () => {
    if (tenantId) {
      const client = await owner.connect();
      try {
        await client.query('SET session_replication_role = replica');
        const tables = await client.query(
          `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`
        );
        for (const { table_name } of tables.rows) await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [tenantId]);
        await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
        await client.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
      } finally {
        client.release();
      }
    }
    await owner?.end();
    await app.close();
    await closeDb();
  });

  it('indexes a PUT, swaps the chunks on a replacing PUT and leaves the index with DELETE', async () => {
    const first = await put('swap', 'Pangolin ledger, first edition.');
    expect(first.statusCode).toBe(201);
    const id = first.json().document.id as string;
    await settle();
    expect((await search('pangolin ledger first edition')).filter((p) => p.documentId === id)[0]!.text).toContain('first edition');

    expect((await put('swap', 'Pangolin ledger, second edition.')).statusCode).toBe(201);
    await settle();
    const after = (await search('pangolin ledger edition')).filter((p) => p.documentId === id);
    expect(after.map((p) => p.text.includes('second edition'))).toEqual([true]);

    expect((await del('swap')).statusCode).toBe(200);
    expect((await search('pangolin ledger edition')).filter((p) => p.documentId === id)).toEqual([]);
    expect(await snapshot(id)).toEqual({ removed: true, chunks: 0, live: 0 });
  });

  it('never shows a removed file that still has chunks, even while the DELETE runs', async () => {
    const first = await put('atomic', 'Quokka atomic removal text.');
    const id = first.json().document.id as string;
    await settle();
    expect((await snapshot(id)).chunks).toBeGreaterThan(0);

    let done = false;
    const removal = del('atomic').finally(() => {
      done = true;
    });
    const seen: Array<{ removed: boolean; chunks: number }> = [];
    while (!done) seen.push(await snapshot(id));
    await removal;
    seen.push(await snapshot(id));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.filter((s) => s.removed && s.chunks > 0)).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ removed: true, chunks: 0 });
  });

  it('ends in a consistent state when a PUT and a DELETE race, twenty times', async () => {
    for (let i = 0; i < 20; i++) {
      const ext = `race-${i}`;
      const base = await put(ext, `Race base text number ${i}.`);
      const id = base.json().document.id as string;
      await settle();
      await Promise.all([put(ext, `Race changed text number ${i}.`), del(ext)]);
      await settle();
      const s = await snapshot(id);
      const item = await owner.query<{ deleted: boolean }>(
        'SELECT deleted_at IS NOT NULL AS deleted FROM source_items WHERE document_id = $1',
        [id]
      );
      expect(item.rows[0]!.deleted, `${ext}: item and document disagree`).toBe(s.removed);
      if (s.removed) expect(s, `${ext}: removed but live`).toMatchObject({ chunks: 0, live: 0 });
      else expect(s.live, `${ext}: revived with nothing live`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the app role can pause a source but never delete one', async () => {
    await getDb().update(sources).set({ status: 'paused' }).where(eq(sources.id, sourceId));
    const refused = await getDb().delete(sources).where(eq(sources.id, sourceId)).then(
      () => null,
      (err: { cause?: { code?: string } }) => err
    );
    expect(refused).not.toBeNull();
    expect(refused?.cause?.code === '42501' || String(refused).includes('permission denied')).toBe(true);
  });
});
