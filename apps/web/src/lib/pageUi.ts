import type { PageWidth } from '@kinote/contracts';
import { useSyncExternalStore } from 'react';

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
