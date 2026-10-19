import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ApiError, api, errorMessage } from '../../lib/api.js';
import { slugify } from '../../lib/console.js';
import { useRefresh, useWorkspace } from '../../lib/queries.js';

/**
 * A title field under a space or page row: Enter makes the page (in that space,
 * under that page) and opens it; Escape or an empty blur cancels. A slug that is
 * already taken is retried once with a short suffix, so the person never meets it.
 */
export function NewPageRow({
  spaceId,
  parentId,
  depth,
  onDone,
}: {
  spaceId: string;
  parentId: string | null;
  depth: number;
  onDone: (created?: { parentId: string | null }) => void;
}) {
  const { tenant } = useWorkspace();
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [title, setTitle] = useState('');

  const create = useMutation({
    mutationFn: async () => {
      const clean = title.trim();
      const slug = slugify(clean) || 'page';
      const body = { space_id: spaceId, parent_id: parentId, title: clean };
      try {
        return await api.createPage({ ...body, slug });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'slug_taken') throw err;
        return api.createPage({ ...body, slug: `${slug}-${Math.random().toString(36).slice(2, 6)}` });
      }
    },
    onSuccess: async (page) => {
      await refresh('tree', spaceId);
      onDone({ parentId });
      await navigate({ to: '/w/$tenantSlug/p/$pageId', params: { tenantSlug: tenant.slug, pageId: page.id } });
    },
  });

  return (
    <form
      className="py-px"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() !== '' && !create.isPending) create.mutate();
      }}
    >
      <label className="sr-only" htmlFor={`new-page-${parentId ?? spaceId}`}>
        New page title
      </label>
      <input
        id={`new-page-${parentId ?? spaceId}`}
        autoFocus
        value={title}
        placeholder="Page title"
        disabled={create.isPending}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onDone();
          }
        }}
        onBlur={() => {
          if (title.trim() === '' && !create.isPending) onDone();
        }}
        className="w-full rounded-md border border-line bg-page px-2 py-1 text-sm text-fg placeholder:text-muted"
      />
      {create.error && (
        <p role="alert" className="px-1 pt-1 text-xs text-danger">
          {errorMessage(create.error)}
        </p>
      )}
    </form>
  );
}
