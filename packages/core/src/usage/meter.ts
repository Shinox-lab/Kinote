import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, inArray } from 'drizzle-orm';
import {
  markWarned,
  memberships,
  recordUsage,
  withTenantTx,
  type DbTransaction,
  type UsageKind,
  type UsageStanding,
} from '@kinote/db';
import { millicreditsFor, type CreditRates } from '@kinote/shared';
import { notify } from '../talk/notify.js';

// Metering: model providers report each call with reportModelCall; the api and
// the worker open a usage scope around the work that makes them. When the scope
// closes, its calls go into the ledger and the period's totals in one
// transaction. Billing must never take the product down: a flush failure is
// logged, never thrown.

export interface UsageScope {
  tenantId: string;
  kind: UsageKind;
  principalId?: string | null;
  documentId?: string | null;
  /** Time the calls are charged at (tests, the worker's clock). Default: wall clock. */
  clock?: () => Date;
}

export interface ModelCall {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider reported no usage and tokens were estimated. */
  estimated: boolean;
}

interface OpenScope {
  scope: UsageScope;
  calls: ModelCall[];
}

const storage = new AsyncLocalStorage<OpenScope>();
let warnedUnscoped = false;

/** Tokens for text a provider did not count: 4 characters a token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Records one model call against the open usage scope. Outside a scope it is dropped (logged once). */
export function reportModelCall(call: ModelCall): void {
  const open = storage.getStore();
  if (!open) {
    if (!warnedUnscoped) {
      warnedUnscoped = true;
      console.warn(`[usage] a model call (${call.model}) was made outside a usage scope; it is not metered`);
    }
    return;
  }
  open.calls.push(call);
}

/**
 * Runs `fn` with a usage scope open. The model calls it makes are charged to
 * the scope's workspace and kind when it settles, whether it succeeds or throws.
 */
export async function withUsageScope<T>(
  scope: UsageScope,
  rates: CreditRates | null,
  fn: () => Promise<T>
): Promise<T> {
  const open: OpenScope = { scope, calls: [] };
  try {
    return await storage.run(open, fn);
  } finally {
    await flush(open, rates);
  }
}

async function flush(open: OpenScope, rates: CreditRates | null): Promise<void> {
  if (open.calls.length === 0) return;
  const { scope } = open;
  const now = scope.clock?.() ?? new Date();
  try {
    await withTenantTx(scope.tenantId, async (tx) => {
      const standing = await recordUsage(
        tx,
        scope.tenantId,
        open.calls.map((c) => ({
          kind: scope.kind,
          model: c.model,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          estimated: c.estimated,
          millicredits: millicreditsFor(rates, c.model, c.inputTokens, c.outputTokens),
          principalId: scope.principalId ?? null,
          documentId: scope.documentId ?? null,
        })),
        now
      );
      if (scope.kind !== 'index') await sendWarnings(tx, scope.tenantId, standing, now);
    });
  } catch (err) {
    console.error(
      `[usage] recording ${open.calls.length} model call(s) for workspace ${scope.tenantId} failed:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * The first time a period reaches 80% and 100% of its credits (plan plus
 * top-ups), every owner and admin is notified once. Reaching both at once
 * marks both and sends only the 100% one.
 */
async function sendWarnings(tx: DbTransaction, tenantId: string, s: UsageStanding, now: Date): Promise<void> {
  const perMonth = s.limits?.creditsPerMonth;
  if (perMonth === null || perMonth === undefined) return;
  const limitMilli = (perMonth + s.creditsTopup) * 1000;
  const used = s.creditsUsedMilli;
  let level: 80 | 100 | null = null;
  if (used >= limitMilli * 0.8 && (await markWarned(tx, tenantId, s.period.key, 80, now))) level = 80;
  if (used >= limitMilli && (await markWarned(tx, tenantId, s.period.key, 100, now))) level = 100;
  if (level === null) return;
  const admins = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), inArray(memberships.role, ['owner', 'admin'])));
  await notify(
    tx,
    tenantId,
    admins.map((a) => ({
      recipientId: a.userId,
      kind: 'credits_warning' as const,
      actorType: 'connector' as const,
      actorId: tenantId,
      excerpt: String(level),
    }))
  );
}
