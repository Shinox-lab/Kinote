// Test support: an in-memory PGlite database with the real migration chain.
// Kept out of index.ts so production code never loads PGlite.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { initDb, schema, type Db } from './client.js';

// packages/db/migrations, next to this file's src directory (tests run the
// TypeScript sources; there is no compiled bundle).
function findMigrationsDir(): string {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  if (!fs.existsSync(path.join(dir, 'meta', '_journal.json'))) {
    throw new Error(`Unable to locate packages/db/migrations (looked in: ${dir})`);
  }
  return dir;
}

export interface TestDb {
  db: Db;
  pglite: PGlite;
  /** Empties every public table; the workload keeps running as `living_wiki_app`. */
  reset(): Promise<void>;
}

/**
 * Creates a fresh in-memory database (pgvector available), applies the
 * migration chain exactly as a deployment would, installs it as the module
 * instance via `initDb`, then switches to the non-superuser `living_wiki_app`
 * role so row-level security is enforced (a superuser would bypass it).
 */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite({ extensions: { vector, pg_trgm } });
  // Roles are cluster-wide; in a deployment the login role comes from
  // infra/postgres/01-roles.sh.
  await pglite.exec('CREATE ROLE living_wiki_app LOGIN NOSUPERUSER NOBYPASSRLS;');
  const drizzled = drizzle({ client: pglite, schema });
  await migrate(drizzled, { migrationsFolder: findMigrationsDir() });
  const db = initDb({ db: drizzled as unknown as Db, close: () => pglite.close() });
  await pglite.exec('SET ROLE living_wiki_app;');

  async function reset(): Promise<void> {
    // RESET ROLE: truncating and reading the catalog need the owner, and the
    // previous test may have left the session as the app role.
    await pglite.exec('RESET ROLE;');
    try {
      await pglite.exec(`
        DO $$
        DECLARE tables text;
        BEGIN
          SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
            INTO tables FROM pg_tables WHERE schemaname = 'public';
          IF tables IS NOT NULL THEN
            EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
          END IF;
        END
        $$;
      `);
    } finally {
      await pglite.exec('SET ROLE living_wiki_app;');
    }
  }

  return { db, pglite, reset };
}
