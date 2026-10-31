import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Grant, Group, Member, SpaceRole } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { grantRoleChoices, isUuid } from '../lib/console.js';
import { useGrants, useGroups, useMembers, useRefresh } from '../lib/queries.js';
import { ROLE_LABEL, ROLE_SUMMARY, SPACE_ROLES } from '../lib/roles.js';
import { CloseIcon } from './icons.js';
import { Avatar, Button, ErrorNote, Loading, SelectField, TextField } from './ui.js';
import { PrincipalCombobox, type PrincipalOption } from './PrincipalCombobox.js';

const roleOptions = (type: Grant['principalType']) =>
  grantRoleChoices(type).map((r) => ({ value: r, label: ROLE_LABEL[r] }));

const ROLE_SELECT =
  'h-8 rounded-md border border-transparent bg-transparent px-2 text-sm text-fg hover:border-line hover:bg-page focus:border-line focus:bg-page disabled:opacity-60 max-md:h-11';

/** Strongest role first, then by name: who can do the most is read first. */
function byRole(a: Grant, b: Grant) {
  const rank = SPACE_ROLES.indexOf(b.role) - SPACE_ROLES.indexOf(a.role);
  return rank !== 0 ? rank : (a.principalName || '').localeCompare(b.principalName || '');
}

function grantDetail(grant: Grant, members: readonly Member[], groups: readonly Group[]): string {
  if (grant.principalType === 'user') return members.find((m) => m.userId === grant.principalId)?.email ?? 'Person';
  if (grant.principalType === 'group') {
    const count = groups.find((g) => g.id === grant.principalId)?.memberCount;
    return count === undefined ? 'Group' : `Group · ${count} ${count === 1 ? 'member' : 'members'}`;
  }
  return 'Agent · can read or edit, never approve';
}

function GrantRow({ spaceId, grant, detail }: { spaceId: string; grant: Grant; detail: string }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
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
    <li className="flex flex-col gap-2 py-2.5">
      <div className="flex items-center gap-3">
        <Avatar name={name} id={grant.principalId} kind={grant.principalType} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{name}</p>
          <p className="truncate text-xs text-muted">{detail}</p>
        </div>
        <select
          aria-label={`Role of ${name}`}
          value={grant.role}
          disabled={change.isPending}
          onChange={(e) => change.mutate(e.target.value as SpaceRole)}
          className={ROLE_SELECT}
        >
          {roleOptions(grant.principalType).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={`Remove ${name}`}
          aria-expanded={confirming}
          onClick={() => setConfirming(!confirming)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-danger max-md:size-11"
        >
          <CloseIcon />
        </button>
      </div>
      {confirming && (
        <div className="ml-11 flex flex-wrap items-center gap-2 rounded-md bg-danger-bg px-3 py-2">
          <p className="flex-1 text-xs text-danger">Remove {name}’s access to this space?</p>
          <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove access
          </Button>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}
      <div className="ml-11 empty:hidden">
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
  const [agentMode, setAgentMode] = useState(false);
  const [picked, setPicked] = useState<PrincipalOption | null>(null);
  const [agentId, setAgentId] = useState('');
  const [role, setRole] = useState<SpaceRole>('viewer');

  const type = agentMode ? 'agent' : (picked?.type ?? 'user');
  const principalId = agentMode ? agentId : (picked?.id ?? '');
  const choices = grantRoleChoices(type);
  const effectiveRole = choices.includes(role) ? role : 'viewer';
  const ready = agentMode ? isUuid(agentId) : picked !== null;
  const granted = new Set((grants ?? []).map((g) => `${g.principalType}:${g.principalId}`));
  const candidates: PrincipalOption[] = [
    ...members
      .filter((m) => !granted.has(`user:${m.userId}`))
      .map((m) => ({ type: 'user' as const, id: m.userId, name: m.name, detail: m.email })),
    ...groups
      .filter((g) => !granted.has(`group:${g.id}`))
      .map((g) => ({
        type: 'group' as const,
        id: g.id,
        name: g.name,
        detail: `${g.memberCount} ${g.memberCount === 1 ? 'member' : 'members'}`,
      })),
  ];

  const add = useMutation({
    mutationFn: () => api.upsertGrant(spaceId, { principal_type: type, principal_id: principalId, role: effectiveRole }),
    onSuccess: () => {
      setPicked(null);
      setAgentId('');
      return refresh('grants', spaceId);
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3 rounded-lg border border-line bg-sidebar p-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium text-fg">Add access</h4>
          <button
            type="button"
            onClick={() => {
              setAgentMode(!agentMode);
              setPicked(null);
              setAgentId('');
            }}
            className="text-xs font-medium text-accent-text hover:underline"
          >
            {agentMode ? 'Add a person or group instead' : 'Add an agent by id'}
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            {agentMode ? (
              <TextField
                label="Agent id"
                value={agentId}
                onChange={(id) => setAgentId(id.trim())}
                pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                required
              />
            ) : (
              <PrincipalCombobox
                label="Person or group"
                options={candidates}
                value={picked}
                onChange={setPicked}
                emptyText="Every member and group already has access."
              />
            )}
          </div>
          <div className="w-32">
            <SelectField label="Role" value={effectiveRole} options={roleOptions(type)} onChange={setRole} />
          </div>
          <Button type="submit" disabled={!ready || add.isPending}>
            Grant access
          </Button>
        </div>
        <p className="text-xs text-muted">
          <span className="font-medium text-fg">{ROLE_LABEL[effectiveRole]}:</span> {ROLE_SUMMARY[effectiveRole]}
        </p>
        <ErrorNote error={add.error} />
      </form>

      {isPending && <Loading what="grants" />}
      <ErrorNote error={error} />
      <ul aria-label="People with access" className="flex flex-col divide-y divide-line">
        <li className="flex items-center gap-3 py-2.5">
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[11px] font-semibold text-accent-text">
            WS
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">Workspace owners and admins</p>
            <p className="text-xs text-muted">Always have full access</p>
          </div>
          <span className="px-2 text-sm text-muted">Admin</span>
          <span className="size-8 shrink-0 max-md:size-11" />
        </li>
        {grants
          ?.slice()
          .sort(byRole)
          .map((g) => (
            <GrantRow
              key={`${g.principalType}:${g.principalId}`}
              spaceId={spaceId}
              grant={g}
              detail={grantDetail(g, members, groups)}
            />
          ))}
      </ul>
      {grants && grants.length === 0 && (
        <p className="text-sm text-muted">No one else has access yet. Add people, groups or agents above.</p>
      )}
    </div>
  );
}
