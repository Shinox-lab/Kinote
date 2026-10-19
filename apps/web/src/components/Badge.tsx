import { badgeTone, type BadgeTone } from '../lib/wiki.js';

const TONE: Record<BadgeTone, string> = {
  ok: 'bg-success-bg text-success',
  danger: 'bg-danger-bg text-danger',
  muted: 'bg-hover text-muted',
  pending: 'bg-dot-review/15 text-fg',
};

/** The page's status exactly as the server wrote it; the browser only colours it. */
export function Badge({ badge }: { badge: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Page status: ${badge}`}
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[badgeTone(badge)]}`}
    >
      {badge}
    </span>
  );
}
