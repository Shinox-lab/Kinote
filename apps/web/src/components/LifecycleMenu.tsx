import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PageDetails, SpaceResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import type { PageControls } from '../lib/wiki.js';
import { MoreIcon } from './icons.js';
import { Confirm, MoveForm, PANEL } from './lifecycle.js';
import { TitleInput } from './sidebar/TitleInput.js';
import { Button, ErrorNote } from './ui.js';

type Action = 'rename' | 'move' | 'withdraw' | 'archive';

/**
 * The page's lifecycle actions: move, withdraw, archive (and restoring an archived
 * page), as `controls` allows for the actor's role. `onChanged` runs after each one
 * succeeds, so the page and its badge are fetched again.
 */
export function LifecycleMenu({
  page,
  spaces,
  controls,
  onChanged,
}: {
  page: PageDetails;
  spaces: SpaceResponse[];
  controls: PageControls;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);

  const restore = useMutation({ mutationFn: () => api.restorePage(page.id), onSuccess: onChanged });
  const rename = useMutation({
    mutationFn: (title: string) => api.renamePage(page.id, title),
    onSuccess: () => {
      setAction(null);
      setOpen(false);
      onChanged();
    },
  });
  const items: { key: Action; label: string; show: boolean }[] = [
    { key: 'rename', label: 'Rename…', show: controls.move },
    { key: 'move', label: 'Move…', show: controls.move },
    { key: 'withdraw', label: 'Withdraw from index…', show: controls.withdraw },
    { key: 'archive', label: 'Archive…', show: controls.archive },
  ];
  const shown = items.filter((i) => i.show);

  const done = () => {
    setAction(null);
    setOpen(false);
    onChanged();
  };
  const run = (call: () => Promise<unknown>) => async () => {
    await call();
    done();
  };

  if (shown.length === 0 && !controls.restorePage) return null;

  return (
    <div className="relative">
      {controls.restorePage && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => restore.mutate()} disabled={restore.isPending}>
            Restore page
          </Button>
          <ErrorNote error={restore.error} />
        </div>
      )}
      {shown.length > 0 && (
        <div onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <button
            type="button"
            aria-label="Page actions"
            title="Page actions"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls="lifecycle-actions"
            onClick={() => setOpen((v) => !v)}
            className="flex size-8 items-center justify-center rounded-md text-lg text-muted hover:bg-hover max-md:size-11"
          >
            <MoreIcon />
          </button>
          {open && (
            <ul
              id="lifecycle-actions"
              aria-label="Page actions"
              className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-1 shadow-pop"
            >
              {shown.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-hover max-md:min-h-11"
                    onClick={() => {
                      setAction(item.key);
                      setOpen(false);
                    }}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {action === 'rename' && (
        <div className={PANEL}>
          <p className="mb-2 text-sm font-medium">Rename page</p>
          <TitleInput title={page.title} onCancel={() => setAction(null)} onSave={(title) => rename.mutate(title)} />
          <ErrorNote error={rename.error} />
        </div>
      )}
      {action === 'move' && (
        <div className={PANEL}>
          <MoveForm
            page={page}
            spaces={spaces}
            noun="page"
            run={(body) => api.movePage(page.id, body)}
            onDone={done}
            onCancel={() => setAction(null)}
          />
        </div>
      )}
      {action === 'withdraw' && (
        <div className={PANEL}>
        <Confirm
          text="Withdrawing removes this page from search and from answers. Its history stays."
          label="Withdraw page"
          run={run(() => api.withdrawPage(page.id))}
          onCancel={() => setAction(null)}
        />
        </div>
      )}
      {action === 'archive' && (
        <div className={PANEL}>
        <Confirm
          text="Archiving removes this page from search and from the tree. A page with live child pages cannot be archived."
          label="Archive page"
          run={run(() => api.archivePage(page.id))}
          onCancel={() => setAction(null)}
        />
        </div>
      )}
    </div>
  );
}
