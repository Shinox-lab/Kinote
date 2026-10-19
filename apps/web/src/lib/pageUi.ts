import { useSyncExternalStore } from 'react';

// Which page's history drawer is open. The History button lives in the sidebar
// and the drawer in the page screen, so the state is shared here, outside React.

let openFor: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null): void {
  if (openFor === next) return;
  openFor = next;
  for (const l of [...listeners]) l();
}

export const getHistoryOpenFor = (): string | null => openFor;
export const openHistory = (pageId: string): void => set(pageId);
export const closeHistory = (): void => set(null);

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Whether the history drawer is open for this page. */
export function useHistoryOpen(pageId: string): boolean {
  return useSyncExternalStore(subscribeHistory, () => openFor === pageId, () => false);
}
