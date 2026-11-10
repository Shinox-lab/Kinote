// Remembered sidebar state and its keyboard shortcut. Every storage access is
// wrapped: a blocked or full storage just forgets, it never breaks the page.

export const COLLAPSED_KEY = 'lw-sidebar-collapsed';
export const WIDTH_KEY = 'lw-sidebar-width';
/** Below this width the sidebar is a slide-over instead of a column. */
export const SIDEBAR_BREAKPOINT_PX = 1024;
/** The column's width: remembered per person, bounded so it never swallows the page. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 252;

type ReadStorage = Pick<Storage, 'getItem'> | undefined;
type WriteStorage = Pick<Storage, 'setItem'> | undefined;

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadCollapsed(storage: ReadStorage = browserStorage()): boolean {
  try {
    return storage?.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveCollapsed(collapsed: boolean, storage: WriteStorage = browserStorage()): void {
  try {
    storage?.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Forgotten at the next visit; nothing else to do.
  }
}

export function clampWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function loadWidth(storage: ReadStorage = browserStorage()): number {
  try {
    const width = Number(storage?.getItem(WIDTH_KEY));
    return Number.isFinite(width) && width > 0 ? clampWidth(width) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveWidth(width: number, storage: WriteStorage = browserStorage()): void {
  try {
    storage?.setItem(WIDTH_KEY, String(clampWidth(width)));
  } catch {
    // Forgotten at the next visit; nothing else to do.
  }
}

/** Per tenant: another workspace never inherits this one's open nodes. */
export function expandedKey(tenantId: string): string {
  return `lw-sidebar-expanded-${tenantId}`;
}

/** The ids of the sidebar nodes (spaces and pages) the person opened; empty when nothing usable is stored. */
export function loadExpanded(tenantId: string, storage: ReadStorage = browserStorage()): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(expandedKey(tenantId)) ?? 'null');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function saveExpanded(tenantId: string, ids: ReadonlySet<string>, storage: WriteStorage = browserStorage()): void {
  try {
    storage?.setItem(expandedKey(tenantId), JSON.stringify([...ids]));
  } catch {
    // Forgotten at the next visit; nothing else to do.
  }
}

/** Ctrl+\ or Cmd+\ toggles the sidebar. */
export function isCollapseShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.key === '\\' && (e.ctrlKey || e.metaKey);
}
