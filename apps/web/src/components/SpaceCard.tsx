import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { SpaceResponse } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { Link } from '@tanstack/react-router';
import { useGrants, useRefresh, useWorkspace } from '../lib/queries.js';
import { Avatar, Button, Checkbox, ErrorNote, TextField } from './ui.js';
import { SpaceGrants } from './SpaceGrants.js';

/** One space in the admin list: rename, review settings, archive, and its grants. */
export function SpaceCard({ space }: { space: SpaceResponse }) {
  const refresh = useRefresh();
  const { tenant } = useWorkspace();
  const { data: grants } = useGrants(space.id);
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
    <section aria-label={`Settings for ${space.name}`} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-fg">{space.name}</h2>
          {space.kind === 'inbox' && <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-fg">Personal</span>}
          {space.reviewRequired && space.kind !== 'inbox' && (
            <span className="rounded-full bg-warn-bg px-2 py-0.5 text-xs text-warn-text">Review required</span>
          )}
          {archived && <span className="rounded-full bg-hover px-2 py-0.5 text-xs text-fg">Archived</span>}
        </div>
        <p className="text-xs text-muted">URL slug /{space.slug}</p>
      </div>
      {!archived && (
        <>
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
              Save changes
            </Button>
          </form>

          <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
            <legend className="mb-1 float-left w-full text-sm font-semibold text-fg">Review</legend>
            <Checkbox
              label="Changes need review"
              hint="Edits stay out of search until a reviewer approves them."
              checked={space.reviewRequired}
              disabled={update.isPending}
              onChange={(review_required) => update.mutate({ review_required })}
            />
            <Checkbox
              label="Reviewers may approve their own changes"
              hint="Off means a second person must approve."
              checked={space.allowSelfApproval}
              disabled={update.isPending}
              onChange={(allow_self_approval) => update.mutate({ allow_self_approval })}
            />
          </fieldset>

          {/* The Inbox is personal: every member has one, and its items are private to their creator. */}
          {space.kind !== 'inbox' && (
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-sm font-semibold text-fg">Access</h3>
                  <p className="text-xs text-muted">
                    {grants === undefined
                      ? 'Who can read, write and review here.'
                      : grants.length === 0
                        ? 'Only workspace owners and admins so far.'
                        : `${grants.length} ${grants.length === 1 ? 'grant' : 'grants'}, plus workspace owners and admins.`}{' '}
                    <Link
                      to="/w/$tenantSlug/admin/roles"
                      params={{ tenantSlug: tenant.slug }}
                      className="font-medium text-accent-text hover:underline"
                    >
                      What can each role do?
                    </Link>
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {!showGrants && grants && grants.length > 0 && (
                    <span aria-hidden="true" className="flex -space-x-2">
                      {grants.slice(0, 4).map((g) => (
                        <span key={`${g.principalType}:${g.principalId}`} className="rounded-full ring-2 ring-surface">
                          <Avatar name={g.principalName} id={g.principalId} kind={g.principalType} />
                        </span>
                      ))}
                    </span>
                  )}
                  <Button variant="secondary" aria-expanded={showGrants} onClick={() => setShowGrants(!showGrants)}>
                    {showGrants ? 'Hide access' : 'Manage access'}
                  </Button>
                </div>
              </div>
              {showGrants && <SpaceGrants spaceId={space.id} />}
            </div>
          )}

          {space.kind !== 'inbox' && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <div>
                <h3 className="text-sm font-semibold text-fg">Archive this space</h3>
                <p className="text-xs text-muted">Hides it from everyone but workspace admins.</p>
              </div>
              {confirmArchive ? (
                <div className="flex gap-2">
                  <Button variant="danger" onClick={() => archive.mutate()} disabled={archive.isPending}>
                    Confirm archive
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="danger" onClick={() => setConfirmArchive(true)}>
                  Archive
                </Button>
              )}
            </div>
          )}
          <ErrorNote error={update.error ?? archive.error} />
        </>
      )}
    </section>
  );
}
