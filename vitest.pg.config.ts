// Real-Postgres suite: `pnpm test:pg`. Runs only `*.pg.test.ts`, which need
// TEST_DATABASE_URL (the living_wiki_app role) and TEST_DATABASE_MIGRATE_URL
// (the postgres superuser) pointing at a migrated database (`pnpm stack:up`);
// each file skips itself when TEST_DATABASE_URL is unset.
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
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
});
