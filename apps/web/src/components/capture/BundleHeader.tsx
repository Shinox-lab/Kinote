import { useMutation } from '@tanstack/react-query';
import type { ReviewItem } from '@kinote/contracts';
import { api, errorMessage } from '../../lib/api.js';
import { approvableInBundle } from '../../lib/capture.js';
import { relativeTime } from '../../lib/pageStatus.js';
import { useRefresh, useWorkspace } from '../../lib/queries.js';
import { DocumentLink } from '../DocumentLink.js';
import { Button } from '../ui.js';

/**
 * The top of a review that came from a capture: who sent it through the
 * Routing engine, what they wrote (as far as the reviewer may see), where
 * else it landed, and approving every page of it at once.
 */
export function BundleHeader({
  item,
  items,
  onResult,
}: {
  item: ReviewItem & { capture: NonNullable<ReviewItem['capture']> };
  items: ReviewItem[];
  onResult: (notice: { tone: 'ok' | 'bad'; text: string }) => void;
}) {
  const { tenant } = useWorkspace();
  const refresh = useRefresh();
  const { approve, skipped } = approvableInBundle(items, item.capture.id);
  const approveAll = useMutation({
    mutationFn: async () => {
      let done = 0;
      for (const each of approve) {
        await api.approveVersion(each.version.id);
        done += 1;
      }
      return done;
    },
    onSuccess: (done) =>
      onResult({
        tone: 'ok',
        text: `Approved ${done}.${skipped.length > 0 ? ` ${skipped.length} need another reviewer.` : ''}`,
      }),
    onError: (error) => onResult({ tone: 'bad', text: `Could not approve them all: ${errorMessage(error)}` }),
    onSettled: () => {
      void refresh('reviews');
      void refresh('page');
    },
  });
  return (
    <section aria-label="From Capture" className="flex flex-col gap-2 rounded-lg border-l-[3px] border-[var(--routing)] bg-[var(--routing-tint)] px-3 py-2">
      <p className="text-sm font-medium text-fg">
        Routing engine on behalf of {item.capture.senderName} · from Capture · {relativeTime(item.version.createdAt)}
      </p>
      {item.capture.excerpt && <p className="whitespace-pre-wrap break-words text-sm text-muted">{item.capture.excerpt}</p>}
      {item.capture.alsoApplied.length > 0 && (
        <p className="text-xs text-muted">
          Also applied:{' '}
          {item.capture.alsoApplied.map((p, i) => (
            <span key={p.pageId}>
              {i > 0 && ', '}
              <DocumentLink tenantSlug={tenant.slug} kind="page" id={p.pageId} className="font-medium text-accent-text hover:underline">
                {p.title}
              </DocumentLink>
            </span>
          ))}
        </p>
      )}
      {approve.length + skipped.length > 1 ? (
        <Button
          className="self-start max-md:min-h-11"
          disabled={approveAll.isPending || approve.length === 0}
          onClick={() => approveAll.mutate()}
        >
          Approve all from this capture
        </Button>
      ) : null}
    </section>
  );
}
