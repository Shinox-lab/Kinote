import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { AppError, type TenantRole } from '@kinote/contracts';
import { invitations, memberships, tenantLimits, tenantStorage, type DbTransaction } from '@kinote/db';

// Seat and storage limits. Every check runs inside the transaction that writes
// the row, after locking the workspace's limits row, so two concurrent invites
// or uploads cannot both take the last seat or the last bytes. A check that
// cannot read the limits lets the write through (billing never takes the
// product down) — but only behind a savepoint, so the caller's transaction survives.

/** Members plus unexpired, unaccepted invitations, both with a role other than viewer. Agents never count. */
export async function countSeats(
  tx: DbTransaction,
  tenantId: string,
  now: Date,
  o: { excludeInvitationId?: string; excludeEmail?: string } = {}
): Promise<number> {
  const [members] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), ne(memberships.role, 'viewer')));
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invitations)
    .where(
      and(
        eq(invitations.tenantId, tenantId),
        ne(invitations.role, 'viewer'),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now),
        o.excludeInvitationId ? ne(invitations.id, o.excludeInvitationId) : undefined,
        o.excludeEmail ? sql`lower(${invitations.email}) <> lower(${o.excludeEmail})` : undefined
      )
    );
  return (members?.n ?? 0) + (pending?.n ?? 0);
}

/** The workspace's limits row, locked for this transaction; null when it has none. Throws on read errors. */
async function lockedLimits(tx: DbTransaction, tenantId: string) {
  const [row] = await tx.select().from(tenantLimits).where(eq(tenantLimits.tenantId, tenantId)).for('update');
  return row ?? null;
}

/** Runs `check` behind a savepoint; a read failure (not an AppError) lets the write through. */
async function failOpen(tx: DbTransaction, what: string, check: (sp: DbTransaction) => Promise<void>): Promise<void> {
  try {
    await tx.transaction(check);
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(`[usage] ${what} limit unavailable; allowed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Refuses with `seat_limit_reached` when one more `role` would exceed the seat
 * limit. Viewers never take a seat. For a re-invite pass `excludeEmail` (their
 * pending invitation is replaced); for a viewer promoted, call it with the new role.
 */
export async function assertSeatFor(
  tx: DbTransaction,
  tenantId: string,
  role: TenantRole,
  now: Date,
  o: { excludeInvitationId?: string; excludeEmail?: string } = {}
): Promise<void> {
  if (role === 'viewer') return;
  await failOpen(tx, 'seat', async (sp) => {
    const limits = await lockedLimits(sp, tenantId);
    if (limits?.seats === null || limits?.seats === undefined) return;
    if ((await countSeats(sp, tenantId, now, o)) + 1 > limits.seats) throw new AppError('seat_limit_reached');
  });
}

/** Refuses with `storage_limit_reached` when `addBytes` more would exceed the storage limit. */
export async function assertStorageFor(tx: DbTransaction, tenantId: string, addBytes: number): Promise<void> {
  await failOpen(tx, 'storage', async (sp) => {
    const limits = await lockedLimits(sp, tenantId);
    if (limits?.storageBytes === null || limits?.storageBytes === undefined) return;
    const [row] = await sp.select({ bytes: tenantStorage.bytes }).from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId));
    if (Number(row?.bytes ?? 0) + addBytes > Number(limits.storageBytes)) throw new AppError('storage_limit_reached');
  });
}
