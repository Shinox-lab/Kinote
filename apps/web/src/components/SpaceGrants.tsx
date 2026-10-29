import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Grant, SpaceRole } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { grantRoleChoices, isUuid } from '../lib/console.js';
import { useGrants, useGroups, useMembers, useRefresh } from '../lib/queries.js';
import { Button, ErrorNote, Loading, SelectField } from './ui.js';
import { PrincipalPicker, type Principal } from './PrincipalPicker.js';

const roleOptions = (type: Grant['principalType']) =>
  grantRoleChoices(type).map((r) => ({ value: r, label: r }));

function GrantRow({ spaceId, grant }: { spaceId: string; grant: Grant }) {
  const refresh = useRefresh();
  const change = useMutation({
    mutationFn: (role: SpaceRole) =>
      api.upsertGrant(spaceId, { principal_type: grant.principalType, principal_id: grant.principalId, role }),
    onSettled: () => refresh('grants', spaceId),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteGrant(spaceId, grant.principalType, grant.principalId),
    onSettled: () => refresh('grants', spaceId),
  });
  const name = grant.principalName || `Unknown ${grant.principalType}`;

  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <p className="min-w-40 flex-1 text-sm">
        {name} <span className="text-xs text-muted">({grant.principalType})</span>
      </p>
      <div className="w-36">
        <SelectField
          compact
          label={`Role of ${name}`}
          value={grant.role}
          options={roleOptions(grant.principalType)}
          disabled={change.isPending}
          onChange={(role) => change.mutate(role)}
        />
      </div>
      <Button variant="secondary" onClick={() => remove.mutate()} disabled={remove.isPending}>
        Remove
      </Button>
      <div className="w-full empty:hidden">
        <ErrorNote error={change.error ?? remove.error} />
      </div>
    </li>
  );
}

/** Who may do what in one space: grants for people, groups and agents (space admins only; the server checks). */
export function SpaceGrants({ spaceId }: { spaceId: string }) {
  const refresh = useRefresh();
  const { data: grants, error, isPending } = useGrants(spaceId);
  const { data: members = [] } = useMembers();
  const { data: groups = [] } = useGroups();
  const [principal, setPrincipal] = useState<Principal>({ type: 'user', id: '' });
  const [role, setRole] = useState<SpaceRole>('viewer');

  const choices = grantRoleChoices(principal.type);
  const effectiveRole = choices.includes(role) ? role : 'viewer';
  const ready = principal.type === 'agent' ? isUuid(principal.id) : principal.id !== '';

  const add = useMutation({
    mutationFn: () =>
      api.upsertGrant(spaceId, { principal_type: principal.type, principal_id: principal.id, role: effectiveRole }),
    onSuccess: () => {
      setPrincipal({ type: principal.type, id: '' });
      return refresh('grants', spaceId);
    },
  });

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md bg-sidebar p-3">
      {isPending && <Loading what="grants" />}
      <ErrorNote error={error} />
      {grants && grants.length === 0 && <p className="text-sm text-muted">No grants yet.</p>}
      {grants && (
        <ul className="divide-y divide-line">
          {grants.map((g) => (
            <GrantRow key={`${g.principalType}:${g.principalId}`} spaceId={spaceId} grant={g} />
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-3 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <PrincipalPicker
          types={['user', 'group', 'agent']}
          value={principal}
          onChange={setPrincipal}
          members={members}
          groups={groups}
        />
        <div className="flex items-end gap-3">
          <div className="w-40">
            <SelectField label="Role" value={effectiveRole} options={roleOptions(principal.type)} onChange={setRole} />
          </div>
          <Button type="submit" disabled={!ready || add.isPending}>
            Grant access
          </Button>
        </div>
        <ErrorNote error={add.error} />
      </form>
    </div>
  );
}
