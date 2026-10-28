import { useEffect, useState } from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import { commentBody, commentText } from '../lib/comments.js';
import { relativeTime } from '../lib/pageStatus.js';
import type { ApiThreadStore } from '../lib/threadStore.js';
import { useThreads } from '../lib/useThreadStore.js';
import { Button, ErrorNote } from './ui.js';

/** Scrolls the page to a block and flashes it. */
function showBlock(blockId: string) {
  const el = document.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${CSS.escape(blockId)}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Whether the thread's comment mark is still in this page (not a side panel's): otherwise its text was removed or rewritten. */
function anchored(threadId: string): boolean {
  return document.querySelector(`article [data-bn-thread-id="${CSS.escape(threadId)}"]`) !== null;
}

function ThreadCard({
  thread,
  store,
  canEdit,
  onPage,
}: {
  thread: ThreadData;
  store: ApiThreadStore;
  canEdit: boolean;
  onPage: boolean;
}) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const meta = thread.metadata as { blockId: string | null; quote: string | null };
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li aria-label={`Thread on ${meta.quote ?? 'this page'}`} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
      {meta.quote && (
        <button
          type="button"
          disabled={!meta.blockId}
          onClick={() => meta.blockId && showBlock(meta.blockId)}
          className="border-l-2 border-[var(--accent-text)] pl-2 text-left text-xs text-muted hover:text-fg disabled:hover:text-muted"
        >
          {meta.quote}
        </button>
      )}
      {!onPage && <span className="text-[11px] font-medium text-muted">On removed text</span>}
      <ol className="flex flex-col gap-2">
        {thread.comments.map((c) => (
          <li key={c.id} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted">
              <span className="font-medium text-fg">{store.userName(c.userId) ?? 'Someone'}</span> · {relativeTime(c.createdAt.toISOString())}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm text-fg">
              {c.deletedAt ? <span className="italic text-muted">Deleted</span> : commentText(c.body)}
            </p>
          </li>
        ))}
      </ol>
      {/* A thread on removed text is kept to read, not to carry on. */}
      {canEdit && !thread.resolved && onPage && (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const body = commentBody(reply);
            if (body.length === 0) return;
            void act(async () => {
              await store.addComment({ threadId: thread.id, comment: { body } });
              setReply('');
            });
          }}
        >
          <label className="sr-only" htmlFor={`reply-${thread.id}`}>
            Reply
          </label>
          <textarea
            id={`reply-${thread.id}`}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            placeholder="Reply… (@Full Name mentions someone)"
            className="w-full resize-y rounded-md border border-line bg-page px-2 py-1.5 text-sm text-fg"
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || reply.trim() === ''}>
              Reply
            </Button>
          </div>
        </form>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(() => (thread.resolved ? store.unresolveThread({ threadId: thread.id }) : store.resolveThread({ threadId: thread.id })))
            }
            className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg disabled:opacity-50 max-md:min-h-11"
          >
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </li>
  );
}

/**
 * Every thread of the page, those whose text is gone included ("On removed
 * text"): open ones first, resolved ones on request. Comments are started
 * from a text selection in the editor; here they are read, answered and resolved.
 */
export function CommentsPanel({ store, canEdit, onClose }: { store: ApiThreadStore; canEdit: boolean; onClose: () => void }) {
  const threads = [...useThreads(store).values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const [showResolved, setShowResolved] = useState(false);
  // Which threads still have their text is read from the editor's marks: look again while the panel is open
  // (the editor may mount after the panel, and edits remove text).
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 2_000);
    return () => clearInterval(timer);
  }, []);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);
  const shown = showResolved ? [...open, ...resolved] : open;
  return (
    <section aria-label="Comments" className="flex flex-col gap-3 rounded-lg border border-line bg-page p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">Comments</h2>
        <div className="flex items-center gap-1">
          {resolved.length > 0 && (
            <button
              type="button"
              aria-pressed={showResolved}
              onClick={() => setShowResolved((v) => !v)}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
            >
              {showResolved ? 'Hide resolved' : `Show resolved (${resolved.length})`}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
          >
            Close
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">
          {canEdit ? 'No open comments. Select text in the page and choose Comment to start one.' : 'No open comments.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((t) => (
            <ThreadCard key={t.id} thread={t} store={store} canEdit={canEdit} onPage={anchored(t.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
