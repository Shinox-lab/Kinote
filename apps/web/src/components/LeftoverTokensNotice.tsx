import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { SourceToken } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { useRefresh, useSources } from '../lib/queries.js';
import { tokensOfPeopleWhoLeft } from '../lib/sources.js';
import { Button, ErrorNote } from './ui.js';

/**
 * Source tokens keep working after the person who made them leaves or is
 * removed. This lists, per such person, the tokens still working, and revokes
 * them in one go. Renders nothing when there are none (admins only: it reads
 * the sources list).
 */
export function LeftoverTokensNotice() {
  const { data: sources } = useSources();
  if (!sources) return null;
  const groups = tokensOfPeopleWhoLeft(sources, new Date());
  if (groups.length === 0) return null;
  return (
    <section aria-label="Source tokens of people who left" className="flex flex-col gap-2">
      {groups.map((group) => (
        <LeftoverGroup key={group.creator.id} creator={group.creator} sourceNames={[...new Set(group.tokens.map((t) => t.source.name))]} count={group.tokens.length} />
      ))}
    </section>
  );
}

function LeftoverGroup({ creator, sourceNames, count }: { creator: SourceToken['createdBy']; sourceNames: string[]; count: number }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.revokeTokensMadeBy(creator.id),
    onSuccess: () => refresh('sources'),
  });
  const tokens = count === 1 ? '1 source token' : `${count} source tokens`;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn-text">
      <p>
        <strong>{creator.name}</strong> is no longer in this workspace, but {tokens} they made still{' '}
        {count === 1 ? 'works' : 'work'} ({sourceNames.join(', ')}). Scripts using {count === 1 ? 'it' : 'them'} can keep
        sending files until {count === 1 ? 'it is' : 'they are'} revoked.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button variant="danger" onClick={() => revoke.mutate()} disabled={revoke.isPending} aria-label={`Confirm revoking the tokens ${creator.name} made`}>
              {revoke.isPending ? 'Revoking…' : `Revoke ${count === 1 ? 'it' : `all ${count}`}`}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)} aria-label={`Revoke the tokens ${creator.name} made`}>
            Revoke…
          </Button>
        )}
      </div>
      <ErrorNote error={revoke.error} />
    </div>
  );
}
