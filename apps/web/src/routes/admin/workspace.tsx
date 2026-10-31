import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { api } from '../../lib/api.js';
import { queryClient } from '../../lib/queryClient.js';
import { useWorkspace } from '../../lib/queries.js';
import { Button, Card, ErrorNote, TextField } from '../../components/ui.js';

/** Settings -> Workspace (owners only): delete the workspace, after typing its name. */
export function WorkspaceSettingsPage() {
  const { tenant, role } = useWorkspace();
  const router = useRouter();
  const [confirmName, setConfirmName] = useState('');
  // A workspace the demo content went into can be reset; it is also the one that is purged on delete.
  const demo = useQuery({
    queryKey: ['t', tenant.id, 'demo-seed'],
    queryFn: () => api.demoSeedStatus(),
    enabled: role === 'owner',
    staleTime: 0,
  });
  const isDemo = demo.data?.canReset === true;
  const remove = useMutation({
    mutationFn: () => api.deleteWorkspace(),
    onSuccess: async () => {
      // Everything cached belonged to this workspace; `/` opens another workspace or the create screen.
      queryClient.clear();
      await router.navigate({ to: '/' });
    },
  });

  if (role !== 'owner') {
    return (
      <Card title="Delete workspace">
        <p className="text-sm text-muted">Only an owner can delete this workspace.</p>
      </Card>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (confirmName.trim() === tenant.name) remove.mutate();
  }

  return (
    <Card title="Delete workspace">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="text-sm text-muted">
          {isDemo
            ? `${tenant.name} holds the demo content. Deleting it removes it for good, at once: every page, file and comment, and the three demo colleagues.`
            : `${tenant.name} disappears for every member at once: nobody can open its spaces, pages or files any more, and pending invitations stop working.`}{' '}
          Members keep their accounts and their other workspaces.
        </p>
        <TextField label={`Type ${tenant.name} to confirm`} value={confirmName} onChange={setConfirmName} required />
        <ErrorNote error={remove.error} />
        <div>
          <Button type="submit" variant="danger" disabled={remove.isPending || confirmName.trim() !== tenant.name}>
            Delete workspace
          </Button>
        </div>
      </form>
    </Card>
  );
}
