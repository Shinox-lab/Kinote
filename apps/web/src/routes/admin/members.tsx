import { useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Member, TenantRole } from '@living-wiki/contracts';
import { api } from '../../lib/api.js';
import { TENANT_ROLES, canChangeRole } from '../../lib/console.js';
import { useMembers, useRefresh, useWorkspace } from '../../lib/queries.js';
import { initials } from '../../lib/presence.js';
import { loadSession } from '../../lib/session.js';
import { authorColor } from '../../lib/wiki.js';
import { MoreIcon } from '../../components/icons.js';
import { InviteForm } from '../../components/InviteForm.js';
import { Button, ErrorNote, Loading } from '../../components/ui.js';

function MemberRow({ member, actorRole, isSelf }: { member: Member; actorRole: TenantRole; isSelf: boolean }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const locked = isSelf || !canChangeRole(actorRole, member.role);
  const color = authorColor(member.userId);
  const rowId = useId();
  const more = useRef<HTMLButtonElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuWrap.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu(false);
      more.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const changeRole = useMutation({
    mutationFn: (role: TenantRole) => api.changeMemberRole(member.userId, { role }),
    onSettled: () => refresh('members'),
  });
  const remove = useMutation({
    mutationFn: () => api.removeMember(member.userId),
    onSettled: () => {
      setConfirming(false);
      setMenu(false);
      return refresh('members');
    },
  });

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
        style={{ backgroundColor: color.tint, color: color.accent }}
      >
        {initials(member.name)}
      </span>
      <div className="min-w-44 flex-1">
        <p className="text-sm font-medium text-fg">
          {member.name}
          {isSelf && <span className="ml-2 text-xs text-muted">you</span>}
        </p>
        <p className="text-xs text-muted">{member.email}</p>
      </div>
      {member.role === 'owner' ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          <span aria-hidden="true">🔒</span> Owner
        </span>
      ) : (
        <select
          aria-label={`Role of ${member.name}`}
          value={member.role}
          disabled={locked || changeRole.isPending}
          onChange={(event) => changeRole.mutate(event.target.value as TenantRole)}
          className="h-7 rounded-full border border-line bg-page px-2 text-xs text-fg disabled:opacity-70 max-md:h-11"
        >
          {TENANT_ROLES.filter((role) => role !== 'owner').map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      )}
      <div ref={menuWrap} className="relative">
        <button
          ref={more}
          type="button"
          aria-label={`Actions for ${member.name}`}
          aria-haspopup="true"
          aria-expanded={menu}
          aria-controls={rowId}
          disabled={locked}
          onClick={() => setMenu((value) => !value)}
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-hover disabled:opacity-40 max-md:size-11"
        >
          <MoreIcon />
        </button>
        {menu && (
          <div id={rowId} className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-line bg-surface p-1 shadow-pop">
            {confirming ? (
              <div className="flex flex-col gap-1 p-1">
                <p className="text-xs text-muted">Remove {member.name} from the workspace?</p>
                <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                  Remove
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm text-danger hover:bg-hover max-md:min-h-11"
                onClick={() => setConfirming(true)}
              >
                Remove…
              </button>
            )}
          </div>
        )}
      </div>
      <div className="w-full empty:hidden">
        <ErrorNote error={changeRole.error ?? remove.error} />
      </div>
    </li>
  );
}

/** `/w/$tenantSlug/admin/members`: who is in the workspace, their roles, and invitations. */
export function MembersPage() {
  const { role, tenant } = useWorkspace();
  const refresh = useRefresh();
  const { data: members, error, isPending } = useMembers();
  const selfId = loadSession()?.user.id;
  const [inviting, setInviting] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {members?.length ?? 0} {members?.length === 1 ? 'person' : 'people'} in this workspace
        </p>
        {!inviting && (
          <Button onClick={() => setInviting(true)}>Invite someone</Button>
        )}
      </div>
      {inviting && (
        <InviteForm onInvited={() => void refresh('members')} />
      )}
      {isPending && <Loading what="members" />}
      <ErrorNote error={error} />
      {members && (
        <ul aria-label={`Members of ${tenant.name}`} className="flex flex-col">
          {members.map((member) => (
            <MemberRow key={member.userId} member={member} actorRole={role} isSelf={member.userId === selfId} />
          ))}
        </ul>
      )}
    </div>
  );
}
