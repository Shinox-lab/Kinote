import { sql } from 'drizzle-orm';
import { rowsOf, type DbTransaction } from './client.js';

/**
 * Takes the tenant's routing lease for `seconds` when it is free, expired or
 * already `holder`'s (a renewal). False when another holder has it: only one
 * capture of a tenant is routed at a time (R13).
 */
export async function acquireRoutingLease(
  tx: DbTransaction,
  tenantId: string,
  holder: string,
  seconds: number
): Promise<boolean> {
  const rows = rowsOf<{ holder: string }>(
    await tx.execute(sql`
      INSERT INTO routing_leases (tenant_id, holder, expires_at)
      VALUES (${tenantId}, ${holder}, clock_timestamp() + make_interval(secs => ${seconds}))
      ON CONFLICT (tenant_id) DO UPDATE
        SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
        WHERE routing_leases.holder = EXCLUDED.holder OR routing_leases.expires_at < clock_timestamp()
      RETURNING holder`)
  );
  return rows.length === 1;
}

/** Gives the lease back, only if `holder` still has it. */
export async function releaseRoutingLease(tx: DbTransaction, tenantId: string, holder: string): Promise<void> {
  await tx.execute(sql`DELETE FROM routing_leases WHERE tenant_id = ${tenantId} AND holder = ${holder}`);
}
