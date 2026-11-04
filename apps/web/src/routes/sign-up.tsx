import { useState, type FormEvent } from 'react';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { safeRedirect } from '../lib/console.js';
import { startSession } from '../lib/queryClient.js';
import { loadSession, saveSession } from '../lib/session.js';
import { AuthShell, Button, ErrorNote, Loading, TextField } from '../components/ui.js';

/** The invitation token when the visitor came from an invitation link (`/accept-invite/<token>`). */
export function invitationTokenOf(redirect: string | undefined): string | null {
  const match = /^\/accept-invite\/([^/?#]+)$/.exec(redirect ?? '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function SignUpPage() {
  const { redirect } = useSearch({ from: '/sign-up' });
  const token = invitationTokenOf(redirect);
  return token ? <InvitedSignUp token={token} /> : <OpenSignUp redirect={redirect} />;
}

/** Sign-up from an invitation: the email is the invited one, and the account joins the workspace at once. */
function InvitedSignUp({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const preview = useQuery({ queryKey: ['invitation-preview', token], queryFn: () => api.previewInvitation(token), retry: false });

  const signUp = useMutation({
    mutationFn: () => api.signUp({ name, password, invitation_token: token }),
    onSuccess: (reply) => {
      if ('checkEmail' in reply) return; // never for an invitation sign-up
      const auth = reply;
      startSession(auth);
      const joined = auth.joined?.tenant;
      if (!joined) return router.history.push('/');
      const session = loadSession();
      if (session) saveSession({ ...session, tenantId: joined.id, tenantSlug: joined.slug });
      router.history.push(`/w/${encodeURIComponent(joined.slug)}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signUp.mutate();
  };

  if (preview.isPending) return <AuthShell title="Create your account"><Loading what="the invitation" /></AuthShell>;
  if (preview.isError) {
    return (
      <AuthShell title="This invitation can't be used">
        <ErrorNote error={preview.error} />
        <p className="mt-4 text-sm text-muted">Ask whoever invited you for a new link.</p>
      </AuthShell>
    );
  }

  const signInLink = `/accept-invite/${encodeURIComponent(token)}`;
  return (
    <AuthShell title={`Join ${preview.data.tenantName}`}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label="Email"
          type="email"
          value={preview.data.email}
          onChange={() => undefined}
          readOnly
          hint="Your account uses the email the invitation was sent to."
        />
        <TextField label="Name" value={name} onChange={setName} autoComplete="name" required />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={10}
          hint="At least 10 characters, and not a common password."
          required
        />
        <ErrorNote error={signUp.error} />
        <Button type="submit" disabled={signUp.isPending}>
          {signUp.isPending ? 'Creating account…' : 'Create account and join'}
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted">
        Already have an account?{' '}
        <Link to="/sign-in" search={{ redirect: signInLink }} className="font-medium text-accent-text underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

/** Sign-up without an invitation, when the server allows it. */
function OpenSignUp({ redirect }: { redirect: string | undefined }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => api.authConfig() });

  const signUp = useMutation({
    mutationFn: () => api.signUp({ name, email, password }),
    onSuccess: (reply) => {
      // With email on, the account is confirmed (and signed in) from the emailed link.
      if ('checkEmail' in reply) return;
      startSession(reply);
      router.history.push(safeRedirect(redirect));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signUp.mutate();
  };

  const signInLink = (
    <p className="mt-4 text-sm text-muted">
      Already have an account?{' '}
      <Link to="/sign-in" search={{ redirect }} className="font-medium text-accent-text underline">
        Sign in
      </Link>
    </p>
  );

  if (signUp.data && 'checkEmail' in signUp.data) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm text-fg">
          We've sent a link to <strong>{email}</strong>. Open it within a day to confirm your address and sign in.
        </p>
      </AuthShell>
    );
  }
  if (config.isPending) return <AuthShell title="Create your account"><Loading what="sign-up" /></AuthShell>;
  const mode = config.data?.signUpMode ?? 'open';
  if (mode !== 'open') {
    return (
      <AuthShell title="Create your account">
        <p className="text-sm text-fg">
          {mode === 'invite'
            ? 'New accounts need an invitation. Ask a workspace admin for an invitation link, then open it.'
            : 'This server does not create new accounts. Ask its operator for one.'}
        </p>
        {signInLink}
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Name" value={name} onChange={setName} autoComplete="name" required />
        <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={10}
          hint="At least 10 characters, and not a common password."
          required
        />
        <ErrorNote error={signUp.error} />
        <Button type="submit" disabled={signUp.isPending}>
          {signUp.isPending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      {signInLink}
    </AuthShell>
  );
}
