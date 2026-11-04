import type { UsageSummary } from '@kinote/contracts';

// Pure helpers behind the credit banner and the Usage screen (unit tested).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Dec": when credits renew, in UTC (periods are UTC). */
export function renewsOn(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The console banner for this workspace's billing or credits, or null when there is nothing to say. */
export function bannerText(u: UsageSummary): string | null {
  // A billing problem comes before credits.
  if (u.billingState === 'suspended') return 'This workspace is suspended';
  if (u.billingState === 'past_due') return 'Payment failed — update billing';
  switch (u.state) {
    case 'warn':
      return "This workspace has used 80% of this month's AI credits.";
    case 'over':
      return `Over this month's AI credits: ${Math.floor(u.graceLeftCredits ?? 0)} left before AI actions pause.`;
    case 'exhausted':
      return `This workspace has used this month's AI credits. They renew on ${renewsOn(u.resetsAt)}.`;
    default:
      return null;
  }
}

const number = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

/** "12.5 of 100", or just "12.5" with no limit; `fmt` formats both (e.g. bytes). */
export function usedOf(used: number, limit: number | null, fmt: (n: number) => string = number): string {
  return limit === null ? fmt(used) : `${fmt(used)} of ${fmt(limit)}`;
}

/** Bytes as people read them: 0 B, 1.5 MB, 2 GB. */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : Number(value.toFixed(1))} ${units[unit]}`;
}
