import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { SpaceResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { useRefresh } from '../lib/queries.js';
import { Button, Checkbox, ErrorNote, TextField } from './ui.js';
import { SpaceGrants } from './SpaceGrants.js';

/** One space in the admin list: rename, review settings, archive, and its grants. */
export function SpaceCard({ space }: { space: SpaceResponse }) {
  const refresh = useRefresh();
  const [name, setName] = useState(space.name);
  const [showGrants, setShowGrants] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = space.archivedAt !== null;

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateSpace>[1]) => api.updateSpace(space.id, patch),
    onSettled: () => refresh('spaces'),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveSpace(space.id),
    onSettled: () => {
      setConfirmArchive(false);
      return refresh('spaces');
    },
  });

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{space.name}</h3>
        <span className="text-xs text-muted">/{space.slug}</span>
        {space.kind === 'inbox' && <span className="rounded bg-hover px-1.5 text-xs">Inbox</span>}
        {archived && <span className="rounded bg-dot-review/15 px-1.5 text-xs text-fg">Archived</span>}
      </div>
      {!archived && (
        <div className="mt-3 flex flex-col gap-3">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ name });
            }}
          >
            <div className="min-w-56 flex-1">
              <TextField label="Name" value={name} onChange={setName} required />
            </div>
            <Button type="submit" variant="secondary" disabled={update.isPending || name.trim() === space.name}>
              Rename
            </Button>
          </form>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Checkbox
              label="Changes need review"
              checked={space.reviewRequired}
              disabled={update.isPending}
              onChange={(review_required) => update.mutate({ review_required })}
            />
            <Checkbox
              label="Reviewers may approve their own changes"
              checked={space.allowSelfApproval}
              disabled={update.isPending}
              onChange={(allow_self_approval) => update.mutate({ allow_self_approval })}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" aria-expanded={showGrants} onClick={() => setShowGrants(!showGrants)}>
              {showGrants ? 'Hide access' : 'Manage access'}
            </Button>
            {space.kind !== 'inbox' &&
              (confirmArchive ? (
                <>
                  <Button variant="danger" onClick={() => archive.mutate()} disabled={archive.isPending}>
                    Confirm archive
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="danger" onClick={() => setConfirmArchive(true)}>
                  Archive
                </Button>
              ))}
          </div>
          <ErrorNote error={update.error ?? archive.error} />
          {showGrants && <SpaceGrants spaceId={space.id} />}
        </div>
      )}
    </li>
  );
}
