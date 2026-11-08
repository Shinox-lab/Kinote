import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DbTransaction } from './client.js';
import { jobs } from './schema/foundations.js';
import { creditTopups, tenantDefaults, tenantLimits, tenantStorage, tenantUsage, usageEvents } from './schema/usage.js';
import { tenantBilling, type BillingState } from './schema/billing.js';

// Plans, usage and quotas: periods, the usage ledger, running totals and top-ups.
// Every function takes a tenant transaction (RLS applies).

export type UsageKind = 'capture' | 'ask' | 'index';

/** Queues whose work is charged to the index pool and held at its limit. */
export const INDEX_QUEUES = ['version.index', 'document.reindex', 'version.card', 'version.entities'] as const;

export interface UsagePeriod {
  /** The start date, YYYY-MM-DD (UTC). */
  key: string;
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** The UTC period containing `now` for a workspace whose periods start on `anchorDay` (1–28). */
export function periodOf(anchorDay: number, now: Date): UsagePeriod {
  const year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() < anchorDay) month -= 1;
  const start = new Date(Date.UTC(year, month, anchorDay));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, anchorDay));
  return { key: start.toISOString().slice(0, 10), start, end };
}

export interface TenantLimits {
  seats: number | null;
  storageBytes: number | null;
  creditsPerMonth: number | null;
  indexCreditsPerMonth: number | null;
  gracePercent: number;
  periodAnchorDay: number;
}

export interface UsageStanding {
  limits: TenantLimits | null;
  period: UsagePeriod;
  creditsUsedMilli: number;
  indexCreditsUsedMilli: number;
  creditsTopup: number;
  storageBytes: number;
  warned80At: Date | null;
  warned100At: Date | null;
  /** Suspended for billing by the control plane: read-only, indexing held. */
  suspended: boolean;
}

async function readLimits(tx: DbTransaction, tenantId: string): Promise<TenantLimits | null> {
  const [row] = await tx.select().from(tenantLimits).where(eq(tenantLimits.tenantId, tenantId));
  if (!row) return null;
  return {
    seats: row.seats,
    storageBytes: row.storageBytes === null ? null : Number(row.storageBytes),
    creditsPerMonth: row.creditsPerMonth,
    indexCreditsPerMonth: row.indexCreditsPerMonth,
    gracePercent: row.gracePercent,
    periodAnchorDay: row.periodAnchorDay,
  };
}

export interface TenantDefaultsRow {
  plan: string;
  seats: number | null;
  storageBytes: number | null;
  creditsPerMonth: number | null;
  indexCreditsPerMonth: number | null;
  gracePercent: number;
  maxFreePerOwner: number | null;
}

/** The control plane's defaults for new workspaces, or null when none were pushed. Not tenant-scoped. */
export async function readTenantDefaults(tx: Pick<DbTransaction, 'select'>): Promise<TenantDefaultsRow | null> {
  const [row] = await tx.select().from(tenantDefaults).where(eq(tenantDefaults.id, true));
  if (!row) return null;
  return {
    plan: row.plan,
    seats: row.seats,
    storageBytes: row.storageBytes === null ? null : Number(row.storageBytes),
    creditsPerMonth: row.creditsPerMonth,
    indexCreditsPerMonth: row.indexCreditsPerMonth,
    gracePercent: row.gracePercent,
    maxFreePerOwner: row.maxFreePerOwner,
  };
}

/** The billing state the control plane set; no row is `ok`. */
export async function readBillingState(tx: DbTransaction, tenantId: string): Promise<{ state: BillingState; manageUrl: string | null }> {
  const [row] = await tx.select().from(tenantBilling).where(eq(tenantBilling.tenantId, tenantId));
  return row ? { state: row.state, manageUrl: row.manageUrl } : { state: 'ok', manageUrl: null };
}

/** A workspace's limits and its usage in the period containing `now`. No limits row: anchor day 1. */
export async function readStanding(tx: DbTransaction, tenantId: string, now: Date): Promise<UsageStanding> {
  const limits = await readLimits(tx, tenantId);
  const period = periodOf(limits?.periodAnchorDay ?? 1, now);
  const [usage] = await tx
    .select()
    .from(tenantUsage)
    .where(and(eq(tenantUsage.tenantId, tenantId), eq(tenantUsage.period, period.key)));
  const [storage] = await tx.select().from(tenantStorage).where(eq(tenantStorage.tenantId, tenantId));
  return {
    limits,
    period,
    creditsUsedMilli: Number(usage?.creditsUsedMilli ?? 0),
    indexCreditsUsedMilli: Number(usage?.indexCreditsUsedMilli ?? 0),
    creditsTopup: usage?.creditsTopup ?? 0,
    storageBytes: Number(storage?.bytes ?? 0),
    warned80At: usage?.warned80At ?? null,
    warned100At: usage?.warned100At ?? null,
    suspended: (await readBillingState(tx, tenantId)).state === 'suspended',
  };
}

