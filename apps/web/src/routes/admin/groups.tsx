import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Group } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { useGroups, useRefresh } from '../../lib/queries.js';
import { GroupMembers } from '../../components/GroupMembers.js';
import { ChevronDownIcon, ChevronRightIcon } from '../../components/icons.js';
import { Avatar, Button, EmptyState, ErrorNote, Loading, TextField } from '../../components/ui.js';

function GroupRow({ group }: { group: Group }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line py-3 last:border-0">
      <div className="flex items-center gap-3">
        <Avatar name={group.name} id={group.id} kind="group" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{group.name}</p>
          <p className="text-xs text-muted">
            {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
          </p>
        </div>
        <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex items-center gap-1">
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {open ? 'Close' : 'Manage members'}
        </Button>
      </div>
      {open && <GroupMembers group={group} />}
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
          {groups && groups.length === 0 && (
            <EmptyState title="No groups yet">Groups let you give a whole team access to a space at once.</EmptyState>
          )}
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
