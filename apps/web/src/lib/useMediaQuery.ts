import { useSyncExternalStore } from 'react';

/** Whether a CSS media query currently matches; follows changes. False where matchMedia is missing. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia !== 'function') return () => undefined;
      const list = matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false
  );
}
