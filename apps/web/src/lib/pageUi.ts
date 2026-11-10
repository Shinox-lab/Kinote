import type { PageWidth } from '@kinote/contracts';
import { useEffect, useRef, useSyncExternalStore } from 'react';

// Which page's history drawer is open, and which tab it should show. The
// status chip lives in the page screen, so the state is shared here, outside React.

export type HistoryTab = 'versions' | 'changes';
interface OpenHistory {
  pageId: string;
  tab: HistoryTab;
}

let openFor: OpenHistory | null = null;
const listeners = new Set<() => void>();

function set(next: OpenHistory | null): void {
  if (openFor?.pageId === next?.pageId && openFor?.tab === next?.tab) return;
  openFor = next;
  for (const l of [...listeners]) l();
}

export const getHistoryOpenFor = (): string | null => openFor?.pageId ?? null;
export const getHistoryTab = (): HistoryTab => openFor?.tab ?? 'versions';
export const openHistory = (pageId: string, tab: HistoryTab = 'versions'): void =>
  set({ pageId, tab });
export const closeHistory = (): void => set(null);

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Whether the history drawer is open for this page. */
export function useHistoryOpen(pageId: string): boolean {
  return useSyncExternalStore(subscribeHistory, () => openFor?.pageId === pageId, () => false);
}

/** The tab the drawer should open on for this page (null when it is closed). */
export function useHistoryTab(pageId: string): HistoryTab | null {
  return useSyncExternalStore(
    subscribeHistory,
    () => (openFor?.pageId === pageId ? openFor.tab : null),
    () => null
  );
}

/** The page column for each width. Tailwind sees the full class names here, so they are never purged. */
const PAGE_WIDTH_CLASS: Record<PageWidth, string> = {
  default: 'max-w-[660px]',
  wide: 'max-w-[960px]',
  full: 'max-w-none',
};

/** The column class of a page's width; a page without one (an older server) reads at the default width. */
export function pageWidthClass(width: PageWidth | undefined): string {
  return PAGE_WIDTH_CLASS[width ?? 'default'];
}

export const PAGE_WIDTH_OPTIONS: ReadonlyArray<{ value: PageWidth; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
];

/** localStorage key for the one width every page reads at. */
export const PAGE_WIDTH_KEY = 'lw-page-width';

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The remembered width; the default column when nothing usable is stored or storage is unavailable. */
export function loadPageWidth(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): PageWidth {
  try {
    const stored = storage?.getItem(PAGE_WIDTH_KEY);
    return PAGE_WIDTH_OPTIONS.find((o) => o.value === stored)?.value ?? 'default';
  } catch {
    return 'default';
  }
}

/** Remembers the width for every page; never throws (a private window or blocked storage just forgets it). */
export function savePageWidth(width: PageWidth, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()): void {
  try {
    storage?.setItem(PAGE_WIDTH_KEY, width);
  } catch {
    // The choice still applies to this visit.
  }
}

// One width for every page, shared by the page and the account menu.
let width: PageWidth | null = null;
const widthListeners = new Set<() => void>();

export function getPageWidth(): PageWidth {
  return (width ??= loadPageWidth());
}

export function setPageWidth(next: PageWidth): void {
  if (getPageWidth() === next) return;
  width = next;
  savePageWidth(next);
  for (const listener of [...widthListeners]) listener();
}

function subscribePageWidth(listener: () => void): () => void {
  widthListeners.add(listener);
  return () => void widthListeners.delete(listener);
}

/** The width every page reads at, re-rendering when the account menu changes it. */
export function usePageWidth(): PageWidth {
  return useSyncExternalStore(subscribePageWidth, getPageWidth, () => 'default');
}

/**
 * Calls `refetch` whenever `value` changes after it was first seen (undefined while loading is not a value). The page
 * screen passes the polled count of unindexed changes, so the page and its status chip follow edits made in this
 * tab or another one, and indexing that happened by itself, without a reload.
 */
export function useRefetchWhenChanged(value: number | undefined, refetch: () => void): void {
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (value === undefined) return;
    const before = seen.current;
    seen.current = value;
    if (before !== undefined && before !== value) refetch();
  }, [value]);
}
