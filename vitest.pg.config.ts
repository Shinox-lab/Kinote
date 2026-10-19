// Real-Postgres suite: `pnpm test:pg`. Runs only `*.pg.test.ts`, which need
// TEST_DATABASE_URL (the living_wiki_app role) and TEST_DATABASE_MIGRATE_URL
// (the postgres superuser) pointing at a migrated database (`pnpm stack:up`).
// Without both the run fails at once: a suite that skipped every test must
// never pass as "green". (Each file also skips itself when TEST_DATABASE_URL is
// unset, so the default `pnpm vitest run` stays database-free.)
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Throws, naming both variables, unless both are set (non-empty). */
export function assertPgTestEnv(env: Record<string, string | undefined>): void {
  if (!env.TEST_DATABASE_URL || !env.TEST_DATABASE_MIGRATE_URL) {
    throw new Error(
      'pnpm test:pg needs TEST_DATABASE_URL and TEST_DATABASE_MIGRATE_URL set to a migrated ' +
        'real Postgres (see docs/operations.md, "Local stack"); refusing to report a skipped run as passed.'
    );
  }
}

export default defineConfig(() => {
  assertPgTestEnv(process.env);
  return {
    resolve: base.resolve,
    test: {
      include: ['**/*.pg.test.ts'],
      exclude: ['**/node_modules/**'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // One file at a time against the shared database.
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
    },
  };
});
