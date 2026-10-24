import { MenuIcon, SidebarIcon } from '../icons.js';
import { useShellChrome } from './SidebarContext.js';

/** Brings the sidebar back: inside the top bar on a document, above the screen otherwise. */
export function OpenSidebarButton() {
  const { isDesktop, slideOver, openSidebar } = useShellChrome();
  return (
    <button
      type="button"
      aria-label="Open sidebar"
      title="Open sidebar (Ctrl+\)"
      aria-expanded={isDesktop ? false : slideOver}
      onClick={openSidebar}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-lg text-muted hover:bg-hover"
    >
      {isDesktop ? <SidebarIcon /> : <MenuIcon />}
    </button>
  );
}
