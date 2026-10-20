import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { MovePageRequest, SpaceResponse } from '@living-wiki/contracts';
import { useSpaceTree } from '../lib/queries.js';
import { buildTree, descendantIds, type TreeItem } from '../lib/wiki.js';
import { Button, ErrorNote, SelectField } from './ui.js';

// The pieces the page's and the file's "…" menus share: a move form and a one-step confirmation.

/** The pages of a tree as select options, indented by depth. */
export function parentOptions(items: TreeItem[], skip: Set<string>, depth = 0): { value: string; label: string }[] {
  return items.flatMap(({ node, children }) =>
    node.kind !== 'page' || skip.has(node.id)
      ? []
      : [{ value: node.id, label: `${'— '.repeat(depth)}${node.title}` }, ...parentOptions(children, skip, depth + 1)]
  );
}

export const TOP_LEVEL = '';

/** The floating panel under the "…" button that holds an action's form. */
export const PANEL = 'absolute right-0 top-full z-20 mt-1 w-80 max-w-[90vw] rounded-lg border border-line bg-surface p-3 shadow-pop';

/** Moves the page to a space (one it can edit) and a parent page there. */
export function MoveForm({
  page,
  spaces,
  noun,
  run,
  onDone,
  onCancel,
}: {
  /** What is being moved: its id, space and parent. */
  page: { id: string; spaceId: string; parentId: string | null };
  spaces: SpaceResponse[];
  /** "page" or "file", for the button. */
  noun: 'page' | 'file';
  run: (body: MovePageRequest) => Promise<unknown>;
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
    mutationFn: () => run({ target_space_id: spaceId, target_parent_id: parent === TOP_LEVEL ? null : parent }),
    onSuccess: onDone,
  });

  return (
    <form
      className="flex flex-col gap-3"
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
          Move {noun}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A one-step confirmation for an action that removes the page from search. */
export function Confirm({
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
    <div className="flex flex-col gap-3">
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

