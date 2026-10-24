import { createContext, useContext } from 'react';

/**
 * Whether the sidebar is on screen as a column beside the page. When it is not
 * (a phone, or a collapsed sidebar) the page shows its own actions instead.
 */
export const SidebarColumnContext = createContext(true);

export function useSidebarColumn(): boolean {
  return useContext(SidebarColumnContext);
}

/** The shell's sidebar state and the one way to bring it back. */
export interface ShellChrome {
  column: boolean;
  isDesktop: boolean;
  slideOver: boolean;
  openSidebar: () => void;
}

export const ShellChromeContext = createContext<ShellChrome>({
  column: true,
  isDesktop: true,
  slideOver: false,
  openSidebar: () => {},
});

export function useShellChrome(): ShellChrome {
  return useContext(ShellChromeContext);
}

/**
 * A screen with a sticky top bar registers it, so the shell does not also float
 * a second open-sidebar control above the main column.
 */
export const TopBarPresenceContext = createContext<(present: boolean) => void>(() => {});

export function useTopBarPresence(): (present: boolean) => void {
  return useContext(TopBarPresenceContext);
}
