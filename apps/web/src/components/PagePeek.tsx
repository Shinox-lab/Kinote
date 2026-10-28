import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { blockSourcesOf } from '../lib/links.js';
import { usePageConnections, useWorkspace } from '../lib/queries.js';
import { useLivePage } from '../lib/useLivePage.js';
import { usePageView } from '../lib/usePageView.js';
import { usePeek } from '../lib/usePeek.js';
import { usePageThreadStore } from '../lib/useThreadStore.js';
import { Editor } from './Editor.js';
import { ConnectionsList } from './PageConnections.js';
import { ErrorNote, Loading } from './ui.js';

/**
 * A page beside the current screen (`?peek=`): its title, the live editor
 * (editable when the reader may edit) and its connections. Escape or Close
 * shuts it; "Open as full page" goes to the page itself.
 */
export function PagePeek({ pageId }: { pageId: string }) {
  const { tenant, role: tenantRole } = useWorkspace();
  const peek = usePeek();
  const { page, error, isPending, space, archived, reload } = usePageView(pageId);
  const livePage = useLivePage(pageId, reload);
  const { data: connections } = usePageConnections(pageId);
  const threads = usePageThreadStore(pageId, {
    canEdit: livePage.access === 'write' && !archived,
    moderates: space?.myRole === 'admin' || tenantRole === 'owner' || tenantRole === 'admin',
  });
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) peek.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => panelRef.current?.focus(), [pageId]);

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      aria-label="Page preview"
      className="fixed inset-y-0 right-0 z-30 flex w-[45vw] min-w-[420px] max-w-[760px] flex-col border-l border-line bg-page shadow-pop outline-none max-md:inset-0 max-md:w-full max-md:min-w-0 max-md:max-w-none"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <span className="min-w-0 truncate text-xs text-muted">{space?.name ?? ''}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            to="/w/$tenantSlug/p/$pageId"
            params={{ tenantSlug: tenant.slug, pageId }}
            search={{}}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
          >
            Open as full page
          </Link>
          <button
            type="button"
            onClick={peek.close}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
          >
            Close
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {!page ? (
          isPending ? (
            <Loading what="page" />
          ) : (
            <ErrorNote error={error} />
          )
        ) : (
          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">
              {page.icon && <span aria-hidden="true">{page.icon} </span>}
              {page.title}
            </h1>
            <Editor
              key={pageId}
              live={livePage.live}
              access={livePage.access}
              archived={archived}
              error={livePage.error}
              retry={livePage.retry}
              place={{ pageId, spaceId: page.spaceId }}
              sources={connections ? blockSourcesOf(connections) : []}
              threads={threads}
            />
            {connections && <ConnectionsList connections={connections} />}
          </div>
        )}
      </div>
    </aside>
  );
}
