// The file pipeline on real Postgres 17 + pgvector (pnpm test:pg): replacing a file swaps
// its chunks in one transaction, so a search that runs while the new version is being
// indexed always finds the document: the old text until the swap, the new text after it.
//
// TEST_DATABASE_URL is the living_wiki_app role (RLS applies to everything the api and
// worker do); TEST_DATABASE_MIGRATE_URL is the postgres superuser, used only to clean up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb, initDb } from '@living-wiki/db';
import { InMemoryObjectStorage } from '@living-wiki/shared';
import { FakeExtractor } from '@living-wiki/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildApiServer } from '../src/server.js';
import { uploadRequest } from './support/multipart.js';

const APP_URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_DATABASE_MIGRATE_URL;

describe.skipIf(!APP_URL)('files on real Postgres: replacing swaps the chunks in one step', () => {
  const storage = new InMemoryObjectStorage();
  const app = buildApiServer({ storage, authRateLimit: { max: 1000, timeWindow: '1 minute' } });
  let owner: pg.Pool;
  const emails: string[] = [];
  let tenantId = '';

  const signUp = async (name: string) => {
    const email = `files-pg-${randomUUID()}@example.test`;
    emails.push(email);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      payload: { email, name, password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().session.token as string;
  };

  beforeAll(async () => {
    if (!OWNER_URL) throw new Error('TEST_DATABASE_MIGRATE_URL must be set with TEST_DATABASE_URL');
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 2 });
    initDb({ url: APP_URL!, max: 6 });
  });

  afterAll(async () => {
    if (tenantId) {
      const client = await owner.connect();
      try {
        // Every table with a tenant_id, children first is not needed with triggers off.
        await client.query('SET session_replication_role = replica');
        const tables = await client.query(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'tenant_id'`
        );
        for (const { table_name } of tables.rows) {
          await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [tenantId]);
        }
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

  it('never leaves a search without the document while a replacement is indexed', async () => {
    const token = await signUp('Files PG');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Files PG ${randomUUID().slice(0, 8)}`, slug: `files-pg-${randomUUID().slice(0, 8)}` },
    });
    expect(created.statusCode).toBe(201);
    tenantId = created.json().tenant.id;
    const headers = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantId };

    const first = await app.inject(
      uploadRequest('/api/v1/files', headers, { name: 'rules.txt', data: 'Zebra crossing rules, first edition.' })
    );
    expect(first.statusCode).toBe(201);
    const fileId: string = first.json().document.id;
    const settle = () => runPendingJobsForTenant(tenantId, { storage, extractor: new FakeExtractor() });
    await settle();

    const search = async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/search', headers, payload: { query: 'zebra crossing rules' } });
      expect(res.statusCode).toBe(200);
      return (res.json().passages as Array<{ documentId: string; text: string }>).filter((p) => p.documentId === fileId);
    };
    expect((await search())[0]!.text).toContain('first edition');

    const second = await app.inject(
      uploadRequest(`/api/v1/files/${fileId}/versions`, headers, { name: 'rules.txt', data: 'Zebra crossing rules, second edition.' })
    );
    expect(second.statusCode).toBe(201);

    let done = false;
    const swap = settle().finally(() => {
      done = true;
    });
    const seen: string[][] = [];
    while (!done) {
      seen.push((await search()).map((p) => p.text));
    }
    await swap;
    seen.push((await search()).map((p) => p.text));

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((texts) => texts.length > 0)).toBe(true);
    // Never both editions at once, never a gap; the last answer is the new edition.
    expect(seen.every((texts) => new Set(texts.map((t) => (t.includes('first') ? 'first' : 'second'))).size === 1)).toBe(true);
    expect(seen.at(-1)![0]).toContain('second edition');
  });
});
