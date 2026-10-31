import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useRefresh, useWorkspace } from '../lib/queries.js';
import { Button, Card, ErrorNote } from './ui.js';

/**
 * Settings -> Spaces: the Northwind Studio demo (three spaces, a roadmap, two files, three colleagues). An empty
 * workspace can have it added; a workspace it was added to can be reset back to it, which throws away everything
 * written there since. The server refuses anything else; the card only shows when one of the two is possible or
 * under way.
 */
export function DemoSeedCard() {
  const { tenant } = useWorkspace();
  const refresh = useRefresh();
  const [confirmReset, setConfirmReset] = useState(false);
  const status = useQuery({
    queryKey: ['t', tenant.id, 'demo-seed'],
    queryFn: () => api.demoSeedStatus(),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 3000 : false),
    staleTime: 0,
  });
  const start = useMutation({
    mutationFn: () => api.startDemoSeed(),
    onSuccess: () => status.refetch(),
  });
  const reset = useMutation({
    mutationFn: () => api.resetDemoSeed(),
    onSuccess: () => status.refetch(),
    onSettled: () => setConfirmReset(false),
  });
  const state = status.data?.state;

  useEffect(() => {
    // Spaces, pages and members change while it runs; look again when it ends.
    if (state === 'done') {
      void refresh('spaces');
      void refresh('members');
    }
  }, [state]);

  if (!status.data) return null;
  const { canSeed, canReset, error } = status.data;
  const running = state === 'running';
  if (!running && !canSeed && !canReset) return null;

  if (running) {
    return (
      <Card title="Demo content">
        <p className="text-sm text-muted">
          Putting Northwind Studio in place. It takes a minute or two while Kinote reads the pages; you can leave this
          page.
        </p>
      </Card>
    );
  }

  if (canSeed) {
    return (
      <Card title="Try it with demo content">
        <p className="mb-3 text-sm text-muted">
          This workspace is empty. Add Northwind Studio, a small design studio with client pages, a roadmap, a handbook
          and two files, written by three colleagues. It takes a minute or two while Kinote reads the pages.
        </p>
        <ErrorNote error={start.error} />
        {state === 'failed' && <p role="alert" className="mb-3 text-sm text-danger">It did not finish: {error}</p>}
        <Button onClick={() => start.mutate()} disabled={start.isPending}>
          Seed demo workspace
        </Button>
      </Card>
    );
  }

  return (
    <Card title="Demo workspace">
      <p className="mb-3 text-sm text-muted">
        {state === 'done'
          ? 'Northwind Studio is in this workspace: open Home to look around.'
          : 'This workspace holds the Northwind Studio demo.'}{' '}
        Reset it to put the demo back as it started: every page, file, comment and change made here since is deleted,
        for everyone. Members stay.
      </p>
      <ErrorNote error={reset.error} />
      {state === 'failed' && <p role="alert" className="mb-3 text-sm text-danger">It did not finish: {error}</p>}
      <div className="flex flex-wrap gap-2">
        {confirmReset ? (
          <>
            <Button variant="danger" onClick={() => reset.mutate()} disabled={reset.isPending}>
              Delete everything and reset
            </Button>
            <Button variant="secondary" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirmReset(true)}>
            Reset demo content
          </Button>
        )}
      </div>
    </Card>
  );
}
