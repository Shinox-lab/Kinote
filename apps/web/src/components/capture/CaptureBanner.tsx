import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { CaptureChange } from '@living-wiki/contracts';
import { cssString } from '../../lib/wiki.js';
import { useCapture, useWorkspace } from '../../lib/queries.js';

/** How long the banner waits for the editor to show the first change before it gives up scrolling. */
const SCROLL_WAIT_MS = 5_000;

/**
 * "Changes from this capture": who made them, what they were, and the way
 * back to the plain page. Scrolls the first applied change into view once
 * the editor has drawn it.
 */
export function CaptureBanner({ pageId, captureId, changes }: { pageId: string; captureId: string; changes: CaptureChange[] }) {
  const { tenant } = useWorkspace();
  // Only the sender (or an admin) may read the capture; anyone else sees "a teammate".
  const { data: capture } = useCapture(captureId);
  const sender = capture?.capture.senderName ?? 'a teammate';
  const first = changes.find((c) => c.status === 'applied')?.blockId;

  useEffect(() => {
    if (!first) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const el = document.querySelector(`[data-id="${cssString(first)}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        clearInterval(timer);
      } else if (Date.now() - started > SCROLL_WAIT_MS) {
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [first]);

  return (
    <section aria-label="Changes from this capture" className="flex flex-col gap-2 rounded-lg border-l-[3px] border-[var(--routing)] bg-[var(--routing-tint)] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg">Changes from this capture · Routing engine on behalf of {sender}</p>
        <Link
          to="/w/$tenantSlug/p/$pageId"
          params={{ tenantSlug: tenant.slug, pageId }}
          search={{}}
          className="text-xs font-medium text-accent-text hover:underline max-md:min-h-11"
        >
          Exit
        </Link>
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {changes.map((c) => (
          <li key={c.id} className={c.status === 'applied' ? 'text-fg' : 'text-muted'}>
            {c.beforeMarkdown && <span className="mr-1 line-through">{c.beforeMarkdown}</span>}
            <span>{c.afterMarkdown}</span>
            {c.status !== 'applied' && <span className="ml-1">({c.status === 'moved' ? 'moved' : 'undone'})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
