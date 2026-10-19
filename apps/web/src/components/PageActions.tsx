import { useMutation } from '@tanstack/react-query';
import type { PageDetails } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import type { PageControls } from '../lib/wiki.js';
import { Button, ErrorNote } from './ui.js';

/**
 * Snapshot, retry and restore-indexed: each calls its route, then `onChanged`
 * runs so the page (and so the badge) is fetched again. `stacked` puts the
 * buttons one per row, for the sidebar.
 */
export function PageActions({
  page,
  controls,
  onChanged,
  stacked = false,
}: {
  page: PageDetails;
  controls: PageControls;
  onChanged: () => void;
  stacked?: boolean;
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
  const width = stacked ? 'w-full' : '';

  if (!controls.primary && !(controls.retry && failed) && !(controls.restoreIndexed && page.indexedVersion)) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className={`flex gap-2 ${stacked ? 'flex-col' : 'flex-wrap items-center'}`}>
        {controls.primary && (
          <Button className={width} onClick={() => snapshot.mutate()} disabled={busy}>
            {controls.primary}
          </Button>
        )}
        {controls.retry && failed && (
          <Button className={width} variant="secondary" onClick={() => retry.mutate(failed.id)} disabled={busy}>
            Retry
          </Button>
        )}
        {controls.restoreIndexed && page.indexedVersion && (
          <Button
            className={width}
            variant="secondary"
            onClick={() => restoreIndexed.mutate(page.indexedVersion!.number)}
            disabled={busy}
          >
            Restore indexed version
          </Button>
        )}
      </div>
      <ErrorNote error={snapshot.error ?? retry.error ?? restoreIndexed.error} />
    </div>
  );
}
