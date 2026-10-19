import { createContext, useContext } from 'react';

/**
 * Whether the sidebar is on screen as a column beside the page. When it is not
 * (a phone, or a collapsed sidebar) the page shows its own actions instead.
 */
export const SidebarColumnContext = createContext(true);

export function useSidebarColumn(): boolean {
  return useContext(SidebarColumnContext);
}
