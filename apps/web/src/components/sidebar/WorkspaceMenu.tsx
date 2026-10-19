import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { ME_KEY, useWorkspace } from '../../lib/queries.js';
import { ChevronsUpDownIcon } from '../icons.js';
import { ROW } from './NavRow.js';

/** The workspace's name at the top of the sidebar; opens a list to switch to another workspace. */
export function WorkspaceMenu() {
  const { tenant } = useWorkspace();
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: () => api.me(), staleTime: 30_000 });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const others = (me?.memberships ?? []).filter((m) => m.tenant.id !== tenant.id);

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

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={`${ROW} font-semibold`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded bg-fg text-xs font-bold text-page"
        >
          {tenant.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate">{tenant.name}</span>
        <span className="ml-auto text-muted">
          <ChevronsUpDownIcon />
        </span>
      </button>
      {open && (
        <div
          id={listId}
          className="absolute inset-x-0 top-full z-30 mt-1 rounded-lg border border-line bg-surface p-1 shadow-pop"
        >
          <p className="px-2 py-1 text-xs text-muted">Workspaces</p>
          <Link
            to="/w/$tenantSlug"
            params={{ tenantSlug: tenant.slug }}
            className={`${ROW} bg-active font-medium`}
            aria-current="true"
            onClick={() => setOpen(false)}
          >
            <span className="truncate">{tenant.name}</span>
          </Link>
          {others.map((m) => (
            <Link
              key={m.tenant.id}
              to="/w/$tenantSlug"
              params={{ tenantSlug: m.tenant.slug }}
              className={ROW}
              onClick={() => setOpen(false)}
            >
              <span className="truncate">{m.tenant.name}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
