import type { UsageStanding } from '@kinote/db';

// Where a workspace stands against its credit limits (pure; the caller reads the
// standing). L = credits_per_month + top-ups; G = L × (1 + grace_percent/100).
// Comparisons are done in whole millicredits × 100 so no float rounding moves a boundary.

export type CreditState = 'unlimited' | 'ok' | 'warn' | 'over' | 'exhausted';

export interface CreditVerdict {
  state: CreditState;
  usedCredits: number;
  limitCredits: number | null;
  /** Credits left before AI actions pause (G − used, at least 0); null when unlimited. */
  graceLeftCredits: number | null;
  resetsAt: Date;
}

/** Capture and Ask: `warn` at 80% of L, `over` at 100%, `exhausted` at G. */
export function creditVerdict(s: UsageStanding): CreditVerdict {
  const used = s.creditsUsedMilli;
  const base = { usedCredits: used / 1000, resetsAt: s.period.end };
  const perMonth = s.limits?.creditsPerMonth;
  if (perMonth === null || perMonth === undefined) {
    return { ...base, state: 'unlimited', limitCredits: null, graceLeftCredits: null };
  }
  const limitCredits = perMonth + s.creditsTopup;
  const limitMilli = limitCredits * 1000;
  const graceTimes100 = limitMilli * (100 + s.limits!.gracePercent);
  const state: CreditState =
    used * 100 >= graceTimes100 ? 'exhausted' : used >= limitMilli ? 'over' : used * 100 >= limitMilli * 80 ? 'warn' : 'ok';
  const graceLeftCredits = Math.max(0, graceTimes100 / 100 - used) / 1000;
  return { ...base, state, limitCredits, graceLeftCredits };
}

/**
 * Indexing waits once index credits reach index_credits_per_month × (1 + grace), and while the
 * workspace is suspended for billing. Top-ups never add here.
 */
export function indexHeld(s: UsageStanding): boolean {
  if (s.suspended) return true;
  const perMonth = s.limits?.indexCreditsPerMonth;
  if (perMonth === null || perMonth === undefined) return false;
  return s.indexCreditsUsedMilli * 100 >= perMonth * 1000 * (100 + s.limits!.gracePercent);
}
