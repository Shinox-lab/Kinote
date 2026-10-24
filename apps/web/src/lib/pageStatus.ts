import type { PageDetails } from '@living-wiki/contracts';
import { badgeTone } from './wiki.js';

export type PageStatusState = 'clean' | 'changed' | 'review' | 'failed' | 'muted' | 'pending';
export type PageStatusTone = 'ok' | 'warn' | 'review' | 'bad' | 'muted' | 'pending';

export interface PageStatusInfo {
  state: PageStatusState;
  /** The server's badge text, except the changed state, which the client composes. */
  label: string;
  tone: PageStatusTone;
  /** The indexed version's creation time, for the relative time beside the chip. */
  indexedAt: string | null;
}

export type PageStatusInput = Pick<
  PageDetails,
  'badge' | 'liveChangedSinceSnapshot' | 'latestVersion' | 'indexedVersion'
>;

/**
 * The one page status: in review wins over everything (a pending version is
 * waiting for a person), then a failure (retry is more urgent than the count),
 * then unindexed changes, then the server badge's own tone.
 */
export function pageStatus(page: PageStatusInput, changedCount: number): PageStatusInfo {
  const indexedAt = page.indexedVersion?.createdAt ?? null;

  if (page.latestVersion?.status === 'pending_review') {
    return { state: 'review', label: page.badge, tone: 'review', indexedAt };
  }

  const tone = badgeTone(page.badge);
  if (tone === 'danger') {
    return { state: 'failed', label: page.badge, tone: 'bad', indexedAt };
  }

  if (page.liveChangedSinceSnapshot) {
    return {
      state: 'changed',
      label:
        changedCount === 0
          ? 'Unindexed changes'
          : `${changedCount} unindexed ${changedCount === 1 ? 'change' : 'changes'}`,
      tone: 'warn',
      indexedAt,
    };
  }

  if (tone === 'ok') return { state: 'clean', label: page.badge, tone: 'ok', indexedAt };
  if (tone === 'muted') return { state: 'muted', label: page.badge, tone: 'muted', indexedAt };
  return { state: 'pending', label: page.badge, tone: 'pending', indexedAt };
}

/** "2h ago" from a version's timestamp; the exact date after a week. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(new Date(then).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}
