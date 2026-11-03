// Pages reached from a link in an email (or the operator's reset-password
// command): confirm an email address, set a new password, and ask for a
// password reset. None needs a session; the link itself is the proof.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useRouter } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { startSession } from '../lib/queryClient.js';
import { AuthShell, Button, ErrorNote, TextField } from '../components/ui.js';

/** /verify-email/$token: confirms the address and signs the person in. */
export function VerifyEmailPage() {
  const { token } = useParams({ from: '/verify-email/$token' });
  const router = useRouter();
  const verify = useMutation({
    mutationFn: () => api.verifyEmail(token),
    onSuccess: (auth) => {
      startSession(auth);
      router.history.push('/');
    },
  });
  // Once, even under StrictMode's double effect: the link works only once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    verify.mutate();
  }, [verify]);

  return (
    <AuthShell title="Confirming your email">
      {verify.isError ? (
        <>
          <ErrorNote error={verify.error} />
          <p className="mt-4 text-sm text-muted">
            Sign in and ask for a new link from your account page, or{' '}
            <Link to="/sign-in" search={{ redirect: undefined }} className="font-medium text-accent-text underline">
              sign in
            </Link>
            .
          </p>
        </>
      ) : (
        <p className="text-sm text-muted">One moment…</p>
      )}
    </AuthShell>
  );
}

/** /reset-password/$token: sets a new password; every other session ends. */
export function ResetPasswordPage() {
  const { token } = useParams({ from: '/reset-password/$token' });
  const router = useRouter();
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () => api.confirmPasswordReset({ token, password }),
    onSuccess: (auth) => {
      startSession(auth);
      router.history.push('/');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    reset.mutate();
  };
  return (
    <AuthShell title="Set a new password">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={10}
          hint="At least 10 characters. Setting it signs you out everywhere else."
          required
        />
        <ErrorNote error={reset.error} />
        <Button type="submit" disabled={reset.isPending}>
          {reset.isPending ? 'Saving…' : 'Set password and sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}

/** /forgot-password: emails a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const request = useMutation({ mutationFn: () => api.requestPasswordReset(email) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    request.mutate();
  };
  if (request.isSuccess) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm text-fg">
          If <strong>{email}</strong> has an account, we've sent it a link to set a new password. The link works for an
          hour.
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Forgot your password?">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <ErrorNote error={request.error} />
        <Button type="submit" disabled={request.isPending}>
          {request.isPending ? 'Sending…' : 'Email me a link'}
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted">
        <Link to="/sign-in" search={{ redirect: undefined }} className="font-medium text-accent-text underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
