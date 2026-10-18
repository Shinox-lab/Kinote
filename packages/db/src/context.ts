import { sql } from 'drizzle-orm';
import { getDb, type DbTransaction } from './client.js';

export async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: DbTransaction) => Promise<T>,
  existingTx?: DbTransaction
): Promise<T> {
  if (existingTx) {
    // Reuse the enclosing transaction (avoids nested db.transaction calls,
    // which PGlite's single-connection client cannot do).
    await existingTx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(existingTx);
  }
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export async function withUntenantedTx<T>(
  fn: (tx: DbTransaction) => Promise<T>
): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
    return fn(tx);
  });
}
