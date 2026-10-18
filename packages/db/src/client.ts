import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import * as foundations from './schema/foundations.js';
import * as pagesAndIndex from './schema/pages_and_index.js';

export const schema = { ...foundations, ...pagesAndIndex };

// Shared in-memory Postgres client (single process, zero infrastructure).
// Boots with the pgvector extension loaded so migration 0002's halfvec columns work.
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
    if (fs.existsSync(path.join(candidate, '0001_rls_policies.sql'))) return candidate;
  }
  throw new Error(
    `Unable to locate packages/db/migrations (looked in: ${candidates.join(', ')})`
  );
}

const MIGRATIONS_DIR = findMigrationsDir();

/**
 * Test-support reset: wipes the in-memory database and re-applies every
 * migration in packages/db/migrations in filename order (0000 tables -> 0001
 * RLS -> 0002 pgvector/FTS).
 */
export async function resetForTests(): Promise<void> {
  // Drop everything (RESET ROLE first: the previous session may still run as
  // living_wiki_app), then recreate the schema as the owner and re-apply the
  // migration sequence before handing the session back to the app role.
  await pglite.exec('RESET ROLE;');
  await pglite.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  // The table DDL (0000) references pgvector's halfvec type, so the extension
  // must exist before any migration file runs.
  await pglite.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await pglite.exec(sql);
  }
  // PGlite runs as a superuser, which would silently bypass all RLS policies.
  // Run the workload as the non-superuser app role so policies enforce.
  await pglite.exec('SET ROLE living_wiki_app;');
}

// Attach on the db instance so callers can invoke db.__resetForTests().
(db as unknown as { __resetForTests: () => Promise<void> }).__resetForTests = resetForTests;
