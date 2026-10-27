import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { CaptureReceipt, UndoChangesResponse } from '@living-wiki/contracts';
import { ApiError, api } from '../../lib/api.js';
import { documentHeadline, hiddenChangesText, keptText, outcomeLabel, undoNotice, type CaptureChange } from '../../lib/capture.js';
import { useRefresh, useWorkspace } from '../../lib/queries.js';
import { Button, ErrorNote } from '../ui.js';
import { PagePicker } from './PagePicker.js';

type ReceiptPage = CaptureReceipt['spaces'][number]['pages'][number];

const OUTCOME_TONE = {
  applied: 'bg-success-bg text-success',
  waiting_review: 'bg-review-bg text-review-text',
  suggestion: 'bg-hover text-fg',
} as const;

/**
 * Undoes changes one after another and adds their results up (one call per
 * change). A change someone already undid (another tab, Undo all) is done:
 * the rest still get their turn.
 */
async function undoAll(changes: CaptureChange[]): Promise<UndoChangesResponse> {
  const total: UndoChangesResponse = { undone: [], changedSince: [] };
  for (const change of changes) {
    try {
      const r = await api.undoChange(change.id);
      total.undone.push(...r.undone);
      total.changedSince.push(...r.changedSince);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'change_already_undone')) throw err;
    }
  }
  return total;
}

function ChangeRow({ change, kept, onMoved }: { change: CaptureChange; kept: boolean; onMoved: () => void }) {
  const [picking, setPicking] = useState(false);
  const move = useMutation({
    mutationFn: (pageId: string) => api.moveChange(change.id, { target_page_id: pageId }),
    onSuccess: () => {
      setPicking(false);
      onMoved();
    },
  });
  const movable = change.status === 'applied' && (change.op === 'insert' || change.op === 'replace');
  return (
    <div className="flex flex-col gap-1 text-sm">
      {change.beforeMarkdown && <p className="break-words text-muted line-through">{change.beforeMarkdown}</p>}
      <p className={`whitespace-pre-wrap break-words ${change.status === 'applied' ? 'text-fg' : 'text-muted line-through'}`}>
        {change.afterMarkdown}
      </p>
      {change.status !== 'applied' && <p className="text-xs text-muted">{change.status === 'moved' ? 'Moved' : 'Undone'}</p>}
      {kept && change.status === 'applied' && <p className="text-xs font-medium text-warn-text">Changed since, not undone</p>}
      {change.reason && <p className="text-xs text-muted">Why here: {change.reason}</p>}
      {movable && (
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="self-start text-xs font-medium text-accent-text hover:underline max-md:min-h-11"
        >
          Wrong page → move to…
        </button>
      )}
      {picking && <PagePicker label="Find a page" disabled={move.isPending} onPick={(p) => move.mutate(p.id)} />}
      <ErrorNote error={move.error} />
    </div>
  );
}

