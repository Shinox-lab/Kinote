import { useEffect, useRef } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { usePageChanges, useRefresh, useSpaceTree, useWorkspace } from '../lib/queries.js';
import { closeHistory, openHistory, useHistoryOpen } from '../lib/pageUi.js';
import { usePageView } from '../lib/usePageView.js';
import { ancestorIds, blockHighlightCss } from '../lib/wiki.js';
import { Badge } from '../components/Badge.js';
import { Editor } from '../components/Editor.js';
import { HistoryDrawer } from '../components/HistoryDrawer.js';
import { LifecycleMenu } from '../components/LifecycleMenu.js';
import { PageActions } from '../components/PageActions.js';
import { useSidebarColumn } from '../components/sidebar/SidebarContext.js';
import { Button, ErrorNote, Loading } from '../components/ui.js';

const CRUMB = 'max-w-[12rem] truncate rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg';

/** The page's place in the workspace: its space, then each parent page, as links. */
function Breadcrumb({ pageId, spaceId, tenantSlug }: { pageId: string; spaceId: string; tenantSlug: string }) {
  const { spaces } = usePageView(pageId);
  const { data: tree } = useSpaceTree(spaceId);
  const space = spaces.find((s) => s.id === spaceId);
  const nodes = tree?.nodes ?? [];
  const parents = ancestorIds(nodes, pageId)
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm">
      <ol className="flex flex-wrap items-center gap-0.5">
        {space && (
          <li className="flex items-center gap-0.5">
            <Link to="/w/$tenantSlug/s/$spaceSlug" params={{ tenantSlug, spaceSlug: space.slug }} className={CRUMB}>
              {space.name}
            </Link>
          </li>
        )}
        {parents.map((p) => (
          <li key={p.id} className="flex items-center gap-0.5">
            <span aria-hidden="true" className="text-muted">
              /
            </span>
            <Link to="/w/$tenantSlug/p/$pageId" params={{ tenantSlug, pageId: p.id }} className={CRUMB}>
              {p.title}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** `/w/$tenantSlug/p/$pageId`: a quiet page: where it is, its status, its title, and the live editor. */
export function PagePage() {
  const { tenant } = useWorkspace();
  const { pageId } = useParams({ from: '/w/$tenantSlug/p/$pageId' });
  const refresh = useRefresh();
  const { page, error, isPending, spaces, archived, controls, reload, changed } = usePageView(pageId);
  const { data: entries } = usePageChanges(pageId);
  const historyOpen = useHistoryOpen(pageId);
  const sidebarColumn = useSidebarColumn();

  // The drawer belongs to this page: leaving it closes the drawer.
  useEffect(() => () => closeHistory(), [pageId]);

  // The badge moved (indexing finished, a review landed): what changed since the indexed version moved with it.
  const badge = page?.badge;
  const lastBadge = useRef(badge);
  useEffect(() => {
    if (badge !== undefined && lastBadge.current !== undefined && lastBadge.current !== badge) {
      void refresh('page', pageId, 'changes');
    }
    lastBadge.current = badge;
    // `refresh` is a new function every render; the badge is the trigger.
  }, [badge, pageId]);

  if (!page || !controls) return isPending ? <Loading what="page" /> : <ErrorNote error={error} />;

  return (
    <article className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
      {/* The changed blocks wear their author's colour here, as in the sidebar's list. */}
      <style>{blockHighlightCss(entries ?? [])}</style>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Breadcrumb pageId={pageId} spaceId={page.spaceId} tenantSlug={tenant.slug} />
        <div className="flex items-center gap-2">
          <Badge badge={page.badge} />
          {archived && <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">Archived</span>}
          <LifecycleMenu page={page} spaces={spaces} controls={controls} onChanged={changed} />
        </div>
      </header>
      <h1 className="text-4xl font-bold leading-tight tracking-tight">{page.title}</h1>
      {/* With no sidebar column the page carries its own actions; otherwise they are in the sidebar. */}
      {!sidebarColumn && (
        <div className="flex flex-wrap items-start gap-2">
          <PageActions page={page} controls={controls} onChanged={changed} />
          <Button variant="secondary" aria-haspopup="dialog" onClick={() => openHistory(pageId)}>
            History
          </Button>
        </div>
      )}
      {/* A failed refetch keeps the last page on screen and says so. */}
      <ErrorNote error={error} />
      <Editor key={pageId} pageId={pageId} archived={archived} onSynced={reload} />
      {historyOpen && (
        <HistoryDrawer pageId={pageId} canRestore={controls.restoreVersion} onClose={closeHistory} onRestored={changed} />
      )}
    </article>
  );
}
