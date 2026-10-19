import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { VersionSummary } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { defaultComparison, versionReasonLabel, versionStatusLabel, versionWho, whenLabel } from '../lib/history.js';
import { useAuthorNames, useComparison, usePageVersions, useRefresh } from '../lib/queries.js';
import { DiffView } from './DiffView.js';
import { Button, ErrorNote, Loading, SelectField } from './ui.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function VersionRow({
  version,
  canRestore,
  onRestore,
  restoreRef,
  children,
}: {
  version: VersionSummary;
  canRestore: boolean;
  onRestore: () => void;
  /** Hands the Restore button to the drawer, which puts focus back on it when the confirm closes. */
  restoreRef: (button: HTMLButtonElement | null) => void;
  /** The restore confirm, shown under the row it belongs to. */
  children?: ReactNode;
}) {
  const { names, selfId } = useAuthorNames();
  const who = versionWho(version, names, selfId);
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold">Version {version.number}</span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-800">{versionStatusLabel(version.status)}</span>
        <span className="text-xs text-slate-600">{versionReasonLabel(version.reason)}</span>
        {canRestore && (
          <Button variant="secondary" className="ml-auto" ref={restoreRef} onClick={onRestore} aria-label={`Restore version ${version.number}`}>
            Restore
          </Button>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
        <span>{who.name}</span>
        {who.isAgent && <span className="rounded bg-slate-800 px-1.5 text-[10px] uppercase tracking-wide text-white">Agent</span>}
        <span aria-hidden="true">·</span>
        <time dateTime={version.createdAt}>{whenLabel(version.createdAt)}</time>
      </p>
      {version.reviewNote && <p className="text-xs text-slate-700">Review note: {version.reviewNote}</p>}
      {children}
    </li>
  );
}

type Pair = { from: number; to: number };

/** Pick any two versions and show the block diff between them. */
function Compare({ pageId, versions }: { pageId: string; versions: VersionSummary[] }) {
  // Until the user picks, the pair follows the list (a restore adds a new latest version); a pick sticks.
  const [picked, setPicked] = useState<Pair | null>(null);
  const [submitted, setSubmitted] = useState<Pair | null>(null);
  const selected = picked ?? defaultComparison(versions);
  const shown = submitted ?? defaultComparison(versions);
  const { data: entries, error, isFetching } = useComparison(pageId, shown);
  if (!selected) return null;

  const options = versions.map((v) => ({ value: String(v.number), label: `Version ${v.number} · ${versionStatusLabel(v.status)}` }));
  const same = selected.from === selected.to;
  // aria-disabled, not disabled: the button keeps focus while it is busy, so Escape and Tab keep working.
  const blocked = same || isFetching;

  return (
    <section aria-label="Compare versions" className="flex flex-col gap-3 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold">Compare versions</h3>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && picked) setSubmitted(picked);
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <SelectField label="From" value={String(selected.from)} options={options} onChange={(v) => setPicked({ ...selected, from: Number(v) })} />
          <SelectField label="To" value={String(selected.to)} options={options} onChange={(v) => setPicked({ ...selected, to: Number(v) })} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" aria-disabled={blocked} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50">
            Compare
          </Button>
          {same && <span className="text-xs text-slate-600">Choose two different versions.</span>}
        </div>
      </form>
      <ErrorNote error={error} />
      {isFetching && !entries ? (
        <Loading what="comparison" />
      ) : (
        entries && shown && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-600">
              Version {shown.from} to version {shown.to}
            </p>
            <DiffView entries={entries} label={`Changes from version ${shown.from} to version ${shown.to}`} />
          </div>
        )
      )}
    </section>
  );
}

/**
 * Asks before replacing the page's content with an older version, then restores it as a new version.
 * Focus moves onto the confirm when it opens (it is announced as an alert dialog).
 */
function RestoreConfirm({ pageId, number, onDone, onCancel }: { pageId: string; number: number; onDone: () => void; onCancel: () => void }) {
  const restore = useMutation({ mutationFn: () => api.restoreVersion(pageId, number), onSuccess: onDone });
  const titleId = useId();
  const bodyId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      tabIndex={-1}
      className="mt-2 flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 outline-none"
    >
      <p id={titleId} className="text-sm font-semibold">
        Restore version {number}?
      </p>
      <p id={bodyId} className="text-sm">
        Restoring puts version {number}&rsquo;s content back on the page as a new version. Older versions are kept.
      </p>
      <ErrorNote error={restore.error} />
      <div className="flex gap-2">
        <Button
          variant="danger"
          aria-disabled={restore.isPending}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => !restore.isPending && restore.mutate()}
        >
          Restore version {number}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * A side drawer with the page's versions, a compare of any two and (for editors)
 * restore. Focus moves into it when it opens and goes back to the button that
 * opened it when it closes; Escape closes it and Tab stays inside.
 */
export function HistoryDrawer({
  pageId,
  canRestore,
  onClose,
  onRestored,
}: {
  pageId: string;
  canRestore: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const refresh = useRefresh();
  const { data: versions, error, isPending } = usePageVersions(pageId, true);
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Keys are handled on the document, not on the dialog: when the focused control goes away or is
  // disabled, focus falls to the body, and Escape and Tab must still close and trap the drawer.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const box = dialog.current;
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && box.contains(active);
      if (!inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // When the confirm closes, focus goes back to the Restore button it came from (or the drawer if that row is gone).
  const restoreButtons = useRef(new Map<number, HTMLButtonElement>());
  const lastRestoring = useRef<number | null>(null);
  useEffect(() => {
    if (restoring !== null) {
      lastRestoring.current = restoring;
    } else if (lastRestoring.current !== null) {
      (restoreButtons.current.get(lastRestoring.current) ?? dialog.current)?.focus();
      lastRestoring.current = null;
    }
  }, [restoring]);

  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-20 bg-slate-900/30" onClick={onClose} />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-30 flex w-full max-w-lg flex-col gap-4 overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold">
            Page history
          </h2>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        {isPending ? (
          <Loading what="history" />
        ) : error ? (
          <ErrorNote error={error} />
        ) : versions.length === 0 ? (
          <p className="text-sm text-slate-600">This page has no saved versions yet.</p>
        ) : (
          <>
            <ul aria-label="Versions" className="divide-y divide-slate-100">
              {versions.map((v) => (
                <VersionRow
                  key={v.id}
                  version={v}
                  canRestore={canRestore}
                  onRestore={() => setRestoring(v.number)}
                  restoreRef={(button) => {
                    if (button) restoreButtons.current.set(v.number, button);
                    else restoreButtons.current.delete(v.number);
                  }}
                >
                  {restoring === v.number && (
                    <RestoreConfirm
                      key={v.number}
                      pageId={pageId}
                      number={v.number}
                      onCancel={() => setRestoring(null)}
                      onDone={() => {
                        setRestoring(null);
                        void refresh('versions', pageId);
                        onRestored();
                      }}
                    />
                  )}
                </VersionRow>
              ))}
            </ul>
            {versions.length >= 2 && <Compare pageId={pageId} versions={versions} />}
          </>
        )}
      </div>
    </>
  );
}
