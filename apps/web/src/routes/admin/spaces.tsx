import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { slugify } from '../../lib/console.js';
import { useRefresh, useSpaces } from '../../lib/queries.js';
import { Button, Card, Checkbox, ErrorNote, Loading, TextField } from '../../components/ui.js';
import { SpaceCard } from '../../components/SpaceCard.js';

function CreateSpaceForm() {
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [allowSelfApproval, setAllowSelfApproval] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.createSpace({
        name,
        slug,
        review_required: reviewRequired,
        allow_self_approval: allowSelfApproval,
        quiet_seconds: 120,
        human_protection_seconds: 300,
      }),
    onSuccess: () => {
      setName('');
      setSlug('');
      setSlugEdited(false);
      return refresh('spaces');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Card title="Create a space">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <div className="min-w-56 flex-1">
            <TextField
              label="Name"
              value={name}
              onChange={(value) => {
                setName(value);
                if (!slugEdited) setSlug(slugify(value));
              }}
              required
            />
          </div>
          <div className="min-w-56 flex-1">
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
          </div>
        </div>
        <Checkbox label="Changes need review" checked={reviewRequired} onChange={setReviewRequired} />
        <Checkbox
          label="Reviewers may approve their own changes"
          checked={allowSelfApproval}
          onChange={setAllowSelfApproval}
        />
        <ErrorNote error={create.error} />
        <div>
          <Button type="submit" disabled={create.isPending}>
            Create space
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** `/w/$tenantSlug/admin/spaces`: create spaces, set review rules, archive, and grant access. */
export function SpacesPage() {
  const { data: spaces, error, isPending } = useSpaces();
  return (
    <div className="flex flex-col gap-5">
      <CreateSpaceForm />
      <Card title="Spaces">
        {isPending && <Loading what="spaces" />}
        <ErrorNote error={error} />
        {spaces && (
          <ul className="divide-y divide-line">
            {spaces.map((s) => (
              <SpaceCard key={s.id} space={s} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
