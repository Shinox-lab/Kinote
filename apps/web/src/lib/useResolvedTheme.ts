import { useSyncExternalStore } from 'react';

function subscribe(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/** The theme in effect (`data-theme` on <html>), for components that must hand it to a library. */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    () => 'light'
  );
}
