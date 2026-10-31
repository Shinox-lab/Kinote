import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { Member, TenantRole } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { canChangeRole } from '../../lib/console.js';
import { useMembers, useRefresh, useWorkspace } from '../../lib/queries.js';
import { TENANT_ROLE_INFO } from '../../lib/roles.js';
import { loadSession } from '../../lib/session.js';
import { MoreIcon, SearchIcon } from '../../components/icons.js';
import { InviteForm } from '../../components/InviteForm.js';
import { PendingInvitations } from '../../components/PendingInvitations.js';
import { Avatar, Button, EmptyState, ErrorNote, Loading } from '../../components/ui.js';

function MemberRow({ member, actorRole, isSelf }: { member: Member; actorRole: TenantRole; isSelf: boolean }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const locked = isSelf || !canChangeRole(actorRole, member.role);
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
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-1 py-3 last:border-0">
      <Avatar name={member.name} id={member.userId} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">
          {member.name}
          {isSelf && <span className="ml-2 rounded-full bg-hover px-1.5 py-0.5 text-[10.5px] font-normal text-muted">You</span>}
        </p>
        <p className="truncate text-xs text-muted">{member.email}</p>
      </div>
      {member.role === 'owner' ? (
        <span className="inline-flex h-8 items-center gap-1 px-2 text-sm text-muted">
          <span aria-hidden="true">🔒</span> Owner
        </span>
      ) : (
        <select
          aria-label={`Role of ${member.name}`}
          value={member.role}
          disabled={locked || changeRole.isPending}
          onChange={(event) => changeRole.mutate(event.target.value as TenantRole)}
          title={locked ? (isSelf ? 'You can’t change your own role.' : 'Only an owner can change this.') : undefined}
          className="h-8 rounded-md border border-transparent bg-transparent px-2 text-sm text-fg hover:border-line hover:bg-page focus:border-line focus:bg-page disabled:opacity-60 disabled:hover:border-transparent disabled:hover:bg-transparent max-md:h-11"
        >
          {TENANT_ROLE_INFO.filter((info) => info.role !== 'owner').map((info) => (
            <option key={info.role} value={info.role}>
              {info.label}
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
          className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover disabled:invisible max-md:size-11"
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

const ROLE_ORDER: TenantRole[] = ['owner', 'admin', 'member', 'viewer'];

/** `/w/$tenantSlug/admin/members`: who is in the workspace, their roles, and invitations. */
export function MembersPage() {
  const { role, tenant } = useWorkspace();
  const refresh = useRefresh();
  const { data: members, error, isPending } = useMembers();
  const selfId = loadSession()?.user.id;
  const [inviting, setInviting] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TenantRole | 'all'>('all');

  const counts = useMemo(() => {
    const c: Record<TenantRole, number> = { owner: 0, admin: 0, member: 0, viewer: 0 };
    for (const m of members ?? []) c[m.role] += 1;
    return c;
  }, [members]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members ?? [])
      .filter((m) => filter === 'all' || m.role === filter)
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
  }, [members, query, filter]);

  const chips: Array<{ value: TenantRole | 'all'; label: string; count: number }> = [
    { value: 'all', label: 'All', count: members?.length ?? 0 },
    ...TENANT_ROLE_INFO.map((info) => ({ value: info.role, label: `${info.label}s`, count: counts[info.role] })).filter(
      (c) => c.count > 0
    ),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {members?.length ?? 0} {members?.length === 1 ? 'person' : 'people'} in this workspace ·{' '}
          <Link
            to="/w/$tenantSlug/admin/roles"
            params={{ tenantSlug: tenant.slug }}
            className="font-medium text-accent-text hover:underline"
          >
            What do roles mean?
          </Link>
        </p>
        {!inviting && <Button onClick={() => setInviting(true)}>Invite someone</Button>}
      </div>
      {inviting && (
        <InviteForm onInvited={() => void refresh('invitations')} onClose={() => setInviting(false)} />
      )}
      <PendingInvitations />
      {isPending && <Loading what="members" />}
      <ErrorNote error={error} />
      {members && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">Search members</span>
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                <SearchIcon />
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or email"
                className="w-full rounded-md border border-line bg-page py-2 pl-8 pr-3 text-sm text-fg placeholder:text-muted"
              />
            </label>
            <div role="group" aria-label="Filter by role" className="flex flex-wrap gap-1">
              {chips.map((chip) => (
                <button
                  key={chip.value}
                  type="button"
                  aria-pressed={filter === chip.value}
                  onClick={() => setFilter(chip.value)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium max-md:min-h-11 ${
                    filter === chip.value
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-line text-muted hover:bg-hover hover:text-fg'
                  }`}
                >
                  {chip.label} <span className="opacity-70">{chip.count}</span>
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <EmptyState title="No one matches">Try another name, or clear the role filter.</EmptyState>
          ) : (
            <ul aria-label={`Members of ${tenant.name}`} className="flex flex-col">
              {shown.map((member) => (
                <MemberRow key={member.userId} member={member} actorRole={role} isSelf={member.userId === selfId} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
