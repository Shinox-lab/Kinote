import { useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { api } from '../../lib/api.js';
import { endSession } from '../../lib/queryClient.js';
import { loadSession } from '../../lib/session.js';
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from '../../lib/theme.js';
import { MonitorIcon, MoonIcon, MoreIcon, SunIcon } from '../icons.js';

const THEMES: Array<{ value: ThemeChoice; label: string; icon: typeof SunIcon }> = [
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
];

/** The person's initials for the account tile: "Olive Owner" reads OO. */
function initials(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return `${words[0]![0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
}

/**
 * The foot of the sidebar: who is signed in. The row opens the account menu:
 * appearance (light/dark/system) and sign-out live here, not in the sidebar.
 */
export function AccountRow() {
  const router = useRouter();
  const user = loadSession()?.user;
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    // Signed out here even when the server could not be told: the token is dropped either way.
    onSettled: () => {
      endSession();
      router.history.push('/sign-in');
    },
  });

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  function choose(next: ThemeChoice) {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div ref={rootRef} className="relative border-t border-line px-1 pt-2">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
      >
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[11px] font-semibold text-accent-text"
        >
          {initials(user?.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{user?.name}</span>
        <span aria-hidden="true" className="shrink-0 text-muted">
          <MoreIcon />
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute inset-x-0 bottom-full z-30 mb-1 rounded-lg border border-line bg-surface p-1 shadow-pop"
        >
          <p className="px-2 py-1 text-xs text-muted">Appearance</p>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === value}
              onClick={() => choose(value)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                theme === value ? 'bg-active text-fg' : 'text-muted hover:bg-hover'
              }`}
            >
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <Icon />
              </span>
              <span className="flex-1">{label}</span>
            </button>
          ))}
          <div role="separator" className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-hover disabled:opacity-50"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
