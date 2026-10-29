// CLI: applies packages/db/migrations to the database at DATABASE_MIGRATE_URL.
// Usage: DATABASE_MIGRATE_URL=postgres://owner:...@host/db pnpm db:migrate
//
// DATABASE_MIGRATE_URL must be the schema owner (not kinote_app): the chain
// creates the extension, tables, RLS policies, SECURITY DEFINER functions and
// grants. Exits non-zero on any failure.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATE_URL;
  if (!url) throw new Error('DATABASE_MIGRATE_URL is not set');

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: MIGRATIONS_DIR });
    console.log(`migrations applied from ${MIGRATIONS_DIR}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('migration failed:', err);
  process.exit(1);
});
