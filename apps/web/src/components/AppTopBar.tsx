import type { ReactNode } from 'react';

/**
 * The sticky bar at the top of a screen: where you are, and the document's menu.
 * The surrounding layout owns the space below it, so the bar itself has no margin.
 */
export function AppTopBar({ crumbs, right }: { crumbs: ReactNode; right?: ReactNode }) {
  return (
    <header
      role="banner"
      className="sticky top-0 z-20 flex h-11 items-center gap-3 border-b border-line bg-page"
    >
      <div className="min-w-0 flex-1">{crumbs}</div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </header>
  );
}
