import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { PageDetails } from '@living-wiki/contracts';
import { pageStatus, relativeTime, type PageStatusTone } from '../lib/pageStatus.js';
import type { HistoryTab } from '../lib/pageUi.js';
import type { PageControls } from '../lib/wiki.js';
import { PageActions } from './PageActions.js';

const TONE: Record<PageStatusTone, string> = {
  ok: 'bg-success-bg text-success',
  warn: 'bg-warn-bg text-warn-text',
  review: 'bg-review-bg text-review-text',
  bad: 'bg-danger-bg text-danger',
  muted: 'bg-hover text-muted',
  pending: 'bg-dot-review/15 text-fg',
};

const DOT: Record<PageStatusTone, string> = {
  ok: 'bg-success',
  warn: 'bg-warn-dot',
  review: 'bg-review-dot',
  bad: 'bg-dot-failed',
  muted: 'bg-muted',
  pending: 'bg-dot-review',
};

/**
 * The page's state, its actions and its way into the history: one chip, one
 * popover. Changed pages and failures also carry their one next step beside
 * the chip; a pending review carries Review (a reviewer) or a quiet wait.
 */
export function PageStatus({
  page,
  changedCount,
  controls,
  canReview,
  tenantSlug,
  onChanged,
  onHistory,
}: {
  page: PageDetails;
  changedCount: number;
  controls: PageControls;
  canReview: boolean;
  tenantSlug: string;
  onChanged: () => void;
  onHistory: (tab: HistoryTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const info = pageStatus(page, changedCount);
  const pendingReview = info.state === 'review';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function openTab(tab: HistoryTab) {
    setOpen(false);
    trigger.current?.focus();
    onHistory(tab);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        ref={wrapper}
        className="relative flex items-center gap-2"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !open) return;
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }}
      >
        <button
          ref={trigger}
          type="button"
          aria-label="Page status and actions"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => setOpen((value) => !value)}
          className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.8px] font-medium ${TONE[info.tone]}`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[info.tone]}`} />
          <span role="status" aria-live="polite" aria-label={`Page status: ${info.label}`}>
            {info.label}
          </span>
          <span aria-hidden="true" className="text-[10px] opacity-60">
            ▾
          </span>
        </button>
        {info.indexedAt !== null && (
          <span className="text-[11.8px] text-muted">{relativeTime(info.indexedAt)}</span>
        )}

        {open && (
          <div
            id={popoverId}
            role="dialog"
            aria-label="Page status and actions"
            className="absolute left-0 top-full z-30 mt-1 w-[280px] max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-3 shadow-pop"
          >
            <div className="mb-2 flex items-center gap-2 text-xs">
              <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[info.tone]}`} />
              <span className={`font-medium ${info.tone === 'ok' ? 'text-success' : info.tone === 'bad' ? 'text-danger' : 'text-fg'}`}>
                {info.label}
              </span>
              {info.indexedAt !== null && (
                <span className="ml-auto text-muted">{relativeTime(info.indexedAt)}</span>
              )}
            </div>
            <PageActions page={page} controls={controls} onChanged={onChanged} stacked />
            <div className="mt-2 flex gap-1 border-t border-line pt-2">
              <button
                type="button"
                onClick={() => openTab('versions')}
                className="flex-1 rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-hover"
              >
                History
              </button>
              <button
                type="button"
                onClick={() => openTab('changes')}
                className="flex-1 rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-hover"
              >
                Changes ({changedCount})
              </button>
            </div>
          </div>
        )}
      </div>

      {(info.state === 'changed' || info.state === 'failed') && (
        <PageActions page={page} controls={controls} onChanged={onChanged} compact />
      )}
      {pendingReview && canReview && (
        <Link
          to="/w/$tenantSlug/reviews"
          params={{ tenantSlug }}
          className="text-xs font-medium text-accent-text hover:underline"
        >
          Review
        </Link>
      )}
      {pendingReview && !canReview && controls.primary !== null && (
        <span className="text-xs text-muted">Waiting for a reviewer</span>
      )}
    </div>
  );
}
