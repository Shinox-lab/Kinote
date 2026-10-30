import { useCallback, useState } from 'react';
import type { AskResponse } from '@kinote/contracts';

// A person's recent searches in one workspace, kept in this browser so they can pick one up again. An answer is
// kept with its search, so continuing shows it at once instead of asking the model again.

export interface RecentSearch {
  q: string;
  /** A space id, or '' for all spaces. */
  space: string;
  /** When it was last run (ISO). */
  at: string;
  answer?: AskResponse;
}

export const RECENT_MAX = 10;

const same = (a: Pick<RecentSearch, 'q' | 'space'>, b: Pick<RecentSearch, 'q' | 'space'>) =>
  a.space === b.space && a.q.trim().toLowerCase() === b.q.trim().toLowerCase();

/** `entry` at the top: an earlier run of the same search is folded in, keeping its answer unless `entry` has one. */
export function addRecent(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  const earlier = list.find((r) => same(r, entry));
  const answer = entry.answer ?? earlier?.answer;
  const next: RecentSearch = { q: entry.q.trim(), space: entry.space, at: entry.at, ...(answer ? { answer } : {}) };
  return [next, ...list.filter((r) => !same(r, entry))].slice(0, RECENT_MAX);
}

export function removeRecent(list: readonly RecentSearch[], entry: RecentSearch): RecentSearch[] {
  return list.filter((r) => !same(r, entry));
}

export const recentKey = (tenantId: string, userId: string) => `kinote.recent-searches.${tenantId}.${userId}`;

function load(key: string): RecentSearch[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as RecentSearch[]).filter((r) => typeof r?.q === 'string' && typeof r?.space === 'string') : [];
  } catch {
    return [];
  }
}

function save(key: string, list: RecentSearch[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage full or blocked: recent searches are a convenience, so they simply aren't kept.
  }
}

/** The list for one person and workspace, with `add` and `remove` that also store it. */
export function useRecentSearches(tenantId: string, userId: string) {
  const key = recentKey(tenantId, userId);
  const [list, setList] = useState<RecentSearch[]>(() => load(key));
  const update = useCallback(
    (change: (current: RecentSearch[]) => RecentSearch[]) => {
      const next = change(load(key));
      save(key, next);
      setList(next);
    },
    [key],
  );
  return {
    list,
    add: useCallback((entry: RecentSearch) => update((current) => addRecent(current, entry)), [update]),
    remove: useCallback((entry: RecentSearch) => update((current) => removeRecent(current, entry)), [update]),
  };
}
