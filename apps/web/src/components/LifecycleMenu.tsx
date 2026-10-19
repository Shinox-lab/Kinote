import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PageDetails, SpaceResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { useSpaceTree } from '../lib/queries.js';
import { buildTree, descendantIds, type PageControls, type TreeItem } from '../lib/wiki.js';
import { Button, ErrorNote, SelectField } from './ui.js';

type Action = 'move' | 'withdraw' | 'archive';

/** The pages of a tree as select options, indented by depth. */
function parentOptions(items: TreeItem[], skip: Set<string>, depth = 0): { value: string; label: string }[] {
  return items.flatMap(({ node, children }) =>
    node.kind !== 'page' || skip.has(node.id)
      ? []
      : [{ value: node.id, label: `${'— '.repeat(depth)}${node.title}` }, ...parentOptions(children, skip, depth + 1)]
  );
}

const TOP_LEVEL = '';

/** Moves the page to a space (one it can edit) and a parent page there. */
function MoveForm({
  page,
  spaces,
  onDone,
  onCancel,
}: {
  page: PageDetails;
  spaces: SpaceResponse[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const targets = spaces.filter((s) => s.archivedAt === null && (s.myRole !== 'viewer'));
  const [spaceId, setSpaceId] = useState(targets.some((s) => s.id === page.spaceId) ? page.spaceId : (targets[0]?.id ?? ''));
  const [parentId, setParentId] = useState(page.parentId ?? TOP_LEVEL);
  const { data: tree, error: treeError } = useSpaceTree(spaceId || undefined);

  const nodes = tree?.nodes ?? [];
  const options = [
    { value: TOP_LEVEL, label: 'Top level' },
    ...parentOptions(buildTree(nodes), new Set([page.id, ...descendantIds(nodes, page.id)])),
  ];
  // A parent that does not exist in the chosen space (the old one, after switching space) means top level.
  const parent = options.some((o) => o.value === parentId) ? parentId : TOP_LEVEL;

  const move = useMutation({
    mutationFn: () =>
      api.movePage(page.id, { target_space_id: spaceId, target_parent_id: parent === TOP_LEVEL ? null : parent }),
    onSuccess: onDone,
  });

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate();
      }}
    >
      <SelectField
        label="Move to space"
        value={spaceId}
        options={targets.map((s) => ({ value: s.id, label: s.name }))}
        onChange={(id) => {
          setSpaceId(id);
          setParentId(TOP_LEVEL);
        }}
      />
      <SelectField label="Under page" value={parent} options={options} onChange={setParentId} />
      <ErrorNote error={treeError ?? move.error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={move.isPending || spaceId === ''}>
          Move page
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A one-step confirmation for an action that removes the page from search. */
function Confirm({
  text,
  label,
  run,
  onCancel,
}: {
  text: string;
  label: string;
  run: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const mutation = useMutation({ mutationFn: run });
  return (
    <div className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm">{text}</p>
      <ErrorNote error={mutation.error} />
      <div className="flex gap-2">
        <Button variant="danger" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {label}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The page's lifecycle actions: move, withdraw, archive (and restoring an archived
 * page), as `controls` allows for the actor's role. `onChanged` runs after each one
 * succeeds, so the page and its badge are fetched again.
 */
export function LifecycleMenu({
  page,
  spaces,
  controls,
  onChanged,
}: {
  page: PageDetails;
  spaces: SpaceResponse[];
  controls: PageControls;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);

  const restore = useMutation({ mutationFn: () => api.restorePage(page.id), onSuccess: onChanged });
  const items: { key: Action; label: string; show: boolean }[] = [
    { key: 'move', label: 'Move…', show: controls.move },
    { key: 'withdraw', label: 'Withdraw from index…', show: controls.withdraw },
    { key: 'archive', label: 'Archive…', show: controls.archive },
  ];
  const shown = items.filter((i) => i.show);

  const done = () => {
    setAction(null);
    setOpen(false);
    onChanged();
  };
  const run = (call: () => Promise<unknown>) => async () => {
    await call();
    done();
  };

  if (shown.length === 0 && !controls.restorePage) return null;

  return (
    <div className="relative flex flex-col gap-2">
      {controls.restorePage && (
        <>
          <Button variant="secondary" onClick={() => restore.mutate()} disabled={restore.isPending}>
            Restore page
          </Button>
          <ErrorNote error={restore.error} />
        </>
      )}
      {shown.length > 0 && (
        <div onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <Button
            variant="secondary"
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls="lifecycle-actions"
            onClick={() => setOpen((v) => !v)}
          >
            Page actions
          </Button>
          {open && (
            <ul
              id="lifecycle-actions"
              aria-label="Page actions"
              className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
            >
              {shown.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    className="w-full rounded px-3 py-2 text-left text-sm hover:bg-slate-100"
                    onClick={() => {
                      setAction(item.key);
                      setOpen(false);
                    }}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {action === 'move' && <MoveForm page={page} spaces={spaces} onDone={done} onCancel={() => setAction(null)} />}
      {action === 'withdraw' && (
        <Confirm
          text="Withdrawing removes this page from search and from answers. Its history stays."
          label="Withdraw page"
          run={run(() => api.withdrawPage(page.id))}
          onCancel={() => setAction(null)}
        />
      )}
      {action === 'archive' && (
        <Confirm
          text="Archiving removes this page from search and from the tree. A page with live child pages cannot be archived."
          label="Archive page"
          run={run(() => api.archivePage(page.id))}
          onCancel={() => setAction(null)}
        />
      )}
    </div>
  );
}
