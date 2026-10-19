import { badgeTone, type BadgeTone } from '../lib/wiki.js';

const TONE: Record<BadgeTone, string> = {
  ok: 'bg-emerald-100 text-emerald-900',
  danger: 'bg-red-100 text-red-900',
  muted: 'bg-slate-200 text-slate-800',
  pending: 'bg-amber-100 text-amber-900',
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
