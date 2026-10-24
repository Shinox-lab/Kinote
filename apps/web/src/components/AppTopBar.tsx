import type { ReactNode } from 'react';

/**
 * The sticky bar at the top of a screen: where you are, and the document's menu.
 * It pulls up into the layout's 24px top gutter so the bar owns the top edge;
 * screens without the bar keep that breathing room. The surrounding layout owns
 * the space below the bar.
 */
export function AppTopBar({ crumbs, right }: { crumbs: ReactNode; right?: ReactNode }) {
  return (
    <header
      role="banner"
      className="sticky top-0 z-20 -mt-6 flex h-11 items-center gap-3 border-b border-line bg-page"
    >
      <div className="min-w-0 flex-1">{crumbs}</div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </header>
  );
}
