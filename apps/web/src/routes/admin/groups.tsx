import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Group } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { useGroups, useRefresh } from '../../lib/queries.js';
import { GroupMembers } from '../../components/GroupMembers.js';
import { Button, ErrorNote, Loading, TextField } from '../../components/ui.js';

function GroupRow({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line py-3 last:border-0">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-sm font-medium text-fg">{group.name}</p>
        <p className="text-xs text-muted">
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <TextField label="New group name" value={name} onChange={setName} required />
        </div>
        <Button type="submit" disabled={create.isPending || name.trim() === ''}>
          Create group
        </Button>
      </form>
      <ErrorNote error={create.error} />
      {isPending ? (
        <Loading what="groups" />
      ) : (
        <>
          <p className="text-sm text-muted">
            {groups?.length ?? 0} {groups?.length === 1 ? 'group' : 'groups'}
          </p>
          <ErrorNote error={error} />
          {groups && groups.length === 0 && <p className="text-sm text-muted">No groups yet.</p>}
          {groups && groups.length > 0 && (
            <ul aria-label="Groups" className="flex flex-col">
              {groups.map((group) => (
                <GroupRow key={group.id} group={group} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
