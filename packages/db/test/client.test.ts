import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '@living-wiki/shared';
import { createTestDb } from '../src/testing.js';
import { getDb, rowsOf, withTenantTx } from '../src/index.js';

const VALID_ENV = {
  DATABASE_URL: 'postgres://living_wiki_app:pw@localhost:5432/living_wiki',
  COLLAB_TOKEN_SECRET: 'a'.repeat(32),
  INTERNAL_SECRET: 'b'.repeat(32),
};

describe('db client factory', () => {
  it('getDb() before initDb throws', () => {
    expect(() => getDb()).toThrow('db not initialised');
  });

  it('createTestDb() runs as the non-superuser app role', async () => {
    const { db } = await createTestDb();
    const res = await db.execute(sql`select current_user as u`);
    expect(rowsOf<{ u: string }>(res)[0].u).toBe('living_wiki_app');
    expect(getDb()).toBe(db);
  });

  it('withTenantTx sets app.tenant_id for the transaction only', async () => {
    const { reset } = await createTestDb();
    await reset();
    const id = randomUUID();
    const inside = await withTenantTx(id, async (tx) => {
      const r = await tx.execute(sql`select current_setting('app.tenant_id', true) as t`);
      return rowsOf<{ t: string }>(r)[0].t;
    });
    expect(inside).toBe(id);
    const after = await getDb().execute(sql`select current_setting('app.tenant_id', true) as t`);
    expect([null, '']).toContain(rowsOf<{ t: string | null }>(after)[0].t);
  });

  it('reset() keeps the app role', async () => {
    const { db, reset } = await createTestDb();
    await reset();
    const res = await db.execute(sql`select current_user as u`);
    expect(rowsOf<{ u: string }>(res)[0].u).toBe('living_wiki_app');
  });
});

describe('loadConfig', () => {
  it('throws naming the missing variables', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({})).toThrow(/COLLAB_TOKEN_SECRET/);
  });

  it('applies defaults for a valid environment', () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.API_PORT).toBe(8787);
    expect(cfg.COLLAB_PORT).toBe(1234);
    expect(cfg.EMBEDDING_DIMENSIONS).toBe(1536);
    expect(cfg.EMBEDDING_PROVIDER).toBe('deterministic');
    expect(cfg.COLLAB_INTERNAL_URL).toBe('http://127.0.0.1:1234');
    expect(cfg.S3_REGION).toBe('us-east-1');
    expect(cfg.DATABASE_MIGRATE_URL).toBeUndefined();
  });

  it('coerces numeric variables from strings', () => {
    const cfg = loadConfig({ ...VALID_ENV, API_PORT: '9000', EMBEDDING_DIMENSIONS: '768' });
    expect(cfg.API_PORT).toBe(9000);
    expect(cfg.EMBEDDING_DIMENSIONS).toBe(768);
  });

  it('rejects EMBEDDING_DIMENSIONS above 4000', () => {
    expect(() => loadConfig({ ...VALID_ENV, EMBEDDING_DIMENSIONS: '5000' })).toThrow(
      /EMBEDDING_DIMENSIONS/
    );
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(() => loadConfig({ ...VALID_ENV, INTERNAL_SECRET: 'short' })).toThrow(/INTERNAL_SECRET/);
  });
});
