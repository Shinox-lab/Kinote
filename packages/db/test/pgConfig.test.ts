import { describe, expect, it } from 'vitest';
import { assertPgTestEnv } from '../../../vitest.pg.config';

describe('pnpm test:pg refuses to run without a real database', () => {
  it('throws, naming the variables, when either is unset or empty', () => {
    const url = 'postgres://kinote_app:x@127.0.0.1:55543/kinote';
    for (const env of [
      {},
      { TEST_DATABASE_URL: url },
      { TEST_DATABASE_MIGRATE_URL: url },
      { TEST_DATABASE_URL: '', TEST_DATABASE_MIGRATE_URL: url },
    ]) {
      expect(() => assertPgTestEnv(env)).toThrow(/TEST_DATABASE_URL and TEST_DATABASE_MIGRATE_URL/);
    }
  });

  it('passes when both are set', () => {
    expect(() =>
      assertPgTestEnv({ TEST_DATABASE_URL: 'postgres://a', TEST_DATABASE_MIGRATE_URL: 'postgres://b' })
    ).not.toThrow();
  });
});
