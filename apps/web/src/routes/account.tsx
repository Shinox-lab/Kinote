import { useState, type FormEvent } from 'react';
import { Link, useRouter } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { endSession } from '../lib/queryClient.js';
import { loadSession } from '../lib/session.js';
import { AuthShell, Button, ErrorNote, TextField } from '../components/ui.js';

/** /account: the signed-in person's password and sessions. */
export function AccountPage() {
  const router = useRouter();
  const user = loadSession()?.user;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const change = useMutation({
    mutationFn: () => api.changePassword({ current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });
  const everywhere = useMutation({
    mutationFn: () => api.signOutAll(),
    onSettled: () => {
      endSession();
      router.history.push('/sign-in');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };

  return (
    <AuthShell title="Account and security">
      <p className="mb-4 text-sm text-muted">
        Signed in as <strong className="text-fg">{user?.email}</strong>.
      </p>

      <section aria-labelledby="password-heading" className="flex flex-col gap-4">
        <h2 id="password-heading" className="text-sm font-semibold text-fg">
          Change password
        </h2>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <TextField
            label="Current password"
            type="password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            required
          />
          <TextField
            label="New password"
            type="password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            minLength={10}
            hint="At least 10 characters. Your other sessions are signed out."
            required
          />
          <ErrorNote error={change.error} />
          {change.isSuccess && (
            <p role="status" className="text-sm text-fg">
              Password changed. You're signed out everywhere else.
            </p>
          )}
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </form>
      </section>

      <section aria-labelledby="sessions-heading" className="mt-6 flex flex-col gap-3 border-t border-line pt-4">
        <h2 id="sessions-heading" className="text-sm font-semibold text-fg">
          Sessions
        </h2>
        <p className="text-sm text-muted">Lost a device, or signed in somewhere you shouldn't have? End every session, this one included.</p>
        <Button variant="secondary" onClick={() => everywhere.mutate()} disabled={everywhere.isPending}>
          Sign out everywhere
        </Button>
      </section>

      <p className="mt-6 text-sm text-muted">
        <Link to="/" className="font-medium text-accent-text underline">
          Back to your workspace
        </Link>
      </p>
    </AuthShell>
  );
}
