import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { isUuid } from '../lib/console.js';
import { useMembers, useRefresh } from '../lib/queries.js';
import { Button, ErrorNote } from './ui.js';
import { PrincipalPicker, type Principal } from './PrincipalPicker.js';

const NO_GROUPS: never[] = [];

/** Adds a person or agent to a group, or removes one. The API reports a group's size, not its members. */
export function GroupMembers({ groupId }: { groupId: string }) {
  const refresh = useRefresh();
  const { data: members = [] } = useMembers();
  const [principal, setPrincipal] = useState<Principal>({ type: 'user', id: '' });
  const [done, setDone] = useState<string | null>(null);
  const ready = principal.type === 'agent' ? isUuid(principal.id) : principal.id !== '';

  const settle = (message: string) => () => {
    setDone(message);
    setPrincipal({ type: principal.type, id: '' });
    return refresh('groups');
  };

  const add = useMutation({
    mutationFn: () =>
      api.addGroupMember(groupId, { principal_type: principal.type as 'user' | 'agent', principal_id: principal.id }),
    onSuccess: settle('Added.'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeGroupMember(groupId, principal.type, principal.id),
    onSuccess: settle('Removed.'),
  });

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md bg-sidebar p-3">
      <PrincipalPicker
        types={['user', 'agent']}
        value={principal}
        onChange={(next) => {
          setDone(null);
          setPrincipal(next);
        }}
        members={members}
        groups={NO_GROUPS}
      />
      <div className="flex items-center gap-2">
        <Button onClick={() => add.mutate()} disabled={!ready || add.isPending}>
          Add to group
        </Button>
        <Button variant="secondary" onClick={() => remove.mutate()} disabled={!ready || remove.isPending}>
          Remove from group
        </Button>
        {done && (
          <span role="status" className="text-sm text-muted">
            {done}
          </span>
        )}
      </div>
      <ErrorNote error={add.error ?? remove.error} />
    </div>
  );
}
