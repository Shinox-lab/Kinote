import { sql } from 'drizzle-orm';
import { rowsOf, type Db } from './client.js';

/**
 * Start-up guard: the `chunks.embedding` column is declared `halfvec(2560)` by
 * the migration chain. Fails fast (naming the declared type) instead of at the
 * first insert.
 */
export async function assertEmbeddingDimensions(db: Db, expected: number): Promise<void> {
  const result = await db.execute(sql`
    select format_type(a.atttypid, a.atttypmod) as declared
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    where c.relname = 'chunks'
      and c.relnamespace = 'public'::regnamespace
      and a.attname = 'embedding'
      and not a.attisdropped
  `);
  const declared = rowsOf<{ declared: string }>(result)[0]?.declared;
  if (declared === undefined) {
    throw new Error('chunks.embedding column not found; has the database been migrated?');
  }
  if (declared !== `halfvec(${expected})`) {
    throw new Error(
      `chunks.embedding is ${declared} but the index expects halfvec(${expected}); ` +
        `run the 2560 migration.`
    );
  }
}
