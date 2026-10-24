import { createContext, useContext } from 'react';

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
