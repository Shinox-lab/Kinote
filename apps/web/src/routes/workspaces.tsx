import { useState, type FormEvent } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { slugify } from '../lib/console.js';
import { ME_KEY } from '../lib/queries.js';
import { queryClient } from '../lib/queryClient.js';
import { AuthShell, Button, ErrorNote, TextField } from '../components/ui.js';
import { loadSession, saveSession } from '../lib/session.js';

/** `/` for a user without a workspace: name one and become its owner. */
export function CreateWorkspacePage({ additional = false }: { additional?: boolean } = {}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createTenant({ name, slug }),
    onSuccess: async ({ tenant }) => {
      const session = loadSession();
      if (session) saveSession({ ...session, tenantId: tenant.id, tenantSlug: tenant.slug });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      router.history.push(`/w/${encodeURIComponent(tenant.slug)}`);
    },
  });

  const changeName = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <AuthShell title={additional ? 'Create a workspace' : 'Create your workspace'}>
      <p className="mb-4 text-sm text-muted">
        {additional
          ? 'A separate workspace with its own spaces, people and pages. You become its owner.'
          : 'You are not in a workspace yet. Create one, or open an invitation link someone sent you.'}
      </p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField label="Workspace name" value={name} onChange={changeName} required />
        <TextField
          label="URL slug"
          value={slug}
          onChange={(value) => {
            setSlug(value);
            setSlugEdited(true);
          }}
          pattern="[a-z0-9\-]+"
          hint="Lowercase letters, numbers and dashes."
          required
        />
        <ErrorNote error={create.error} />
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </AuthShell>
  );
}