/** One page of the receipt: where it went, what changed, and taking it back. */
function PageCard({
  captureId,
  page,
  kept,
  undoing,
  onUndo,
}: {
  captureId: string;
  page: ReceiptPage;
  kept: ReadonlySet<string>;
  undoing: boolean;
  onUndo: (run: () => Promise<UndoChangesResponse>) => void;
}) {
  const { tenant } = useWorkspace();
  const refresh = useRefresh();
  const applied = page.changes.filter((c) => c.status === 'applied');
  const settled = () => {
    void refresh('capture', captureId);
    void refresh('captures');
    void refresh('needs-home');
    void refresh('page', page.documentId);
  };

  return (
    <section aria-label={page.title} className="flex flex-col gap-2 rounded-md border border-line bg-page p-3">
      <div className="flex flex-wrap items-center gap-2">
        {page.outcome === 'waiting_review' ? (
          <Link to="/w/$tenantSlug/reviews" params={{ tenantSlug: tenant.slug }} className="text-sm font-medium text-fg hover:underline">
            {page.title}
          </Link>
        ) : (
          <Link
            to="/w/$tenantSlug/p/$pageId"
            params={{ tenantSlug: tenant.slug, pageId: page.documentId }}
            search={{ capture: captureId }}
            className="text-sm font-medium text-fg hover:underline"
          >
            {page.title}
          </Link>
        )}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OUTCOME_TONE[page.outcome]}`}>
          {outcomeLabel(page.outcome)}
        </span>
        {applied.length > 0 && (
          <Button variant="secondary" className="ml-auto !px-2 !py-1 text-xs" disabled={undoing} onClick={() => onUndo(() => undoAll(applied))}>
            Undo
          </Button>
        )}
      </div>
      {page.changes.map((change) => (
        <ChangeRow key={change.id} change={change} kept={kept.has(change.id)} onMoved={settled} />
      ))}
      {page.suggestions.map((s) => (
        <p key={s.id} className="rounded border border-dashed border-[var(--routing)] px-2 py-1 text-xs text-fg">
          Suggestion ({s.kind}): {s.proposedMarkdown ?? 'remove this block'} · {s.status}
        </p>
      ))}
    </section>
  );
}

/** A document capture's lead: its new page (open, undo, move) or that it waits for a place. */
function DocumentLead({
  captureId,
  document,
  kept,
  undoing,
  onUndo,
}: {
  captureId: string;
  document: NonNullable<CaptureReceipt['document']>;
  kept: number;
  undoing: boolean;
  onUndo: (run: () => Promise<UndoChangesResponse>) => void;
}) {
  const { tenant } = useWorkspace();
  const refresh = useRefresh();
  const [picking, setPicking] = useState(false);
  const move = useMutation({
    mutationFn: (parentId: string) => api.moveDocument(captureId, { parent_page_id: parentId }),
    onSuccess: () => {
      setPicking(false);
      void refresh('capture', captureId);
      void refresh('page');
      void refresh('tree');
    },
  });
  const headline = documentHeadline(document);
  const keptLine = keptText(kept);
  const firstChange = document.changeIds[0];
  return (
    <section aria-label="New page" className="flex flex-col gap-2 rounded-md border border-[var(--routing)] bg-[var(--routing-tint)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        {document.pageId ? (
          <Link
            to="/w/$tenantSlug/p/$pageId"
            params={{ tenantSlug: tenant.slug, pageId: document.pageId }}
            search={{ capture: captureId }}
            className="min-w-0 break-words text-sm font-semibold text-fg hover:underline"
          >
            {headline}
          </Link>
        ) : (
          <p className="min-w-0 break-words text-sm font-semibold text-fg">
            {document.outcome === 'needs_home' ? (
              <a href="#needs-home" className="hover:underline">
                {headline}
              </a>
            ) : (
              headline
            )}
          </p>
        )}
        {document.pageId && firstChange && (
          <Button
            variant="secondary"
            className="ml-auto !px-2 !py-1 text-xs"
            disabled={undoing}
            onClick={() => onUndo(() => api.undoChange(firstChange))}
          >
            Undo
          </Button>
        )}
      </div>
      {document.reason && <p className="text-xs text-muted">{document.reason}</p>}
      {keptLine && <p className="text-xs text-muted">{keptLine}</p>}
      {document.pageId && firstChange && (
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="self-start text-xs font-medium text-accent-text hover:underline max-md:min-h-11"
        >
          Wrong place → move to…
        </button>
      )}
      {picking && <PagePicker label="Put it under" disabled={move.isPending} onPick={(p) => move.mutate(p.id)} />}
      <ErrorNote error={move.error} />
    </section>
  );
}

/** What a capture did, grouped by space and page; pages in spaces the viewer cannot read are only counted. */
export function Receipt({ captureId, receipt }: { captureId: string; receipt: CaptureReceipt }) {
  const [notice, setNotice] = useState<string | null>(null);
  // Changes an Undo left alone because someone changed their block since: named on their rows.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const refresh = useRefresh();
  const applied = receipt.spaces.flatMap((s) => s.pages.flatMap((p) => p.changes.filter((c) => c.status === 'applied')));
  // One undo at a time on this receipt (a page's, or all of them); whatever happens, look again.
  const undo = useMutation({
    mutationFn: (run: () => Promise<UndoChangesResponse>) => run(),
    onSuccess: (r) => {
      setNotice(undoNotice(r));
      setKept((prev) => new Set([...prev, ...r.changedSince]));
    },
    onSettled: () => {
      void refresh('capture', captureId);
      void refresh('captures');
      void refresh('needs-home');
      void refresh('page');
      void refresh('tree');
    },
  });
  const hidden = hiddenChangesText(receipt.hiddenChanges);
  const document = receipt.document;
  const empty =
    !document &&
    receipt.spaces.length === 0 &&
    !hidden &&
    receipt.alreadyKnown.length === 0 &&
    receipt.needsHome.length === 0;
  if (empty) return null;
  const undoable = applied.length + (document && document.changeIds.length > 0 ? 1 : 0);
  return (
    <section aria-label="Receipt" className="flex flex-col gap-3">
      {document && (
        <DocumentLead
          captureId={captureId}
          document={document}
          kept={receipt.filedInDocument.length}
          undoing={undo.isPending}
          onUndo={(run) => undo.mutate(run)}
        />
      )}
      {undoable > 1 && (
        <Button variant="secondary" className="self-start" disabled={undo.isPending} onClick={() => undo.mutate(() => api.undoCapture(captureId))}>
          Undo all applied
        </Button>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-line bg-hover px-3 py-2 text-sm text-fg">
          {notice}
        </p>
      )}
      <ErrorNote error={undo.error} />
      {document && receipt.spaces.length > 0 && (
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Also updated</h3>
      )}
      {receipt.spaces.map((space) => (
        <div key={space.spaceId} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{space.spaceName}</h3>
          {space.pages.map((page) => (
            <PageCard
              key={page.documentId}
              captureId={captureId}
              page={page}
              kept={kept}
              undoing={undo.isPending}
              onUndo={(run) => undo.mutate(run)}
            />
          ))}
        </div>
      ))}
      {hidden && <p className="text-xs text-muted">{hidden}</p>}
      {receipt.alreadyKnown.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Already known</h3>
          {receipt.alreadyKnown.map((f) => (
            <p key={f.factId} className="text-sm text-muted">
              {f.statement}
            </p>
          ))}
        </div>
      )}
      {receipt.needsHome.length > 0 && (
        <p className="text-xs text-muted">
          {receipt.needsHome.length === 1 ? '1 fact needs' : `${receipt.needsHome.length} facts need`} a home —{' '}
          <a href="#needs-home" className="font-medium text-accent-text hover:underline">
            place it above
          </a>
          .
        </p>
      )}
    </section>
  );
}
