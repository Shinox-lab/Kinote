import { useState, type FormEvent } from 'react';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { safeRedirect } from '../lib/console.js';
import { startSession } from '../lib/queryClient.js';
import { AuthShell, Button, ErrorNote, TextField } from '../components/ui.js';

export function SignUpPage() {
  const { redirect } = useSearch({ from: '/sign-up' });
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signUp = useMutation({
    mutationFn: () => api.signUp({ name, email, password }),
    onSuccess: (auth) => {
      startSession(auth);
      router.history.push(safeRedirect(redirect));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signUp.mutate();
  };

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
          hint="At least 10 characters."
          required
        />
        <ErrorNote error={signUp.error} />
        <Button type="submit" disabled={signUp.isPending}>
          {signUp.isPending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/sign-in" search={{ redirect }} className="font-medium text-indigo-700 underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
