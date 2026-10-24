import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api, errorMessage } from '../../lib/api.js';
import { slugify } from '../../lib/console.js';
import { useRefresh } from '../../lib/queries.js';

/**
 * A name field in the sidebar: it makes a space and opens it. A slug that is
 * already taken is retried once with a short suffix, so the person never meets it.
 */
export function NewSpaceRow({ onDone }: { onDone: (spaceId: string | null) => void }) {
  const refresh = useRefresh();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const clean = name.trim();
      const slug = slugify(clean) || 'space';
      const body = { name: clean, slug, review_required: false };
      try {
        return await api.createSpace(body);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'slug_taken') throw err;
        return api.createSpace({ ...body, slug: `${slug}-${Math.random().toString(36).slice(2, 6)}` });
      }
    },
    onSuccess: async (space) => {
      await refresh('spaces');
      onDone(space.id);
    },
  });

  return (
    <form
      className="flex flex-col gap-1 py-px"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() !== '' && !create.isPending) create.mutate();
      }}
    >
      <label className="sr-only" htmlFor="new-space-name">
        New space name
      </label>
      <input
        id="new-space-name"
        autoFocus
        value={name}
        placeholder="Space name"
        disabled={create.isPending}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone(null);
          }
        }}
        onBlur={() => {
          if (name.trim() === '' && !create.isPending) onDone(null);
        }}
        className="w-full rounded-md border border-line bg-page px-2 py-1 text-sm text-fg placeholder:text-muted"
      />
      {create.error && (
        <p role="alert" className="px-1 text-xs text-danger">
          {errorMessage(create.error)}
        </p>
      )}
    </form>
  );
}
