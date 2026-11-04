import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { INVITE_ROLES, inviteLink } from '../lib/console.js';
import { TENANT_ROLE_INFO } from '../lib/roles.js';
import { CloseIcon } from './icons.js';
import { Button, Checkbox, ErrorNote, SelectField, TextField } from './ui.js';

/** Whether this server sends email (SMTP set up), so an invitation can go out by email. */
export function useEmailEnabled(): boolean {
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.authConfig() });
  return config.data?.emailEnabled === true;
}

/**
 * The accept link of a fresh invitation, with a copy button. It only lives in
 * this component's state. `emailed` says whether it already went out by email
 * (undefined when email wasn't asked for).
 */
export function AcceptLink({
  link,
  email,
  expiresAt,
  emailed,
}: {
  link: string;
  email: string;
  expiresAt: string;
  emailed?: boolean;
}) {
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
      <p role="status" className="text-sm">
        {emailed === true
          ? `Emailed the invitation to ${email}. You can also send them this link yourself.`
          : emailed === false
            ? `We couldn't email ${email} just now. Send them this link yourself.`
            : `Send this link to ${email}.`}{' '}
        It works once, for the account with that email, until {new Date(expiresAt).toLocaleDateString()}.
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
  const emailEnabled = useEmailEnabled();
  const [sendEmail, setSendEmail] = useState(true);
  const emailing = emailEnabled && sendEmail;

  const invite = useMutation({
    mutationFn: (withEmail: boolean) => api.invite({ email, role, ...(withEmail ? { send_email: true } : {}) }),
    onSuccess: () => {
      setEmail('');
      onInvited();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate(emailing);
  };

  const roleInfo = TENANT_ROLE_INFO.find((info) => info.role === role);

  return (
    <section aria-labelledby="invite-title" className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="invite-title" className="text-base font-semibold text-fg">
            Invite someone
          </h2>
          <p className="text-xs text-muted">
            Creates a one-time link for that email. It expires in 7 days
            {emailing ? ' — we email it to them.' : ' — you send it yourself.'}
          </p>
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
          {invite.isPending ? (emailing ? 'Sending…' : 'Creating…') : emailing ? 'Send invitation' : 'Create link'}
        </Button>
      </form>
      {emailEnabled && (
        <div className="mt-2">
          <Checkbox label="Email the link to them" checked={sendEmail} onChange={setSendEmail} />
        </div>
      )}
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
          {...(invite.variables ? { emailed: invite.data.emailed } : {})}
        />
      )}
    </section>
  );
}
