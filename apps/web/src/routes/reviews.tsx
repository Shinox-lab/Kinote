import { useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { ReviewItem } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { versionReasonLabel, versionStatusLabel, whenLabel } from '../lib/history.js';
import { useRefresh, useReviews, useSpaces, useVersionDiff, useWorkspace } from '../lib/queries.js';
import { REJECT_NOTE_MAX, approveBlockedReason, rejectNoteState } from '../lib/review.js';
import { DiffView } from '../components/DiffView.js';
import { Button, Card, ErrorNote, Loading, SelectField } from '../components/ui.js';

const ALL_SPACES = '';

/** The block diff of one item, fetched when first opened (not for the whole queue up front). */
function ItemDiff({ item }: { item: ReviewItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { data: entries, error, isPending } = useVersionDiff(item.version.id, open);
  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" className="self-start" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide changes' : 'Show changes'}
      </Button>
      <div id={panelId} hidden={!open}>
        {open &&
          (error ? (
            <ErrorNote error={error} />
          ) : isPending ? (
            <Loading what="changes" />
          ) : (
            <DiffView entries={entries} label={`Changes in version ${item.version.number} of ${item.document.title}`} />
          ))}
      </div>
    </div>
  );
}

/** A note of 1 to 300 characters, counted as the API counts it; Reject stays off until it is valid. */
function RejectForm({
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  onSubmit: (note: string) => void;
  onCancel: () => void;
  pending: boolean;
  error: unknown;
}) {
  const [note, setNote] = useState('');
  const id = useId();
  const { length, valid } = rejectNoteState(note);
  const tooLong = length > REJECT_NOTE_MAX;
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
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
        onChange={(e) => setNote(e.target.value)}
        aria-describedby={`${id}-count`}
        aria-invalid={tooLong}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm"
      />
      <p id={`${id}-count`} className={`text-xs ${tooLong ? 'text-red-700' : 'text-slate-600'}`}>
        {length} / {REJECT_NOTE_MAX} characters
        {length === 0 ? ' (a note is required)' : tooLong ? ' (too long)' : ''}
      </p>
      <ErrorNote error={error} />
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

function Item({ item }: { item: ReviewItem }) {
  const { tenant } = useWorkspace();
  const refresh = useRefresh();
  const [rejecting, setRejecting] = useState(false);
  const blocked = approveBlockedReason(item);
  const blockedId = useId();

  // The version leaves the queue, and the page (badge), its history and the trees follow it.
  const settled = () => {
    void refresh('reviews');
    void refresh('page');
    void refresh('versions');
    void refresh('tree');
    void refresh('archived');
  };
  const approve = useMutation({ mutationFn: () => api.approveVersion(item.version.id), onSuccess: settled });
  const reject = useMutation({
    mutationFn: (note: string) => api.rejectVersion(item.version.id, { review_note: note }),
    onSuccess: settled,
  });
  const busy = approve.isPending || reject.isPending;
  const { version } = item;

  return (
    <li>
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Link
              to="/w/$tenantSlug/p/$pageId"
              params={{ tenantSlug: tenant.slug, pageId: item.document.id }}
              className="text-base font-semibold text-indigo-700 hover:underline"
            >
              {item.document.title}
            </Link>
            <p className="text-xs text-slate-600">
              {item.document.spaceName} · Version {version.number} · {versionStatusLabel(version.status)} ·{' '}
              {versionReasonLabel(version.reason)} · <time dateTime={version.createdAt}>{whenLabel(version.createdAt)}</time>
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-slate-600">Contributors:</span>
              {item.contributors.length === 0 && <span className="text-slate-600">none recorded</span>}
              {item.contributors.map((c) => (
                <span key={`${c.type}-${c.id}`} className="inline-flex items-center gap-1">
                  {c.name}
                  {c.isAgent && <span className="rounded bg-slate-800 px-1.5 text-[10px] uppercase tracking-wide text-white">Agent</span>}
                </span>
              ))}
            </p>
          </div>
          <ItemDiff item={item} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => approve.mutate()} disabled={blocked !== null || busy} aria-describedby={blocked ? blockedId : undefined}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy || rejecting}>
              Reject…
            </Button>
          </div>
          {blocked && (
            <p id={blockedId} className="text-sm text-slate-700">
              {blocked}
            </p>
          )}
          <ErrorNote error={approve.error} />
          {rejecting && (
            <RejectForm onSubmit={(note) => reject.mutate(note)} onCancel={() => setRejecting(false)} pending={busy} error={reject.error} />
          )}
        </div>
      </Card>
    </li>
  );
}

/** `/w/$tenantSlug/reviews`: the versions waiting for review in the spaces the user can review. */
export function ReviewsPage() {
  const { data: spaces = [] } = useSpaces();
  const [spaceId, setSpaceId] = useState(ALL_SPACES);
  const { data: items, error, isPending } = useReviews(spaceId === ALL_SPACES ? undefined : spaceId);

  const options = [
    { value: ALL_SPACES, label: 'All spaces' },
    ...spaces.filter((s) => s.archivedAt === null).map((s) => ({ value: s.id, label: s.name })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Reviews</h1>
        <div className="w-56">
          <SelectField label="Filter by space" value={spaceId} options={options} onChange={setSpaceId} />
        </div>
      </div>
      <ErrorNote error={error} />
      {isPending ? (
        <Loading what="reviews" />
      ) : items && items.length === 0 ? (
        <p className="text-sm text-slate-600">Nothing is waiting for your review.</p>
      ) : (
        items && (
          <ul aria-label="Changes waiting for review" className="flex flex-col gap-4">
            {items.map((item) => (
              <Item key={item.version.id} item={item} />
            ))}
          </ul>
        )
      )}
    </div>
  );
}
