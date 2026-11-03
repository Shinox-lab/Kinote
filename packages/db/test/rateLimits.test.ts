import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../src/testing.js';
import {
  clearCounter,
  deleteExpiredCounters,
  getDb,
  hitCounter,
  hitLimit,
  readCounter,
  rowsOf,
} from '../src/index.js';

describe('shared rate-limit counters', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  beforeEach(async () => {
    await testDb.reset();
  });

  it('counts hits in one window and reports the time left', async () => {
    expect((await hitCounter('a', 60_000)).count).toBe(1);
    const second = await hitCounter('a', 60_000);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeGreaterThan(55_000);
    expect(second.ttlMs).toBeLessThanOrEqual(60_000);
    expect((await hitCounter('b', 60_000)).count).toBe(1);
    expect(await readCounter('a')).toMatchObject({ count: 2 });
  });

  it('starts again at 1 once the window has ended', async () => {
    await hitCounter('a', 60_000);
    await hitCounter('a', 60_000);
    await getDb().execute(sql`UPDATE rate_limit_counters SET reset_at = now() - interval '1 second'`);
    expect(await readCounter('a')).toEqual({ count: 0, ttlMs: 0 });
    const fresh = await hitCounter('a', 60_000);
    expect(fresh.count).toBe(1);
    expect(fresh.ttlMs).toBeGreaterThan(55_000);
  });

  it('counts concurrent hits exactly', async () => {
    const counts = await Promise.all(Array.from({ length: 25 }, () => hitCounter('busy', 60_000)));
    expect(counts.map((c) => c.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('hitLimit allows up to max and then says how long to wait', async () => {
    expect(await hitLimit('l', 2, 60_000)).toMatchObject({ allowed: true, count: 1, retryAfterMs: 0 });
    expect(await hitLimit('l', 2, 60_000)).toMatchObject({ allowed: true, count: 2 });
    const third = await hitLimit('l', 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('clears one key, and sweeps only windows that ended before the grace period', async () => {
    await hitCounter('keep', 60_000);
    await hitCounter('gone', 60_000);
    await hitCounter('old', 60_000);
    await clearCounter('gone');
    await getDb().execute(sql`UPDATE rate_limit_counters SET reset_at = now() - interval '2 hours' WHERE key = 'old'`);
    expect(await deleteExpiredCounters()).toBe(1);
    const keys = rowsOf<{ key: string }>(await getDb().execute(sql`SELECT key FROM rate_limit_counters ORDER BY key`));
    expect(keys.map((k) => k.key)).toEqual(['keep']);
  });
});
