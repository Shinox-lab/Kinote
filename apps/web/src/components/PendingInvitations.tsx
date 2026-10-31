import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PendingInvitation } from '@kinote/contracts';
import { api } from '../lib/api.js';
import { expiryLabel, inviteLink } from '../lib/console.js';
import { useInvitations, useRefresh } from '../lib/queries.js';
import { relativeTime } from '../lib/pageStatus.js';
import { TENANT_ROLE_INFO } from '../lib/roles.js';
import { AcceptLink } from './InviteForm.js';
import { Button, ErrorNote } from './ui.js';

const roleLabel = (role: PendingInvitation['role']) => TENANT_ROLE_INFO.find((i) => i.role === role)?.label ?? role;

function InvitationRow({ invitation }: { invitation: PendingInvitation }) {
  const refresh = useRefresh();
  const [confirming, setConfirming] = useState(false);
  // Only a hash of the token is stored, so a new link means inviting the email again (the old link stops working).
  const renew = useMutation({
    mutationFn: () => api.invite({ email: invitation.email, role: invitation.role }),
    onSuccess: () => refresh('invitations'),
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeInvitation(invitation.id),
    onSettled: () => {
      setConfirming(false);
      return refresh('invitations');
    },
  });

  return (
    <li className="flex flex-col gap-2 border-b border-line px-1 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-[11px] font-semibold uppercase text-muted"
        >
          {invitation.email.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm font-medium text-fg">{invitation.email}</p>
          <p className="text-xs text-muted">
            {roleLabel(invitation.role)} · invited {relativeTime(invitation.createdAt)}
            {invitation.invitedByName ? ` by ${invitation.invitedByName}` : ''} ·{' '}
            <span className={invitation.expired ? 'font-medium text-warn-text' : undefined}>
              {expiryLabel(invitation.expiresAt)}
            </span>
          </p>
        </div>
        {confirming ? (
          <div className="flex gap-1.5 max-sm:ml-11">
            <Button variant="danger" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
              Revoke
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <div className="flex gap-1.5 max-sm:ml-11">
            <Button
              variant="secondary"
              onClick={() => renew.mutate()}
              disabled={renew.isPending}
              aria-label={`New link for ${invitation.email}`}
            >
              {renew.isPending ? 'Creating…' : invitation.expired ? 'Resend' : 'New link'}
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(true)} aria-label={`Revoke invitation for ${invitation.email}`}>
              Revoke
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <p className="ml-11 text-xs text-muted">Their link stops working. You can invite them again later.</p>
      )}
      <div className="ml-11 empty:hidden">
        <ErrorNote error={renew.error ?? revoke.error} />
      </div>
      {renew.data && (
        <div className="ml-11">
          <AcceptLink
            link={inviteLink(window.location.origin, renew.data.acceptToken)}
            email={renew.data.invitation.email}
            expiresAt={renew.data.invitation.expiresAt}
          />
        </div>
      )}
    </li>
  );
}

/** Invitations nobody has accepted yet, with a fresh link or a revoke for each. Hidden when there are none. */
export function PendingInvitations() {
  const { data: invitations, error } = useInvitations();
  if (error) return <ErrorNote error={error} />;
  if (!invitations || invitations.length === 0) return null;

  return (
    <section aria-labelledby="pending-title" className="flex flex-col gap-1">
      <h2 id="pending-title" className="text-sm font-semibold text-fg">
        Pending invitations <span className="font-normal text-muted">{invitations.length}</span>
      </h2>
      <p className="text-xs text-muted">Invited, but they haven’t joined yet. A new link replaces the old one.</p>
      <ul aria-label="Pending invitations" className="mt-1 flex flex-col">
        {invitations.map((invitation) => (
          <InvitationRow key={invitation.id} invitation={invitation} />
        ))}
      </ul>
    </section>
  );
}
