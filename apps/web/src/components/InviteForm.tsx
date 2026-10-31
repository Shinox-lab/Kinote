import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { INVITE_ROLES, inviteLink } from '../lib/console.js';
import { TENANT_ROLE_INFO } from '../lib/roles.js';
import { CloseIcon } from './icons.js';
import { Button, ErrorNote, SelectField, TextField } from './ui.js';

/** The accept link of a fresh invitation, with a copy button. It only lives in this component's state. */
export function AcceptLink({ link, email, expiresAt }: { link: string; email: string; expiresAt: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard blocked: the link stays selectable in the field.
      setCopied(false);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-md bg-sidebar p-3">
      <p className="text-sm">
        Send this link to {email}. It works once, for the account with that email, until{' '}
        {new Date(expiresAt).toLocaleDateString()}.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField label="Accept link" value={link} onChange={() => {}} readOnly />
        </div>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    </div>
  );
}

export function InviteForm({ onInvited, onClose }: { onInvited: () => void; onClose?: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof INVITE_ROLES)[number]>('member');

  const invite = useMutation({
    mutationFn: () => api.invite({ email, role }),
    onSuccess: () => {
      setEmail('');
      onInvited();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  const roleInfo = TENANT_ROLE_INFO.find((info) => info.role === role);

  return (
    <section aria-labelledby="invite-title" className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="invite-title" className="text-base font-semibold text-fg">
            Invite someone
          </h2>
          <p className="text-xs text-muted">Creates a one-time link for that email. It expires in 7 days — you send it yourself.</p>
        </div>
        {onClose && (
          <button
            type="button"
            aria-label="Close invite"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg max-md:size-11"
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" required />
        </div>
        <div className="w-32">
          <SelectField
            label="Role"
            value={role}
            options={INVITE_ROLES.map((r) => ({ value: r, label: TENANT_ROLE_INFO.find((i) => i.role === r)?.label ?? r }))}
            onChange={setRole}
          />
        </div>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? 'Creating…' : 'Create link'}
        </Button>
      </form>
      {roleInfo && (
        <p className="mt-2 text-xs text-muted">
          <span className="font-medium text-fg">{roleInfo.label}:</span> {roleInfo.summary}
        </p>
      )}
      <div className="mt-3 empty:hidden">
        <ErrorNote error={invite.error} />
      </div>
      {invite.data && (
        <AcceptLink
          link={inviteLink(window.location.origin, invite.data.acceptToken)}
          email={invite.data.invitation.email}
          expiresAt={invite.data.invitation.expiresAt}
        />
      )}
    </section>
  );
}
