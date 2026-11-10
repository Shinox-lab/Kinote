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
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampWidth,
  isCollapseShortcut,
  loadCollapsed,
  loadWidth,
  saveCollapsed,
  saveWidth,
} from '../lib/sidebar.js';
import { UploadsProvider } from '../lib/useUploads.js';
import { useWorkspace } from '../lib/queries.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { usePeek } from '../lib/usePeek.js';
import { UsageBanner } from '../components/UsageBanner.js';

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
  const [width, setWidth] = useState(() => loadWidth());
  const [resizing, setResizing] = useState(false);
  const [mobileEverOpened, setMobileEverOpened] = useState(false);
  const [slideOver, setSlideOver] = useState(false);
  const [topBar, setTopBar] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
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

  // The slide-over keeps its pane mounted once opened so closing can animate; it does not load the tree before that.
  useEffect(() => {
    if (slideOver) setMobileEverOpened(true);
  }, [slideOver]);

  function toggleCollapsed(next: boolean) {
    setCollapsed(next);
    saveCollapsed(next);
  }

  function beginResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width, width };
    setResizing(true);
  }

  function moveResize(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current.width = clampWidth(drag.current.startWidth + e.clientX - drag.current.startX);
    setWidth(drag.current.width);
  }

  function endResize(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    saveWidth(drag.current.width);
    drag.current = null;
    setResizing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function resizeByKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 40 : 16;
    const next =
      e.key === 'ArrowLeft'
        ? width - step
        : e.key === 'ArrowRight'
          ? width + step
          : e.key === 'Home'
            ? SIDEBAR_MIN_WIDTH
            : e.key === 'End'
              ? SIDEBAR_MAX_WIDTH
              : null;
    if (next === null) return;
    e.preventDefault();
    const clamped = clampWidth(next);
    setWidth(clamped);
    saveWidth(clamped);
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
          {isDesktop && (
            <aside
              aria-label="Sidebar"
              inert={collapsed}
              data-collapsed={collapsed}
              data-resizing={resizing}
              style={{ width: collapsed ? 0 : width }}
              className="sidebar-column sticky top-0 h-screen shrink-0 overflow-hidden border-r border-line bg-sidebar"
            >
              <div className="relative h-full" style={{ width }}>
                <Sidebar onCollapse={() => toggleCollapsed(true)} />
                {!collapsed && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize sidebar"
                    aria-valuemin={SIDEBAR_MIN_WIDTH}
                    aria-valuemax={SIDEBAR_MAX_WIDTH}
                    aria-valuenow={width}
                    tabIndex={0}
                    onPointerDown={beginResize}
                    onPointerMove={moveResize}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    onKeyDown={resizeByKey}
                    className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-accent/30 focus-visible:bg-accent/30"
                  />
                )}
              </div>
            </aside>
          )}

          {!isDesktop && (
            <div
              aria-hidden={!slideOver || undefined}
              inert={!slideOver}
              data-open={slideOver}
              className={`sidebar-slide-over fixed inset-0 z-40 flex ${slideOver ? '' : 'pointer-events-none'}`}
            >
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="Sidebar"
                tabIndex={-1}
                className={`h-full w-[330px] max-w-[85vw] border-r border-line bg-sidebar shadow-pop transition-transform duration-200 ease-out ${
                  slideOver ? 'translate-x-0' : '-translate-x-full'
                }`}
              >
                {mobileEverOpened && <Sidebar />}
              </div>
              <button
                type="button"
                aria-label="Close sidebar"
                tabIndex={-1}
                className={`flex-1 bg-overlay transition-opacity duration-200 ${slideOver ? 'opacity-100' : 'opacity-0'}`}
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
              <UsageBanner />
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
