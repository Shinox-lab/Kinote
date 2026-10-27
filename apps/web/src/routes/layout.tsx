import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { UploadPanel } from '../components/sidebar/UploadPanel.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { OpenSidebarButton } from '../components/sidebar/OpenSidebarButton.js';
import {
  ShellChromeContext,
  TopBarPresenceContext,
} from '../components/sidebar/SidebarContext.js';
import {
  SIDEBAR_BREAKPOINT_PX,
  isCollapseShortcut,
  loadCollapsed,
  saveCollapsed,
} from '../lib/sidebar.js';
import { UploadsProvider } from '../lib/useUploads.js';
import { useWorkspace } from '../lib/queries.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { usePeek } from '../lib/usePeek.js';

// The side panel carries the editor: load it only when a page is peeked.
const PagePeek = lazy(() => import('../components/PagePeek.js').then((m) => ({ default: m.PagePeek })));

/**
 * The shell of `/w/$tenantSlug`: one sidebar on the left (a column on a wide
 * screen, a slide-over on a narrow one) and the screen beside it.
 */
export function WorkspaceLayout() {
  const { tenant } = useWorkspace();
  return (
    // Keyed by workspace: a switch drops the queue instead of sending its files to the other one.
    <UploadsProvider key={tenant.id}>
      <Shell />
    </UploadsProvider>
  );
}

function Shell() {
  const { peekId } = usePeek();
  const isDesktop = useMediaQuery(`(min-width: ${SIDEBAR_BREAKPOINT_PX}px)`);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed());
  const [slideOver, setSlideOver] = useState(false);
  const [topBar, setTopBar] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // A slide-over closes when the person goes somewhere, and when the screen widens into a column.
  useEffect(() => setSlideOver(false), [pathname, isDesktop]);
  useFocusTrap(panelRef, slideOver && !isDesktop, () => setSlideOver(false));
  useEffect(() => {
    if (isDesktop || !slideOver) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isDesktop, slideOver]);

  function toggleCollapsed(next: boolean) {
    setCollapsed(next);
    saveCollapsed(next);
  }

  function openSidebar() {
    if (isDesktop) toggleCollapsed(false);
    else setSlideOver(true);
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
  const chrome = { column, isDesktop, slideOver, openSidebar };

  return (
    <ShellChromeContext.Provider value={chrome}>
      <TopBarPresenceContext.Provider value={setTopBar}>
        <div className="flex min-h-screen">
          {column && (
            <aside aria-label="Sidebar" className="sticky top-0 h-screen w-[252px] shrink-0 border-r border-line bg-sidebar">
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
                className="h-full w-[330px] max-w-[85vw] border-r border-line bg-sidebar shadow-pop"
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
            {!column && !topBar && (
              <div className="px-3 pt-3">
                <OpenSidebarButton />
              </div>
            )}
            <main className="mx-auto w-full max-w-[1188px] px-5 py-6 md:px-7">
              <Outlet />
            </main>
          </div>

          {peekId && (
            <Suspense fallback={null}>
              <PagePeek pageId={peekId} />
            </Suspense>
          )}

          {/* The sidebar holds the upload panel; with it hidden, the panel floats so progress and refusals stay visible. */}
          {!column && !slideOver && <UploadPanel floating />}
        </div>
      </TopBarPresenceContext.Provider>
    </ShellChromeContext.Provider>
  );
}
