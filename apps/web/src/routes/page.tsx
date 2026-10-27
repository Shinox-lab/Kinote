import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import {
  usePageCaptureChanges,
  usePageChanges,
  usePageConnections,
  usePageSuggestions,
  useRefresh,
  useSpaceTree,
  useWorkspace,
} from '../lib/queries.js';
import { captureHighlightCss, suggestionMarkerCss } from '../lib/capture.js';
import { CaptureBanner } from '../components/capture/CaptureBanner.js';
import { SuggestionsPanel } from '../components/capture/SuggestionsPanel.js';
import { closeHistory, openHistory, useHistoryOpen, useHistoryTab } from '../lib/pageUi.js';
import { usePageView } from '../lib/usePageView.js';
import { useLivePage } from '../lib/useLivePage.js';
import { loadSession } from '../lib/session.js';
import { ancestorIds, blockHighlightCss, visibleChanges } from '../lib/wiki.js';
import { AppTopBar } from '../components/AppTopBar.js';
import { Editor } from '../components/Editor.js';
import { HistoryDrawer } from '../components/HistoryDrawer.js';
import { LifecycleMenu } from '../components/LifecycleMenu.js';
import { PageHeader } from '../components/PageHeader.js';
import { PageStatus } from '../components/PageStatus.js';
import { PagePresence } from '../components/PagePresence.js';
import { PageConnections } from '../components/PageConnections.js';
import { blockSourcesOf } from '../lib/links.js';
import { ErrorNote, Loading } from '../components/ui.js';

const CRUMB = 'min-w-0 max-w-[12rem] truncate rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg';

/** The page's place in the workspace: its space, each parent page, then this page's title. */
function Breadcrumb({
  pageId,
  spaceId,
  tenantSlug,
  title,
}: {
  pageId: string;
  spaceId: string;
  tenantSlug: string;
  title: string;
}) {
  const { spaces } = usePageView(pageId);
  const { data: tree } = useSpaceTree(spaceId);
  const space = spaces.find((s) => s.id === spaceId);
  const nodes = tree?.nodes ?? [];
  const parents = ancestorIds(nodes, pageId)
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm">
      <ol className="flex min-w-0 items-center gap-0.5">
        {space && (
          <li className="flex min-w-0 items-center gap-0.5">
            <Link to="/w/$tenantSlug/s/$spaceSlug" params={{ tenantSlug, spaceSlug: space.slug }} className={CRUMB}>
              {space.name}
            </Link>
          </li>
        )}
        {parents.map((p) => (
          <li key={p.id} className="flex items-center gap-0.5">
            <span aria-hidden="true" className="shrink-0 text-muted">
              /
            </span>
            <Link to="/w/$tenantSlug/p/$pageId" params={{ tenantSlug, pageId: p.id }} className={CRUMB}>
              {p.title}
            </Link>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-0.5">
          {(space || parents.length > 0) && (
            <span aria-hidden="true" className="shrink-0 text-muted">
              /
            </span>
          )}
          <span aria-current="page" className="min-w-0 max-w-[18rem] truncate px-1 py-0.5 font-medium text-fg">
            {title}
          </span>
        </li>
      </ol>
    </nav>
  );
}

/** `/w/$tenantSlug/p/$pageId`: a quiet page: where it is, its status, its title, and the live editor. */
export function PagePage() {
  const { tenant } = useWorkspace();
  const { pageId } = useParams({ from: '/w/$tenantSlug/p/$pageId' });
  const refresh = useRefresh();
  const { page, error, isPending, spaces, space, archived, controls, reload, changed } = usePageView(pageId);
  const { data: entries } = usePageChanges(pageId);
  const { capture: captureId } = useSearch({ from: '/w/$tenantSlug/p/$pageId' });
  const { data: captureChanges } = usePageCaptureChanges(pageId, captureId);
  const { data: suggestions } = usePageSuggestions(pageId);
  const { data: connections } = usePageConnections(pageId);
  const openSuggestions = (suggestions ?? []).filter((s) => s.status === 'open');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const historyOpen = useHistoryOpen(pageId);
  const historyTab = useHistoryTab(pageId);
  const livePage = useLivePage(pageId, reload);
  const selfId = loadSession()?.user.id ?? null;
  const authored = page?.latestVersion?.createdByType === 'user' && page.latestVersion.createdBy === selfId;
  const canReview =
    (space?.myRole === 'reviewer' || space?.myRole === 'admin') &&
    (space?.allowSelfApproval === true || !authored);

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
    <>
      <AppTopBar
        crumbs={<Breadcrumb pageId={pageId} spaceId={page.spaceId} tenantSlug={tenant.slug} title={page.title} />}
        right={
          <>
            <PagePresence live={livePage.live} state={livePage.state} onReconnect={livePage.reconnect} />
            {controls.move && !archived && (
              <Link
                to="/w/$tenantSlug/capture"
                params={{ tenantSlug: tenant.slug }}
                search={{ page: pageId }}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg max-md:min-h-11"
              >
                Capture here
              </Link>
            )}
            <LifecycleMenu page={page} spaces={spaces} controls={controls} onChanged={changed} />
          </>
        }
      />
      <article className="mx-auto flex w-full max-w-[660px] flex-col gap-4 pt-4">
        {/* The changed blocks wear their author's colour here, as in the sidebar's list; in
            "changes from this capture" mode the capture's blocks wear the Routing engine's instead. */}
        <style>{captureId ? captureHighlightCss(captureChanges ?? []) : blockHighlightCss(entries ?? [])}</style>
        <style>{suggestionMarkerCss(openSuggestions)}</style>
        <PageHeader
          page={page}
          canEdit={controls.move}
          meta={
            <div className="flex flex-wrap items-center gap-2">
              <PageStatus
                page={page}
                changedCount={visibleChanges(entries ?? []).length}
                controls={controls}
                canReview={canReview}
                tenantSlug={tenant.slug}
                onChanged={changed}
                onHistory={(tab) => openHistory(pageId, tab)}
              />
              {archived && <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-muted">Archived</span>}
              {openSuggestions.length > 0 && (
                <button
                  type="button"
                  aria-expanded={showSuggestions}
                  onClick={() => setShowSuggestions((v) => !v)}
                  className="rounded-full border border-dashed border-[var(--routing)] bg-[var(--routing-tint)] px-2 py-0.5 text-xs font-medium text-fg max-md:min-h-11"
                >
                  {openSuggestions.length} {openSuggestions.length === 1 ? 'suggestion' : 'suggestions'}
                </button>
              )}
            </div>
          }
        />
        {captureId && <CaptureBanner pageId={pageId} captureId={captureId} changes={captureChanges ?? []} />}
        {showSuggestions && openSuggestions.length > 0 && <SuggestionsPanel pageId={pageId} suggestions={openSuggestions} />}
        {/* A failed refetch keeps the last page on screen and says so. */}
        <ErrorNote error={error} />
        <Editor
          key={pageId}
          live={livePage.live}
          access={livePage.access}
          archived={archived}
          error={livePage.error}
          retry={livePage.retry}
          place={{ pageId, spaceId: page.spaceId }}
          sources={connections ? blockSourcesOf(connections) : []}
        />
        <PageConnections pageId={pageId} />
        {historyOpen && (
          <HistoryDrawer
            pageId={pageId}
            canRestore={controls.restoreVersion}
            initialTab={historyTab ?? 'versions'}
            onClose={closeHistory}
            onRestored={changed}
          />
        )}
      </article>
    </>
  );
}
