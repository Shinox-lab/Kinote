import { useEffect, useId, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { FileVersion, ReviewItem } from '@living-wiki/contracts';
import { api, errorMessage } from '../lib/api.js';
import { diffSummary } from '../lib/diff.js';
import { relativeTime } from '../lib/updates.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { useRefresh, useReviews, useSpaces, useVersionDiff, useWorkspace } from '../lib/queries.js';
import { REJECT_NOTE_MAX, approveBlockedReason, fileMeta, rejectNoteState } from '../lib/review.js';
import { AppTopBar } from '../components/AppTopBar.js';
import { DiffView } from '../components/DiffView.js';
import { DocumentLink } from '../components/DocumentLink.js';
import { FileReviewPreview } from '../components/FileReviewPreview.js';
import { FileTypeTile } from '../components/FileTypeTile.js';
import { PageIcon } from '../components/icons.js';
import { isKnownIcon } from '../lib/emoji.js';
import { ReviewDocument } from '../components/ReviewDocument.js';
import { Button, ErrorNote, Loading } from '../components/ui.js';

const ALL_SPACES = '';
type View = 'full' | 'changes';
interface Notice {
  tone: 'ok' | 'bad';
  text: string;
}

function ago(iso: string, now: Date): string {
  const value = relativeTime(iso, now);
  return /^\d/.test(value) ? `${value} ago` : value;
}

/** A note of 1 to 300 characters, counted as the API counts it; Reject stays off until it is valid. */
function RejectForm({
  onSubmit,
  onCancel,
  pending,
}: {
  onSubmit: (note: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [note, setNote] = useState('');
  const id = useId();
  const { length, valid } = rejectNoteState(note);
  const tooLong = length > REJECT_NOTE_MAX;
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-line bg-sidebar p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(note.trim());
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Why is this change rejected?
      </label>
      <textarea
        id={id}
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        aria-describedby={`${id}-count`}
        aria-invalid={tooLong}
        className="w-full rounded-md border border-line bg-page px-3 py-2 text-sm text-fg"
      />
      <p id={`${id}-count`} className={`text-xs ${tooLong ? 'text-danger' : 'text-muted'}`}>
        {length} / {REJECT_NOTE_MAX} characters
        {length === 0 ? ' (a note is required)' : tooLong ? ' (too long)' : ''}
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={!valid || pending}>
          Reject change
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The selected review: header, typed full document or changes, and the sticky decision bar. */
function ReviewDetail({ item, now, onResult }: { item: ReviewItem; now: Date; onResult: (notice: Notice) => void }) {
  const { tenant } = useWorkspace();
  const refresh = useRefresh();
  const [view, setView] = useState<View>('full');
  const [rejecting, setRejecting] = useState(false);
  const blocked = approveBlockedReason(item);
  const blockedId = useId();
  const isPage = item.document.kind === 'page';
  const diff = useVersionDiff(item.version.id, isPage);
  const { version } = item;
  const reviewFile: FileVersion | null = item.file
    ? {
        ...version,
        fileName: item.file.fileName,
        mimeType: item.file.mimeType,
        sizeBytes: item.file.sizeBytes,
        hasText: true,
      }
    : null;

  const settle = () => {
    void refresh('reviews');
    void refresh('page');
    void refresh('versions');
    void refresh('versionDiff');
    void refresh('tree');
    void refresh('archived');
  };
  const approve = useMutation({
    mutationFn: () => api.approveVersion(version.id),
    onSuccess: () => onResult({ tone: 'ok', text: `Approved version ${version.number} of ${item.document.title}.` }),
    onError: (error) => onResult({ tone: 'bad', text: `Could not approve ${item.document.title}: ${errorMessage(error)}` }),
    onSettled: settle,
  });
  const reject = useMutation({
    mutationFn: (note: string) => api.rejectVersion(version.id, { review_note: note }),
    onSuccess: () => {
      setRejecting(false);
      onResult({ tone: 'ok', text: `Rejected version ${version.number} of ${item.document.title}.` });
    },
    onError: (error) => onResult({ tone: 'bad', text: `Could not reject ${item.document.title}: ${errorMessage(error)}` }),
    onSettled: settle,
  });
  const busy = approve.isPending || reject.isPending;
  const counts = isPage && diff.data ? diffSummary(diff.data) : null;

  return (
    <section aria-label="Review detail" className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <DocumentLink
            tenantSlug={tenant.slug}
            kind={item.document.kind}
            id={item.document.id}
            className="text-lg font-semibold text-fg hover:underline"
          >
            {item.document.title}
          </DocumentLink>
          <span className="text-xs text-muted">{item.document.spaceName}</span>
        </div>
        <p className="text-xs text-muted">
          Version {version.number} · proposed by {version.createdByName} ·{' '}
          <time dateTime={version.createdAt}>{ago(version.createdAt, now)}</time>
          {counts ? ` · ${counts}` : ''}
          {item.file ? ` · ${fileMeta(item)}` : ''}
        </p>
      </header>

      {isPage && (
        <div role="group" aria-label="Review view" className="flex w-fit gap-1 rounded-md border border-line p-0.5">
          {(
            [
              ['full', 'Full document'],
              ['changes', 'Changes only'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={`rounded px-2.5 py-1 text-xs font-medium max-md:min-h-11 ${view === value ? 'bg-active text-fg' : 'text-muted hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="w-full max-w-[620px]">
      {isPage ? (
        diff.error ? (
          <ErrorNote error={diff.error} />
        ) : diff.isPending ? (
          <Loading what="review" />
        ) : diff.data ? (
          view === 'full' ? (
            <ReviewDocument entries={diff.data} label={`Full document of ${item.document.title}`} />
          ) : (
            <DiffView entries={diff.data} label={`Changes in version ${version.number} of ${item.document.title}`} />
          )
        ) : null
      ) : (
        <FileReviewPreview versionId={version.id} title={item.document.title} version={reviewFile ?? undefined} autoOpen />
      )}
      </div>

      <footer className="sticky bottom-0 z-10 mt-2 flex flex-col gap-2 border-t border-line bg-page/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        {rejecting && (
          <RejectForm
            onSubmit={(note) => reject.mutate(note)}
            onCancel={() => {
              reject.reset();
              setRejecting(false);
            }}
            pending={busy}
          />
        )}
        {blocked && (
          <p id={blockedId} className="text-sm text-fg">
            {blocked}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button className="max-md:min-h-11" onClick={() => approve.mutate()} disabled={blocked !== null || busy} aria-describedby={blocked ? blockedId : undefined}>
            Approve
          </Button>
          <Button className="max-md:min-h-11" variant="danger" onClick={() => setRejecting(true)} disabled={busy || rejecting}>
            Reject…
          </Button>
        </div>
        <ErrorNote error={approve.error && !rejecting ? approve.error : null} />
      </footer>
    </section>
  );
}

/** The queue list, shared by the desktop two-pane and the phone's queue-only view. */
function ReviewQueue({
  items,
  selectedId,
  now,
  onSelect,
}: {
  items: ReviewItem[];
  selectedId: string | null;
  now: Date;
  onSelect: (item: ReviewItem) => void;
}) {
  return (
    <aside aria-label="Review queue" className="flex flex-col gap-2">
      <ul aria-label="Changes waiting for review" className="flex flex-col gap-1">
        {items.map((item) => {
          const active = item.version.id === selectedId;
          return (
            <li key={item.version.id}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(item)}
                className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left ${
                  active ? 'border-accent bg-active' : 'border-transparent hover:bg-hover'
                }`}
              >
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-base leading-none text-muted">
                  {item.document.kind === 'file' ? (
                    <FileTypeTile name={item.document.title} size={20} />
                  ) : isKnownIcon(item.document.icon) ? (
                    <span aria-hidden="true">{item.document.icon}</span>
                  ) : (
                    <PageIcon />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-semibold text-fg">{item.document.title}</span>
                  <span className="truncate text-[11px] text-muted">
                    {item.document.spaceName} · Version {item.version.number}
                  </span>
                  <span className="text-[10.5px] text-muted">{ago(item.version.createdAt, now)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {items.length === 1 && <p className="px-2 text-xs text-muted">Nothing else waiting</p>}
    </aside>
  );
}

/** `/w/$tenantSlug/reviews`: the queue on the left, the selected version's full or changed document on the right. */
export function ReviewsPage() {
  const { tenant } = useWorkspace();
  const { data: spaces = [] } = useSpaces();
  const params = useSearch({ from: '/w/$tenantSlug/reviews' });
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 1200px)');
  const [spaceId, setSpaceId] = useState(ALL_SPACES);
  const { data: items, error, isPending } = useReviews(spaceId === ALL_SPACES ? undefined : spaceId);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const now = new Date();
  const reviewId = params.review ?? null;

  useEffect(() => {
    if (!items) return;
    if (selected !== null && items.some((item) => item.version.id === selected)) return;
    setSelected(items[0]?.version.id ?? null);
  }, [items, selected]);

  useEffect(() => {
    if (wide || reviewId === null || !items) return;
    if (items.some((item) => item.version.id === reviewId)) return;
    const next = items[0];
    navigate({
      to: '/w/$tenantSlug/reviews',
      params: { tenantSlug: tenant.slug },
      search: next ? { review: next.version.id } : {},
      replace: true,
    });
  }, [wide, reviewId, items, navigate, tenant.slug]);

  const options = [
    { value: ALL_SPACES, label: 'All spaces' },
    ...spaces.filter((s) => s.archivedAt === null).map((s) => ({ value: s.id, label: s.name })),
  ];
  const selectedId = wide ? selected : reviewId;
  const current = items?.find((item) => item.version.id === selectedId) ?? null;
  const waiting = items?.length ?? 0;

  function select(item: ReviewItem) {
    setNotice(null);
    if (wide) {
      setSelected(item.version.id);
      return;
    }
    navigate({
      to: '/w/$tenantSlug/reviews',
      params: { tenantSlug: tenant.slug },
      search: { review: item.version.id },
    });
  }

  function backToQueue() {
    navigate({ to: '/w/$tenantSlug/reviews', params: { tenantSlug: tenant.slug }, search: {} });
  }

  return (
    <>
      <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Reviews</span>} />
      <div className="mx-auto flex w-full flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold text-fg">Reviews</h1>
            <p className="text-xs text-muted">{waiting} waiting</p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span className="sr-only">Scope</span>
            <select
              aria-label="Filter by space"
              value={spaceId}
              onChange={(event) => {
                setSpaceId(event.target.value);
                setNotice(null);
              }}
              className="rounded-md border border-line bg-page px-2 py-1.5 text-xs text-fg"
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </header>

        <ErrorNote error={error} />
        {notice && (
          <p
            role={notice.tone === 'bad' ? 'alert' : 'status'}
            className={`rounded-md border px-3 py-2 text-sm ${
              notice.tone === 'bad' ? 'border-danger bg-danger-bg text-danger' : 'border-line bg-hover text-fg'
            }`}
          >
            {notice.text}
          </p>
        )}

        {isPending ? (
          <Loading what="reviews" />
        ) : items && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-full bg-hover text-lg text-muted">
              ✓
            </span>
            <p className="text-sm text-muted">Nothing is waiting for your review.</p>
          </div>
        ) : items ? (
          wide ? (
            <div className="grid gap-5 min-[1200px]:grid-cols-[280px_minmax(0,1fr)]">
              <ReviewQueue items={items} selectedId={selectedId} now={now} onSelect={select} />
              {current && <ReviewDetail key={current.version.id} item={current} now={now} onResult={setNotice} />}
            </div>
          ) : reviewId ? (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={backToQueue}
                className="self-start rounded-md px-1 py-1 text-xs font-medium text-accent-text hover:underline max-md:min-h-11"
              >
                ← Back to reviews
              </button>
              {current ? (
                <ReviewDetail key={current.version.id} item={current} now={now} onResult={setNotice} />
              ) : (
                <p className="text-sm text-muted">That review has left the queue.</p>
              )}
            </div>
          ) : (
            <ReviewQueue items={items} selectedId={selectedId} now={now} onSelect={select} />
          )
        ) : null}
      </div>
    </>
  );
}
