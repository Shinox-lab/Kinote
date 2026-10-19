import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { api } from '../../lib/api.js';
import { endSession } from '../../lib/queryClient.js';
import { loadSession } from '../../lib/session.js';
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from '../../lib/theme.js';
import { MonitorIcon, MoonIcon, SunIcon } from '../icons.js';

const THEMES: Array<{ value: ThemeChoice; label: string; icon: typeof SunIcon }> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
];

/** The foot of the sidebar: who is signed in, the light/dark/system choice, and sign-out. */
export function AccountRow() {
  const router = useRouter();
  const user = loadSession()?.user;
  const [theme, setTheme] = useState<ThemeChoice>(() => loadTheme());

  const signOut = useMutation({
    mutationFn: () => api.signOut(),
    // Signed out here even when the server could not be told: the token is dropped either way.
    onSettled: () => {
      endSession();
      router.history.push('/sign-in');
    },
  });

  function choose(next: ThemeChoice) {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line px-1 pt-2">
      <div className="flex items-center gap-2 px-1">
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{user?.name}</span>
        <div role="group" aria-label="Theme" className="flex rounded-md border border-line p-0.5">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={theme === value}
              aria-label={label}
              title={label}
              onClick={() => choose(value)}
              className={`flex size-6 items-center justify-center rounded text-sm ${
                theme === value ? 'bg-active text-fg' : 'text-muted hover:bg-hover'
              }`}
            >
              <Icon />
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-left text-sm text-muted hover:bg-hover disabled:opacity-50"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        Sign out
      </button>
    </div>
  );
}
