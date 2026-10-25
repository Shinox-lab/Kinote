import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '@living-wiki/shared';
import { createTestDb } from '../src/testing.js';
import { closeDb, getDb, initDb, rowsOf, withTenantTx, type Db } from '../src/index.js';

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

describe('initDb', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDb();
  });

  it('closes the previous instance when called again', async () => {
    const firstClose = vi.fn(async () => {});
    initDb({ db: {} as Db, close: firstClose });
    const second = {} as Db;
    initDb({ db: second, close: async () => {} });
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledTimes(1));
    expect(getDb()).toBe(second);
  });

  it('logs an idle-client pool error instead of crashing the process', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = initDb({ url: 'postgres://living_wiki_app:not-a-real-pw@127.0.0.1:1/none' });
    const pool = (db as unknown as { $client: import('node:events').EventEmitter }).$client;
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0]!.join(' ');
    expect(logged).toContain('Connection terminated unexpectedly');
    expect(logged).not.toContain('not-a-real-pw');
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
    expect(cfg.EMBEDDING_PROVIDER).toBe('deterministic');
    expect(cfg.COLLAB_INTERNAL_URL).toBe('http://127.0.0.1:1234');
    expect(cfg.S3_REGION).toBe('us-east-1');
    expect(cfg.DATABASE_MIGRATE_URL).toBeUndefined();
  });

  it('defaults HOST to 127.0.0.1 (loopback) and TRUST_PROXY to false', () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.HOST).toBe('127.0.0.1');
    expect(cfg.TRUST_PROXY).toBe(false);
  });

  it('parses TRUST_PROXY as a boolean flag or a hop count', () => {
    expect(loadConfig({ ...VALID_ENV, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...VALID_ENV, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(() => loadConfig({ ...VALID_ENV, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });

  it('coerces numeric variables from strings', () => {
    const cfg = loadConfig({ ...VALID_ENV, API_PORT: '9000' });
    expect(cfg.API_PORT).toBe(9000);
  });

  it('rejects secrets shorter than 32 characters', () => {
    expect(() => loadConfig({ ...VALID_ENV, INTERNAL_SECRET: 'short' })).toThrow(/INTERNAL_SECRET/);
  });
});
