import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { FileDetails, SpaceResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import type { FileControls } from '../lib/fileUi.js';
import { MoreIcon } from './icons.js';
import { Confirm, MoveForm, PANEL } from './lifecycle.js';
import { Button, ErrorNote } from './ui.js';

type Action = 'move' | 'withdraw' | 'archive';

/**
 * A file's "…" menu: move, withdraw from the index, archive (and restoring an
 * archived file, dismissing "removed at source"), as `controls` allows for the
 * role. `onChanged` runs after each action so the file and the lists are fetched again.
 */
export function FileMenu({
  file,
  spaces,
  controls,
  onChanged,
}: {
  file: FileDetails;
  spaces: SpaceResponse[];
  controls: FileControls;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const restore = useMutation({ mutationFn: () => api.restoreFile(file.id), onSuccess: onChanged });
  const dismiss = useMutation({ mutationFn: () => api.dismissRemoval(file.id), onSuccess: onChanged });

  const items: { key: Action; label: string; show: boolean }[] = [
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

  return (
    <div className="relative flex items-center gap-2">
      {controls.restore && (
        <Button variant="secondary" onClick={() => restore.mutate()} disabled={restore.isPending}>
          Restore file
        </Button>
      )}
      {controls.dismissRemoval && (
        <Button variant="secondary" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
          Dismiss
        </Button>
      )}
      {shown.length > 0 && (
        <div onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <button
            type="button"
            aria-label="File actions"
            title="File actions"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls="file-actions"
            onClick={() => setOpen((v) => !v)}
            className="flex size-8 items-center justify-center rounded-md text-lg text-muted hover:bg-hover"
          >
            <MoreIcon />
          </button>
          {open && (
            <ul
              id="file-actions"
              aria-label="File actions"
              className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-1 shadow-pop"
            >
              {shown.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-hover"
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
      <ErrorNote error={restore.error ?? dismiss.error} />
      {action === 'move' && (
        <div className={PANEL}>
          <MoveForm
            page={file}
            spaces={spaces}
            noun="file"
            run={(body) => api.moveFile(file.id, body)}
            onDone={done}
            onCancel={() => setAction(null)}
          />
        </div>
      )}
      {action === 'withdraw' && (
        <div className={PANEL}>
          <Confirm
            text="Withdrawing removes this file from search and from answers. Its history stays."
            label="Withdraw file"
            run={run(() => api.withdrawFile(file.id))}
            onCancel={() => setAction(null)}
          />
        </div>
      )}
      {action === 'archive' && (
        <div className={PANEL}>
          <Confirm
            text="Archiving removes this file from search and from the tree."
            label="Archive file"
            run={run(() => api.archiveFile(file.id))}
            onCancel={() => setAction(null)}
          />
        </div>
      )}
    </div>
  );
}
