import { useEffect, useRef } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { PageDetails } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { usePage, useRefresh, useSpaces, useWorkspace } from '../lib/queries.js';
import { pageControls } from '../lib/wiki.js';
import { Badge } from '../components/Badge.js';
import { ChangesPanel } from '../components/ChangesPanel.js';
import { Editor } from '../components/Editor.js';
import { LifecycleMenu } from '../components/LifecycleMenu.js';
import { Button, ErrorNote, Loading } from '../components/ui.js';

/** Snapshot, retry and restore-indexed: each calls its route, then the page (and so the badge) is fetched again. */
function PageActions({
  page,
  controls,
  onChanged,
}: {
  page: PageDetails;
  controls: ReturnType<typeof pageControls>;
  onChanged: () => void;
}) {
  const snapshot = useMutation({ mutationFn: () => api.snapshot(page.id), onSettled: onChanged });
  const retry = useMutation({ mutationFn: (versionId: string) => api.retryVersion(versionId), onSettled: onChanged });
  const restoreIndexed = useMutation({
    mutationFn: (n: number) => api.restoreVersion(page.id, n),
    onSettled: onChanged,
  });
  const busy = snapshot.isPending || retry.isPending || restoreIndexed.isPending;
  // Retry targets the version that failed: the page's latest one (the badge says "Index failed" only for it).
  const failed = page.latestVersion;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {controls.primary && (
          <Button onClick={() => snapshot.mutate()} disabled={busy}>
            {controls.primary}
          </Button>
        )}
        {controls.retry && failed && (
          <Button variant="secondary" onClick={() => retry.mutate(failed.id)} disabled={busy}>
            Retry
          </Button>
        )}
        {controls.restoreIndexed && page.indexedVersion && (
          <Button variant="secondary" onClick={() => restoreIndexed.mutate(page.indexedVersion!.number)} disabled={busy}>
            Restore indexed version
          </Button>
        )}
      </div>
      <ErrorNote error={snapshot.error ?? retry.error ?? restoreIndexed.error} />
    </div>
  );
}

/** `/w/$tenantSlug/p/$pageId`: the live editor with the page's badge, actions and changes. */
export function PagePage() {
  const { tenant } = useWorkspace();
  const { pageId } = useParams({ from: '/w/$tenantSlug/p/$pageId' });
  const refresh = useRefresh();
  const { data: page, error, isPending } = usePage(pageId);
  const { data: spaces = [] } = useSpaces();

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

  if (!page) return isPending ? <Loading what="page" /> : <ErrorNote error={error} />;

  const space = spaces.find((s) => s.id === page.spaceId);
  const archived = page.archivedAt !== null || (space?.archivedAt ?? null) !== null;
  const controls = pageControls({
    badge: page.badge,
    role: space?.myRole ?? null,
    reviewRequired: space?.reviewRequired ?? false,
    archived,
  });
  // The page and everything keyed under it (its changes).
  const reload = () => void refresh('page', pageId);
  // After an action: also the trees the page appears in.
  const changed = () => {
    reload();
    void refresh('tree');
    void refresh('archived');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          {space && (
            <Link
              to="/w/$tenantSlug/s/$spaceSlug"
              params={{ tenantSlug: tenant.slug, spaceSlug: space.slug }}
              className="text-sm text-indigo-700 hover:underline"
            >
              {space.name}
            </Link>
          )}
          <h1 className="text-xl font-semibold">{page.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge badge={page.badge} />
            {archived && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Archived</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <PageActions page={page} controls={controls} onChanged={changed} />
          <LifecycleMenu page={page} spaces={spaces} controls={controls} onChanged={changed} />
        </div>
      </div>
      {/* A failed refetch keeps the last page on screen and says so. */}
      <ErrorNote error={error} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Editor key={pageId} pageId={pageId} archived={archived} onSynced={reload} />
        <ChangesPanel pageId={pageId} />
      </div>
    </div>
  );
}
