import { useState, type FormEvent } from 'react';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { safeRedirect } from '../lib/console.js';
import { startSession } from '../lib/queryClient.js';
import { AuthShell, Button, ErrorNote, TextField } from '../components/ui.js';

export function SignInPage() {
  const { redirect } = useSearch({ from: '/sign-in' });
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => api.signIn({ email, password }),
    onSuccess: (auth) => {
      startSession(auth);
      router.history.push(safeRedirect(redirect));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate();
  };

  return (
    <AuthShell title="Sign in">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />
        <ErrorNote error={signIn.error} />
        <Button type="submit" disabled={signIn.isPending}>
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted">
        New here?{' '}
        <Link to="/sign-up" search={{ redirect }} className="font-medium text-accent-text underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
