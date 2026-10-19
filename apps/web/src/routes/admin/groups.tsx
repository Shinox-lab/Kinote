import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Group } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { useGroups, useRefresh } from '../../lib/queries.js';
import { Button, Card, ErrorNote, Loading, TextField } from '../../components/ui.js';
import { GroupMembers } from '../../components/GroupMembers.js';

function GroupRow({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm font-medium">{group.name}</p>
        <p className="text-sm text-muted">
          {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
        </p>
        <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Manage members'}
        </Button>
      </div>
      {open && <GroupMembers groupId={group.id} />}
    </li>
  );
}

/** `/w/$tenantSlug/admin/groups`: create groups and manage who is in them. */
export function GroupsPage() {
  const refresh = useRefresh();
  const { data: groups, error, isPending } = useGroups();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => api.createGroup({ name }),
    onSuccess: () => {
      setName('');
      return refresh('groups');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <div className="flex flex-col gap-5">
      <Card title="Create a group">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <TextField label="Group name" value={name} onChange={setName} required />
          </div>
          <Button type="submit" disabled={create.isPending}>
            Create group
          </Button>
        </form>
        <div className="mt-3">
          <ErrorNote error={create.error} />
        </div>
      </Card>
      <Card title="Groups">
        {isPending && <Loading what="groups" />}
        <ErrorNote error={error} />
        {groups && groups.length === 0 && <p className="text-sm text-muted">No groups yet.</p>}
        {groups && (
          <ul className="divide-y divide-line">
            {groups.map((g) => (
              <GroupRow key={g.id} group={g} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
