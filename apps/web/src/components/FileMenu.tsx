import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { FileDetails, SpaceResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import type { FileControls } from '../lib/fileUi.js';
import { MoreIcon } from './icons.js';
import { Confirm, MoveForm, PANEL } from './lifecycle.js';
import { TitleInput } from './sidebar/TitleInput.js';
import { ErrorNote } from './ui.js';

type Action = 'rename' | 'move' | 'withdraw' | 'archive';

/**
 * A file's "…" menu: replace, rename, retry, move, withdraw, archive, and the
 * state actions (restore, dismiss a source removal), as `controls` allows.
 * Replacing opens the hidden picker in the page; `onChanged` refetches.
 */
export function FileMenu({
  file,
  spaces,
  controls,
  onReplace,
  onDownload,
  onChanged,
}: {
  file: FileDetails;
  spaces: SpaceResponse[];
  controls: FileControls;
  onReplace: () => void;
  /** The phone puts Download in this menu; the desktop keeps it in the top bar. */
  onDownload?: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const phone = useMediaQuery('(max-width: 767px)');
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restore = useMutation({ mutationFn: () => api.restoreFile(file.id), onSuccess: onChanged });
  const dismiss = useMutation({ mutationFn: () => api.dismissRemoval(file.id), onSuccess: onChanged });
  const retry = useMutation({
    mutationFn: () => api.retryVersion(file.latestVersion!.id),
    onSuccess: onChanged,
  });
  const rename = useMutation({
    mutationFn: (title: string) => api.renameFile(file.id, title),
    onSuccess: () => {
      setAction(null);
      setOpen(false);
      onChanged();
    },
  });
  const done = () => {
    setAction(null);
    setOpen(false);
    onChanged();
  };
  const run = (call: () => Promise<unknown>) => async () => {
    await call();
    done();
  };

  const items: { key: string; label: string; show: boolean; run: () => void; phoneOnly?: boolean }[] = [
    {
      key: 'download',
      label: 'Download',
      show: controls.download && onDownload !== undefined,
      run: () => onDownload?.(),
      phoneOnly: true,
    },
    { key: 'replace', label: 'Replace file…', show: controls.replace, run: onReplace },
    { key: 'rename', label: 'Rename…', show: controls.replace, run: () => setAction('rename') },
    { key: 'retry', label: 'Retry indexing', show: controls.retry && file.latestVersion !== null, run: () => retry.mutate() },
    { key: 'move', label: 'Move…', show: controls.move, run: () => setAction('move') },
    { key: 'withdraw', label: 'Withdraw from index…', show: controls.withdraw, run: () => setAction('withdraw') },
    { key: 'archive', label: 'Archive…', show: controls.archive, run: () => setAction('archive') },
    { key: 'restore', label: 'Restore file', show: controls.restore, run: () => restore.mutate() },
    { key: 'dismiss', label: 'Dismiss removed file', show: controls.dismissRemoval, run: () => dismiss.mutate() },
  ];
  const shown = items.filter((item) => item.show && (!item.phoneOnly || phone));

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = (run: () => void) => {
    setOpen(false);
    run();
  };

  if (shown.length === 0) return null;

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="File actions"
        title="File actions"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="file-actions"
        onClick={() => setOpen((value) => !value)}
        className="flex size-8 items-center justify-center rounded-md text-lg text-muted hover:bg-hover max-md:size-11"
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
            <li key={item.key} className={item.phoneOnly ? 'md:hidden' : undefined}>
              <button
                type="button"
                className="w-full rounded px-3 py-2 text-left text-sm text-fg hover:bg-hover disabled:opacity-50 max-md:min-h-11"
                onClick={() => select(item.run)}
                disabled={retry.isPending || restore.isPending || dismiss.isPending}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={retry.error ?? restore.error ?? dismiss.error ?? rename.error} />
      {action === 'rename' && (
        <div className={PANEL}>
          <p className="mb-2 text-sm font-medium">Rename file</p>
          <TitleInput title={file.title} onCancel={() => setAction(null)} onSave={(title) => rename.mutate(title)} />
        </div>
      )}
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
