import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CaptureDetail, CaptureSummary } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { captureStatusLabel, captureWaitingOnFile } from '../../lib/capture.js';
import { useCapture, useRefresh } from '../../lib/queries.js';
import { relativeTime } from '../../lib/pageStatus.js';
import { ErrorNote, Loading } from '../ui.js';
import { Receipt } from './Receipt.js';

const STATUS_TONE: Record<CaptureSummary['status'], string> = {
  queued: 'bg-hover text-muted',
  routing: 'bg-dot-review/15 text-fg',
  waiting_for_answer: 'bg-review-bg text-review-text',
  done: 'bg-success-bg text-success',
  failed: 'bg-danger-bg text-danger',
};

/** The engine's questions with their options, and the sender's answers. */
function Thread({ detail }: { detail: CaptureDetail }) {
  const refresh = useRefresh();
  const answer = useMutation({
    mutationFn: (a: { messageId: string; choice: string }) =>
      api.answerCapture(detail.capture.id, { message_id: a.messageId, choice: a.choice }),
    onSuccess: () => {
      void refresh('capture', detail.capture.id);
      void refresh('captures');
    },
  });
  if (detail.thread.length === 0) return null;
  const answers = new Map(
    detail.thread.filter((m) => m.author === 'sender' && m.answersMessageId).map((m) => [m.answersMessageId!, m])
  );
  return (
    <ul aria-label="Thread" className="flex flex-col gap-2">
      {detail.thread
        .filter((m) => m.author === 'engine')
        .map((m) => {
          const answered = answers.get(m.id);
          return (
            <li key={m.id} className="flex flex-col gap-1.5 rounded-md border-l-[3px] border-[var(--routing)] bg-[var(--routing-tint)] px-3 py-2 text-sm">
              <p className="font-medium text-fg">{m.body}</p>
              {answered ? (
                <p className="text-xs text-muted">You answered: {answered.body}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(m.options ?? []).map((o) => (
                    <button
                      key={o.entityId}
                      type="button"
                      disabled={answer.isPending}
                      onClick={() => answer.mutate({ messageId: m.id, choice: o.entityId })}
                      className="rounded-md border border-line bg-page px-2.5 py-1 text-xs font-medium text-fg hover:bg-hover disabled:opacity-50 max-md:min-h-11"
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      <ErrorNote error={answer.error} />
    </ul>
  );
}

/** One capture: what was sent, how far the engine got, its thread and its receipt. */
export function CaptureCard({ capture, defaultOpen }: { capture: CaptureSummary; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { data: detail, error, isPending } = useCapture(capture.id, open);
  const status = detail?.capture.status ?? capture.status;
  const refresh = useRefresh();
  // When routing finishes, facts it could not place have just joined Needs a home.
  const lastStatus = useRef(status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = status;
    if ((was === 'queued' || was === 'routing') && status !== 'queued' && status !== 'routing') {
      void refresh('needs-home');
    }
    // `refresh` is a new function every render; the status is the trigger.
  }, [status]);
  // Routing can finish before this card ever saw it run: a receipt with
  // something waiting for a place refreshes Needs a home too.
  const waiting = detail
    ? detail.receipt.needsHome.length + (detail.receipt.document?.outcome === 'needs_home' ? 1 : 0)
    : 0;
  useEffect(() => {
    if (waiting > 0) void refresh('needs-home');
  }, [waiting]);
  return (
    <article aria-label={`Capture from ${relativeTime(capture.createdAt)}`} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status]}`}>
          {captureWaitingOnFile({ status, file: capture.file }) ? 'Reading the file…' : captureStatusLabel(status)}
        </span>
        <span className="text-xs text-muted">{relativeTime(capture.createdAt)}</span>
      </div>
      {capture.text && <p className="whitespace-pre-wrap break-words text-sm text-fg">{capture.text}</p>}
      {capture.file && (
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span aria-hidden="true">📎</span>
          <span className="min-w-0 truncate">{capture.file.name}</span>
        </p>
      )}
      {status === 'failed' && (detail?.capture.error ?? capture.error) && (
        <p role="alert" className="text-xs text-danger">
          {detail?.capture.error ?? capture.error}
        </p>
      )}
      {open ? (
        isPending ? (
          <Loading what="what happened" />
        ) : detail ? (
          <>
            <Thread detail={detail} />
            <Receipt captureId={capture.id} receipt={detail.receipt} />
          </>
        ) : (
          <ErrorNote error={error} />
        )
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="self-start text-xs font-medium text-accent-text hover:underline max-md:min-h-11">
          Show what happened
        </button>
      )}
    </article>
  );
}
