import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { SpaceResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { slugify } from '../lib/console.js';
import { useArchivedTree, useRefresh, useSpaceTree, useSpaces, useWorkspace } from '../lib/queries.js';
import { buildTree } from '../lib/wiki.js';
import { Button, Card, ErrorNote, Loading, SelectField, TextField } from '../components/ui.js';
import { Tree } from '../components/Tree.js';
import { DropZone } from '../components/DropZone.js';
import { useUploads } from '../lib/useUploads.js';

const TOP_LEVEL = '';

/** Title, slug (suggested from the title) and parent for a new page in this space. */
function CreatePageForm({ space }: { space: SpaceResponse }) {
  const { tenant } = useWorkspace();
  const navigate = useNavigate();
  const refresh = useRefresh();
  const { data: tree } = useSpaceTree(space.id);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [parentId, setParentId] = useState(TOP_LEVEL);

  const parents = (tree?.nodes ?? []).filter((n) => n.kind === 'page');
  const create = useMutation({
    mutationFn: () =>
      api.createPage({ space_id: space.id, parent_id: parentId === TOP_LEVEL ? null : parentId, title: title.trim(), slug }),
    onSuccess: async (page) => {
      await refresh('tree', space.id);
      await navigate({ to: '/w/$tenantSlug/p/$pageId', params: { tenantSlug: tenant.slug, pageId: page.id } });
    },
  });

  return (
    <Card title="New page">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label="Title"
          value={title}
          onChange={(value) => {
            setTitle(value);
            if (!slugEdited) setSlug(slugify(value));
          }}
          required
        />
        <TextField
          label="Slug"
          value={slug}
          onChange={(value) => {
            setSlug(value);
            setSlugEdited(true);
          }}
          pattern="[a-z0-9\-]+"
          hint="Lower-case letters, digits and hyphens."
          required
        />
        <SelectField
          label="Under page"
          value={parentId}
          options={[{ value: TOP_LEVEL, label: 'Top level' }, ...parents.map((p) => ({ value: p.id, label: p.title }))]}
          onChange={setParentId}
        />
        <ErrorNote error={create.error} />
        <div>
          <Button type="submit" disabled={create.isPending || title.trim() === '' || slug === ''}>
            Create page
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Archived pages, which only a space admin may list; each links to the page, where it can be restored. */
function ArchivedPages({ space, tenantSlug }: { space: SpaceResponse; tenantSlug: string }) {
  const { data, error } = useArchivedTree(space.id, space.myRole === 'admin');
  if (space.myRole !== 'admin') return null;
  return (
    <Card title="Archived pages">
      {error ? (
        <ErrorNote error={error} />
      ) : !data ? (
        <Loading what="archived pages" />
      ) : data.nodes.length === 0 ? (
        <p className="text-sm text-muted">No archived pages.</p>
      ) : (
        <Tree items={buildTree(data.nodes)} tenantSlug={tenantSlug} label="Archived pages" />
      )}
    </Card>
  );
}

/** `/w/$tenantSlug/s/$spaceSlug`: the space's page tree and a form to add a page. */
export function SpacePage() {
  const { tenant } = useWorkspace();
  const { spaceSlug } = useParams({ from: '/w/$tenantSlug/s/$spaceSlug' });
  const { data: spaces, error, isPending } = useSpaces();
  const space = spaces?.find((s) => s.slug === spaceSlug);
  const { data: tree, error: treeError } = useSpaceTree(space?.id);
  const { enqueue } = useUploads();

  if (isPending) return <Loading what="space" />;
  if (error) return <ErrorNote error={error} />;
  if (!space) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Space not found</h1>
        <p className="text-sm text-muted">There is no space called “{spaceSlug}” that you can open.</p>
        <Link to="/w/$tenantSlug" params={{ tenantSlug: tenant.slug }} className="text-sm font-medium text-accent-text underline">
          Back to the workspace
        </Link>
      </div>
    );
  }

  const archived = space.archivedAt !== null;
  const canCreate = !archived && space.myRole !== 'viewer';

  const body = (
    <>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{space.name}</h1>
        {archived && <span className="rounded bg-dot-review/15 px-1.5 text-xs text-fg">Archived</span>}
        <span className="text-sm text-muted">Your role: {space.myRole}</span>
        {canCreate && space.kind !== 'inbox' && (
          <Link
            to="/w/$tenantSlug/capture"
            params={{ tenantSlug: tenant.slug }}
            search={{ space: space.id }}
            className="text-sm font-medium text-accent-text hover:underline"
          >
            Capture here
          </Link>
        )}
      </div>
      <Card title="Pages">
        {treeError ? (
          <ErrorNote error={treeError} />
        ) : !tree ? (
          <Loading what="pages" />
        ) : tree.nodes.length === 0 ? (
          <p className="text-sm text-muted">No pages yet.</p>
        ) : (
          <Tree items={buildTree(tree.nodes)} tenantSlug={tenant.slug} label="Pages" />
        )}
      </Card>
      {canCreate && <CreatePageForm space={space} />}
      <ArchivedPages space={space} tenantSlug={tenant.slug} />
    </>
  );

  return canCreate ? (
    <DropZone target={space.name} onFiles={(files) => enqueue(files, { spaceId: space.id, parentId: null })}>
      <div className="flex flex-col gap-4">{body}</div>
    </DropZone>
  ) : (
    <div className="flex flex-col gap-4">{body}</div>
  );
}
