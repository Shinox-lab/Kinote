import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Member, TenantRole } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { TENANT_ROLES, canChangeRole } from '../../lib/console.js';
import { useMembers, useRefresh, useWorkspace } from '../../lib/queries.js';
import { loadSession } from '../../lib/session.js';
import { Button, Card, ErrorNote, Loading, SelectField } from '../../components/ui.js';
import { InviteForm } from '../../components/InviteForm.js';

function MemberRow({ member, actorRole, isSelf }: { member: Member; actorRole: TenantRole; isSelf: boolean }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const locked = isSelf || !canChangeRole(actorRole, member.role);

  const changeRole = useMutation({
    mutationFn: (role: TenantRole) => api.changeMemberRole(member.userId, { role }),
    onSettled: () => refresh('members'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeMember(member.userId),
    onSettled: () => {
      setConfirming(false);
      return refresh('members');
    },
  });

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-48 flex-1">
        <p className="text-sm font-medium">
          {member.name}
          {isSelf && <span className="ml-2 text-xs text-slate-500">(you)</span>}
        </p>
        <p className="text-sm text-slate-600">{member.email}</p>
      </div>
      <div className="w-36">
        <SelectField
          compact
          label={`Role of ${member.name}`}
          value={member.role}
          disabled={locked || changeRole.isPending}
          options={TENANT_ROLES.map((r) => ({ value: r, label: r }))}
          onChange={(role) => changeRole.mutate(role)}
        />
      </div>
      {confirming ? (
        <div className="flex gap-2">
          <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Confirm remove
          </Button>
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)} disabled={locked}>
          Remove
        </Button>
      )}
      <div className="w-full empty:hidden">
        <ErrorNote error={changeRole.error ?? remove.error} />
      </div>
    </li>
  );
}

/** `/w/$tenantSlug/admin/members`: who is in the workspace, their roles, and invitations. */
export function MembersPage() {
  const { role } = useWorkspace();
  const refresh = useRefresh();
  const { data: members, error, isPending } = useMembers();
  const selfId = loadSession()?.user.id;

  return (
    <div className="flex flex-col gap-5">
      <InviteForm onInvited={() => void refresh('members')} />
      <Card title="Members">
        {isPending && <Loading what="members" />}
        <ErrorNote error={error} />
        {members && (
          <ul className="divide-y divide-slate-100">
            {members.map((m) => (
              <MemberRow key={m.userId} member={m} actorRole={role} isSelf={m.userId === selfId} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
