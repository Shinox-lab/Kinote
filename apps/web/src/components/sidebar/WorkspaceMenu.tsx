import { useEffect, useId, useRef, useState } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { queryClient } from '../../lib/queryClient.js';
import { ME_KEY, useWorkspace } from '../../lib/queries.js';
import { Button, ErrorNote } from '../ui.js';
import { ChevronsUpDownIcon } from '../icons.js';
import { ROW } from './NavRow.js';

/** The workspace's name at the top of the sidebar; opens a list to switch to another workspace. */
export function WorkspaceMenu() {
  const { tenant } = useWorkspace();
  const { data: me } = useQuery({ queryKey: ME_KEY, queryFn: () => api.me(), staleTime: 30_000 });
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const others = (me?.memberships ?? []).filter((m) => m.tenant.id !== tenant.id);

  const leave = useMutation({
    mutationFn: () => api.leaveWorkspace(),
    onSuccess: async () => {
      // Everything cached belonged to this workspace's access; `/` opens another workspace or the create screen.
      queryClient.clear();
      await router.navigate({ to: '/' });
    },
  });

  useEffect(() => {
    if (!open) {
      setLeaving(false);
      leave.reset();
      return;
    }
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
        className={`${ROW} font-medium`}
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
          <div role="separator" className="my-1 h-px bg-line" />
          <Link to="/new-workspace" className={`${ROW} text-muted`} onClick={() => setOpen(false)}>
            New workspace
          </Link>
          {leaving ? (
            <div className="flex flex-col gap-1 p-1">
              <p className="text-xs text-muted">Leave {tenant.name}? You lose access to its spaces and pages.</p>
              <ErrorNote error={leave.error} />
              <Button variant="danger" onClick={() => leave.mutate()} disabled={leave.isPending}>
                Leave workspace
              </Button>
              <Button variant="secondary" onClick={() => setLeaving(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <button type="button" className={`${ROW} text-muted`} onClick={() => setLeaving(true)}>
              Leave workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
