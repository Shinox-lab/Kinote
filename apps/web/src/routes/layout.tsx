import { useEffect, useRef, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { MenuIcon, SidebarIcon } from '../components/icons.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { SidebarColumnContext } from '../components/sidebar/SidebarContext.js';
import {
  SIDEBAR_BREAKPOINT_PX,
  isCollapseShortcut,
  loadCollapsed,
  saveCollapsed,
} from '../lib/sidebar.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';

/**
 * The shell of `/w/$tenantSlug`: one sidebar on the left (a column on a wide
 * screen, a slide-over on a narrow one) and the screen beside it.
 */
export function WorkspaceLayout() {
  const isDesktop = useMediaQuery(`(min-width: ${SIDEBAR_BREAKPOINT_PX}px)`);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed());
  const [slideOver, setSlideOver] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // A slide-over closes when the person goes somewhere, and when the screen widens into a column.
  useEffect(() => setSlideOver(false), [pathname, isDesktop]);
  useFocusTrap(panelRef, slideOver && !isDesktop, () => setSlideOver(false));

  function toggleCollapsed(next: boolean) {
    setCollapsed(next);
    saveCollapsed(next);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!isCollapseShortcut(e)) return;
      e.preventDefault();
      if (isDesktop) toggleCollapsed(!collapsed);
      else setSlideOver((v) => !v);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isDesktop, collapsed]);

  const column = isDesktop && !collapsed;

  return (
    <div className="flex min-h-screen">
      {column && (
        <aside aria-label="Sidebar" className="sticky top-0 h-screen w-64 shrink-0 border-r border-line bg-sidebar">
          <Sidebar onCollapse={() => toggleCollapsed(true)} />
        </aside>
      )}

      {!isDesktop && slideOver && (
        <div className="fixed inset-0 z-40 flex">
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Sidebar"
            tabIndex={-1}
            className="h-full w-72 max-w-[85vw] border-r border-line bg-sidebar shadow-pop"
          >
            <Sidebar />
          </div>
          <button
            type="button"
            aria-label="Close sidebar"
            tabIndex={-1}
            className="flex-1 bg-overlay"
            onClick={() => setSlideOver(false)}
          />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {!column && (
          <div className="px-3 pt-3">
            <button
              type="button"
              aria-label="Open sidebar"
              title="Open sidebar (Ctrl+\)"
              aria-expanded={isDesktop ? false : slideOver}
              onClick={() => (isDesktop ? toggleCollapsed(false) : setSlideOver(true))}
              className="flex size-8 items-center justify-center rounded-md text-lg text-muted hover:bg-hover"
            >
              {isDesktop ? <SidebarIcon /> : <MenuIcon />}
            </button>
          </div>
        )}
        <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">
          <SidebarColumnContext.Provider value={column}>
            <Outlet />
          </SidebarColumnContext.Provider>
        </main>
      </div>
    </div>
  );
}
