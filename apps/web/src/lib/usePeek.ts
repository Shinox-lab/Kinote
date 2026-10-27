import { useNavigate, useSearch } from '@tanstack/react-router';

/** The page open in the side panel (`?peek=`), and how to open, replace or close it. */
export function usePeek() {
  const { peek } = useSearch({ from: '/w/$tenantSlug' });
  const navigate = useNavigate();
  const set = (next: string | undefined) =>
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, peek: next }) });
  return {
    peekId: peek,
    open: (pageId: string) => set(pageId),
    close: () => set(undefined),
  };
}
