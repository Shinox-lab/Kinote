/** The person's theme choice; `system` follows the operating system. */
export type ThemeChoice = 'light' | 'dark' | 'system';

/** localStorage key; the pre-paint script in index.html reads the same one. */
export const THEME_KEY = 'lw-theme';

const CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The stored choice; `system` when nothing usable is stored or storage is unavailable. */
export function loadTheme(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): ThemeChoice {
  try {
    const stored = storage?.getItem(THEME_KEY);
    return CHOICES.find((c) => c === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

/** Remembers the choice; never throws (a private window or blocked storage just forgets it). */
export function saveTheme(choice: ThemeChoice, storage: Pick<Storage, 'setItem'> | undefined = browserStorage()): void {
  try {
    storage?.setItem(THEME_KEY, choice);
  } catch {
    // The choice still applies to this visit.
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): 'light' | 'dark' {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether the operating system asks for dark. */
export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
}

/** Puts the resolved theme on the root element, where the CSS tokens switch on `data-theme`. */
export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
  prefersDark: boolean = systemPrefersDark()
): void {
  root.dataset.theme = resolveTheme(choice, prefersDark);
}

/** Calls `onChange` when the operating system's setting changes; returns the unsubscribe. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const query = matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function channel(hex: string, start: number): number {
  const c = parseInt(hex.slice(start, start + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
