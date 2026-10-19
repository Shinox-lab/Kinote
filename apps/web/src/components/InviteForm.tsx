import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { INVITE_ROLES, inviteLink } from '../lib/console.js';
import { Button, Card, ErrorNote, SelectField, TextField } from './ui.js';

/** The accept link of a fresh invitation, with a copy button. It only lives in this component's state. */
function AcceptLink({ link, email, expiresAt }: { link: string; email: string; expiresAt: string }) {
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
    <div className="mt-4 flex flex-col gap-2 rounded-md bg-slate-50 p-3">
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

export function InviteForm({ onInvited }: { onInvited: () => void }) {
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

  return (
    <Card title="Invite someone">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" required />
        </div>
        <div className="w-40">
          <SelectField
            label="Role"
            value={role}
            options={INVITE_ROLES.map((r) => ({ value: r, label: r }))}
            onChange={setRole}
          />
        </div>
        <Button type="submit" disabled={invite.isPending}>
          {invite.isPending ? 'Inviting…' : 'Create invite'}
        </Button>
      </form>
      <div className="mt-3">
        <ErrorNote error={invite.error} />
      </div>
      {invite.data && (
        <AcceptLink
          link={inviteLink(window.location.origin, invite.data.acceptToken)}
          email={invite.data.invitation.email}
          expiresAt={invite.data.invitation.expiresAt}
        />
      )}
    </Card>
  );
}
