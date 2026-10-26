import type { CaptureReceipt } from '@living-wiki/contracts';
import { hiddenChangesText, outcomeLabel } from '../../lib/capture.js';

const OUTCOME_TONE = {
  applied: 'bg-success-bg text-success',
  waiting_review: 'bg-review-bg text-review-text',
  suggestion: 'bg-hover text-fg',
} as const;

/** What a capture did, grouped by space and page; pages in spaces the viewer cannot read are only counted. */
export function Receipt({ receipt }: { captureId: string; receipt: CaptureReceipt }) {
  const hidden = hiddenChangesText(receipt.hiddenChanges);
  const empty =
    receipt.spaces.length === 0 && !hidden && receipt.alreadyKnown.length === 0 && receipt.needsHome.length === 0;
  if (empty) return null;
  return (
    <section aria-label="Receipt" className="flex flex-col gap-3">
      {receipt.spaces.map((space) => (
        <div key={space.spaceId} className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{space.spaceName}</h3>
          {space.pages.map((page) => (
            <div key={page.documentId} className="flex flex-col gap-1.5 rounded-md border border-line bg-page p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{page.title}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OUTCOME_TONE[page.outcome]}`}>
                  {outcomeLabel(page.outcome)}
                </span>
              </div>
              {page.changes.map((change) => (
                <div key={change.id} className="text-sm">
                  {change.beforeMarkdown && <p className="break-words text-muted line-through">{change.beforeMarkdown}</p>}
                  <p className="whitespace-pre-wrap break-words text-fg">{change.afterMarkdown}</p>
                </div>
              ))}
            </div>
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
    </section>
  );
}
