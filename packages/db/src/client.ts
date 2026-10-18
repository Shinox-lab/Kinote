import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as foundations from './schema/foundations.js';
import * as pagesAndIndex from './schema/pages_and_index.js';

export const schema = { ...foundations, ...pagesAndIndex };

// Shared in-memory Postgres client (single process, zero infrastructure).
// Boots with the pgvector extension available; migration 0000 creates it.
// To run against a real PostgreSQL server, replace this with:
//   const client = new PGlite(process.env.DATABASE_URL)   // or new Pool(...)
//   export const db = drizzle({ client, schema });
export const pglite = new PGlite({ extensions: { vector } });

export const db = drizzle({ client: pglite, schema });
export type DbClient = typeof db;
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Locate packages/db/migrations both when running from source
// (packages/db/src -> ../migrations) and from the compiled bundle
// (dist/packages/db/src -> ../../../../packages/db/migrations).
function findMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../..', 'packages/db/migrations'),
    path.resolve(here, '../migrations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'meta', '_journal.json'))) return candidate;
  }
  throw new Error(
    `Unable to locate packages/db/migrations (looked in: ${candidates.join(', ')})`
  );
}

const MIGRATIONS_DIR = findMigrationsDir();

/**
 * Test-support reset: wipes the in-memory database and re-applies the
 * migration chain in packages/db/migrations with Drizzle's migrator, exactly
 * as a fresh deployment would (0000 extensions -> 0001 schema -> 0002 RLS ->
 * 0003 functions -> 0004 grants).
 */
export async function resetForTests(): Promise<void> {
  // RESET ROLE first: the previous test may still run as living_wiki_app.
  await pglite.exec('RESET ROLE;');
  // Drop everything, including the extension (so 0000 really creates it) and
  // the drizzle schema holding the migrator's bookkeeping table.
  await pglite.exec(`
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP EXTENSION IF EXISTS vector CASCADE;
    CREATE SCHEMA public;
  `);
  // Roles are cluster-wide and survive the schema drop. In a deployment the
  // login role comes from infra/postgres/01-roles.sh; 0004 only creates a
  // NOLOGIN role when it is absent.
  await pglite.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'living_wiki_app') THEN
        CREATE ROLE living_wiki_app LOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // PGlite runs as a superuser, which would silently bypass all RLS policies.
  // Run the workload as the non-superuser app role so policies enforce.
  await pglite.exec('SET ROLE living_wiki_app;');
}

// Attach on the db instance so callers can invoke db.__resetForTests().
(db as unknown as { __resetForTests: () => Promise<void> }).__resetForTests = resetForTests;