export interface UsageEventInput {
  kind: UsageKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  millicredits: number;
  principalId?: string | null;
  documentId?: string | null;
}

/** Appends ledger rows and adds them to the period's totals; returns the standing after. */
export async function recordUsage(
  tx: DbTransaction,
  tenantId: string,
  events: UsageEventInput[],
  now: Date
): Promise<UsageStanding> {
  const limits = await readLimits(tx, tenantId);
  const period = periodOf(limits?.periodAnchorDay ?? 1, now);
  if (events.length > 0) {
    await tx.insert(usageEvents).values(
      events.map((e) => ({
        tenantId,
        period: period.key,
        at: now,
        kind: e.kind,
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        estimated: e.estimated,
        millicredits: e.millicredits,
        principalId: e.principalId ?? null,
        documentId: e.documentId ?? null,
      }))
    );
    const credits = events.filter((e) => e.kind !== 'index').reduce((n, e) => n + e.millicredits, 0);
    const index = events.filter((e) => e.kind === 'index').reduce((n, e) => n + e.millicredits, 0);
    await tx
      .insert(tenantUsage)
      .values({ tenantId, period: period.key, creditsUsedMilli: credits, indexCreditsUsedMilli: index })
      .onConflictDoUpdate({
        target: [tenantUsage.tenantId, tenantUsage.period],
        set: {
          creditsUsedMilli: sql`${tenantUsage.creditsUsedMilli} + ${credits}`,
          indexCreditsUsedMilli: sql`${tenantUsage.indexCreditsUsedMilli} + ${index}`,
        },
      });
  }
  return readStanding(tx, tenantId, now);
}

/** Records that the period's 80% or 100% warning was sent. True only for the first caller. */
export async function markWarned(
  tx: DbTransaction,
  tenantId: string,
  periodKey: string,
  level: 80 | 100,
  now: Date
): Promise<boolean> {
  const column = level === 80 ? tenantUsage.warned80At : tenantUsage.warned100At;
  const field = level === 80 ? 'warned80At' : 'warned100At';
  await tx.insert(tenantUsage).values({ tenantId, period: periodKey }).onConflictDoNothing();
  const updated = await tx
    .update(tenantUsage)
    .set({ [field]: now })
    .where(and(eq(tenantUsage.tenantId, tenantId), eq(tenantUsage.period, periodKey), sql`${column} IS NULL`))
    .returning({ tenantId: tenantUsage.tenantId });
  return updated.length > 0;
}

/**
 * Adds `credits` to the current period's Capture and Ask pool. A repeated
 * `idempotencyKey` adds nothing and reports `created: false` with the period it
 * was first added to.
 */
export async function addTopup(
  tx: DbTransaction,
  tenantId: string,
  credits: number,
  idempotencyKey: string,
  now: Date
): Promise<{ created: boolean; periodKey: string; creditsTopup: number }> {
  const limits = await readLimits(tx, tenantId);
  const period = periodOf(limits?.periodAnchorDay ?? 1, now);
  const inserted = await tx
    .insert(creditTopups)
    .values({ tenantId, period: period.key, credits, idempotencyKey })
    .onConflictDoNothing()
    .returning({ period: creditTopups.period });
  let periodKey = period.key;
  if (inserted.length > 0) {
    await tx
      .insert(tenantUsage)
      .values({ tenantId, period: period.key, creditsTopup: credits })
      .onConflictDoUpdate({
        target: [tenantUsage.tenantId, tenantUsage.period],
        set: { creditsTopup: sql`${tenantUsage.creditsTopup} + ${credits}` },
      });
  } else {
    const [existing] = await tx
      .select({ period: creditTopups.period })
      .from(creditTopups)
      .where(and(eq(creditTopups.tenantId, tenantId), eq(creditTopups.idempotencyKey, idempotencyKey)));
    periodKey = existing!.period;
  }
  const [usage] = await tx
    .select({ creditsTopup: tenantUsage.creditsTopup })
    .from(tenantUsage)
    .where(and(eq(tenantUsage.tenantId, tenantId), eq(tenantUsage.period, periodKey)));
  return { created: inserted.length > 0, periodKey, creditsTopup: usage?.creditsTopup ?? 0 };
}

/** Makes index jobs held for later due now (after a limit is raised or removed). Returns how many. */
export async function releaseHeldIndexJobs(tx: DbTransaction, tenantId: string, now: Date): Promise<number> {
  const moved = await tx
    .update(jobs)
    .set({ runAt: now })
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.status, 'queued'),
        inArray(jobs.queue, [...INDEX_QUEUES]),
        gt(jobs.runAt, now)
      )
    )
    .returning({ id: jobs.id });
  return moved.length;
}
