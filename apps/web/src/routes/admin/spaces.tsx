import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { SpaceResponse } from '@kinote/contracts';
import { api } from '../../lib/api.js';
import { slugify } from '../../lib/console.js';
import { useRefresh, useSpaces } from '../../lib/queries.js';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useMediaQuery } from '../../lib/useMediaQuery.js';
import { BookIcon, InboxIcon } from '../../components/icons.js';
import { SpaceCard } from '../../components/SpaceCard.js';
import { Button, Checkbox, ErrorNote, Loading, TextField } from '../../components/ui.js';

function CreateSpaceForm({ onCreated }: { onCreated: (space: SpaceResponse) => void }) {
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
    onSuccess: (space) => {
      setName('');
      setSlug('');
      setSlugEdited(false);
      void refresh('spaces');
      onCreated(space);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-fg">Create a space</h2>
      <div className="flex flex-col gap-3">
        <TextField
          label="Name"
          value={name}
          onChange={(value) => {
            setName(value);
            if (!slugEdited) setSlug(slugify(value));
          }}
          required
        />
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
      <Checkbox label="Changes need review" checked={reviewRequired} onChange={setReviewRequired} />
      <Checkbox
        label="Reviewers may approve their own changes"
        checked={allowSelfApproval}
        onChange={setAllowSelfApproval}
      />
      <ErrorNote error={create.error} />
      <Button type="submit" disabled={create.isPending || name.trim() === '' || slug.trim() === ''}>
        Create space
      </Button>
    </form>
  );
}

/** `/w/$tenantSlug/admin/spaces`: rows of spaces, and the selected space's settings in a docked pane. */
export function SpacesPage() {
  const { data: spaces, error, isPending } = useSpaces();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const wide = useMediaQuery('(min-width: 1200px)');
  const pane = useRef<HTMLDivElement>(null);
  const current = spaces?.find((space) => space.id === selected) ?? null;
  const paneOpen = creating || current !== null;
  const closePane = () => {
    setCreating(false);
    setSelected(null);
  };
  useFocusTrap(pane, !wide && paneOpen, closePane);
  useEffect(() => {
    if (wide || !paneOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [wide, paneOpen]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {spaces?.length ?? 0} {spaces?.length === 1 ? 'space' : 'spaces'}
        </p>
        <Button
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
          disabled={creating}
        >
          New space
        </Button>
      </div>
      <ErrorNote error={error} />
      {isPending ? (
        <Loading what="spaces" />
      ) : (
        <div className="grid gap-5 min-[1200px]:grid-cols-[minmax(0,1fr)_420px] min-[1200px]:items-start">
          <ul aria-label="Spaces" className="flex flex-col">
            {spaces?.map((space) => {
              const active = space.id === selected;
              return (
                <li key={space.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      setCreating(false);
                      setSelected(space.id);
                    }}
                    className={`flex w-full items-center gap-3 rounded-md px-2 py-3 text-left ${
                      active ? 'bg-active' : 'hover:bg-hover'
                    }`}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center text-base text-muted">
                      {space.kind === 'inbox' ? <InboxIcon /> : <BookIcon />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-sm font-medium text-fg">{space.name}</span>
                        <span className="text-xs text-muted">/{space.slug}</span>
                      </span>
                    </span>
                    {space.kind === 'inbox' ? (
                      <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] text-fg">Personal</span>
                    ) : space.reviewRequired ? (
                      <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[10.5px] text-warn-text">Review required</span>
                    ) : null}
                    {space.archivedAt !== null && (
                      <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] text-muted">Archived</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {(creating || current) && (
            <div
              ref={pane}
              role={wide ? undefined : 'dialog'}
              aria-modal={wide ? undefined : 'true'}
              aria-label={creating ? 'Create a space' : 'Space settings'}
              tabIndex={-1}
              className="fixed inset-0 z-30 overflow-y-auto bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none min-[1200px]:static min-[1200px]:z-auto min-[1200px]:rounded-lg min-[1200px]:border min-[1200px]:border-line min-[1200px]:p-4"
            >
              <button
                type="button"
                onClick={closePane}
                className="mb-3 rounded-md px-1 py-1 text-xs font-medium text-accent-text hover:underline min-[1200px]:hidden"
              >
                Close
              </button>
              {creating ? (
                <CreateSpaceForm
                  onCreated={(space) => {
                    setCreating(false);
                    setSelected(space.id);
                  }}
                />
              ) : current ? (
                <SpaceCard key={current.id} space={current} />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
