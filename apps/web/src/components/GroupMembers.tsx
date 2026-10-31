import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Group, GroupMember } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { isUuid } from '../lib/console.js';
import { useGroupMembers, useMembers, useRefresh } from '../lib/queries.js';
import { Avatar, Button, ErrorNote, Loading, TextField } from './ui.js';
import { PrincipalCombobox, type PrincipalOption } from './PrincipalCombobox.js';

/** Who is in a group, each with a way out, and a picker to add a person or agent who isn't in it yet. */
export function GroupMembers({ group }: { group: Group }) {
  const refresh = useRefresh();
  const { data: people = [] } = useMembers();
  const { data: inGroup, error, isPending } = useGroupMembers(group.id);
  const [agentMode, setAgentMode] = useState(false);
  const [picked, setPicked] = useState<PrincipalOption | null>(null);
  const [agentId, setAgentId] = useState('');
  const already = new Set((inGroup ?? []).map((m) => m.principalId));
  const principal = agentMode ? { type: 'agent' as const, id: agentId } : { type: 'user' as const, id: picked?.id ?? '' };
  const ready = agentMode ? isUuid(agentId) : picked !== null;
  const candidates: PrincipalOption[] = people
    .filter((p) => !already.has(p.userId))
    .map((p) => ({ type: 'user', id: p.userId, name: p.name, detail: p.email }));

  const add = useMutation({
    mutationFn: () =>
      api.addGroupMember(group.id, { principal_type: principal.type, principal_id: principal.id }),
    onSuccess: () => {
      setPicked(null);
      setAgentId('');
      return refresh('groups');
    },
  });
  const remove = useMutation({
    mutationFn: (m: GroupMember) => api.removeGroupMember(group.id, m.principalType, m.principalId),
    onSuccess: () => refresh('groups'),
  });

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md bg-sidebar p-3">
      {isPending ? (
        <Loading what="members" />
      ) : inGroup && inGroup.length > 0 ? (
        <ul aria-label={`Members of ${group.name}`} className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
          {inGroup.map((m) => (
            <li key={`${m.principalType}:${m.principalId}`} className="flex items-center gap-3 px-3 py-2">
              <Avatar name={m.name} id={m.principalId} kind={m.principalType === 'agent' ? 'agent' : 'user'} />
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{m.name}</span>
              {m.principalType === 'agent' && <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">Agent</span>}
              <button
                type="button"
                aria-label={`Remove ${m.name} from ${group.name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(m)}
                className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-danger max-md:min-h-11"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No one in this group yet.</p>
      )}
      <ErrorNote error={error} />
      <div className="flex flex-col gap-3 border-t border-line pt-3">
        {agentMode ? (
          <TextField label="Agent id" value={agentId} onChange={(id) => setAgentId(id.trim())} required />
        ) : (
          <PrincipalCombobox
            label="Person"
            placeholder="Search members by name or email…"
            options={candidates}
            value={picked}
            onChange={setPicked}
            emptyText="Every member is already in this group."
          />
        )}
        <div>
          <Button onClick={() => add.mutate()} disabled={!ready || add.isPending || already.has(principal.id)}>
            Add to group
          </Button>
          <button
            type="button"
            onClick={() => {
              setAgentMode(!agentMode);
              setPicked(null);
              setAgentId('');
            }}
            className="ml-3 text-xs font-medium text-accent-text hover:underline"
          >
            {agentMode ? 'Add a person instead' : 'Add an agent by id'}
          </button>
        </div>
      </div>
      <ErrorNote error={add.error ?? remove.error} />
    </div>
  );
}
