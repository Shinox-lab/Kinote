import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import type { SpaceResponse } from '@living-wiki/contracts';
import { loadExpanded, saveExpanded } from '../../lib/sidebar.js';
import { usePage, useSpaceTree, useSpaces, useWorkspace } from '../../lib/queries.js';
import { buildTree, canCreatePages, expandedFor, type TreeItem } from '../../lib/wiki.js';
import { errorMessage } from '../../lib/api.js';
import { BookIcon, ChevronDownIcon, ChevronRightIcon, InboxIcon, PageIcon, PlusIcon } from '../icons.js';
import { AttentionDot } from './AttentionDot.js';
import { NewPageRow } from './NewPageRow.js';
import { ROW, ROW_ACTIVE } from './NavRow.js';

/** Where "+" was pressed: a space (top level) or a page (a child). */
type Adding = { spaceId: string; parentId: string | null } | null;

const INDENT_PX = 12;
const ICON_BUTTON =
  'flex size-5 shrink-0 items-center justify-center rounded text-sm text-muted hover:bg-active';
/** Shown on row hover or when focus is inside the row, so it stays reachable by keyboard. */
const REVEAL =
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

function Chevron({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" aria-label={label} aria-expanded={open} onClick={onToggle} className={ICON_BUTTON}>
      {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
    </button>
  );
}

function PageNode({
  item,
  depth,
  spaceId,
  tenantSlug,
  canAdd,
  expanded,
  toggle,
  adding,
  setAdding,
}: {
  item: TreeItem;
  depth: number;
  spaceId: string;
  tenantSlug: string;
  canAdd: boolean;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  adding: Adding;
  setAdding: (a: Adding) => void;
}) {
  const { node, children } = item;
  const open = expanded.has(node.id);
  const hasChildren = children.length > 0;
  return (
    <li>
      <div className="group flex items-center gap-0.5" style={{ paddingLeft: `${depth * INDENT_PX}px` }}>
        {hasChildren ? (
          <Chevron open={open} label={`${open ? 'Collapse' : 'Expand'} ${node.title}`} onToggle={() => toggle(node.id)} />
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        {node.kind === 'page' ? (
          <Link
            to="/w/$tenantSlug/p/$pageId"
            params={{ tenantSlug, pageId: node.id }}
            className={`${ROW} min-w-0 flex-1`}
            activeProps={{ className: `${ROW_ACTIVE} min-w-0 flex-1` }}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-base text-muted">
              <PageIcon />
            </span>
            <span className="truncate">{node.title}</span>
            <span className="ml-auto flex items-center">
              <AttentionDot attention={node.attention} />
            </span>
          </Link>
        ) : (
          <span className={`${ROW} min-w-0 flex-1 cursor-default text-muted`}>
            <span className="flex size-5 shrink-0 items-center justify-center text-base">
              <PageIcon />
            </span>
            <span className="truncate">{node.title}</span>
          </span>
        )}
        {canAdd && node.kind === 'page' && (
          <button
            type="button"
            aria-label={`Add a page inside ${node.title}`}
            title="Add a page inside"
            className={`${ICON_BUTTON} ${REVEAL}`}
            onClick={() => {
              if (!open) toggle(node.id);
              setAdding({ spaceId, parentId: node.id });
            }}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {open && (hasChildren || (adding?.parentId === node.id)) && (
        <ul className="flex flex-col gap-px">
          {children.map((child) => (
            <PageNode
              key={child.node.id}
              item={child}
              depth={depth + 1}
              spaceId={spaceId}
              tenantSlug={tenantSlug}
              canAdd={canAdd}
              expanded={expanded}
              toggle={toggle}
              adding={adding}
              setAdding={setAdding}
            />
          ))}
          {adding?.parentId === node.id && (
            <li>
              <NewPageRow
                spaceId={spaceId}
                parentId={node.id}
                depth={depth + 1}
                onDone={() => setAdding(null)}
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function SpaceNode({
  space,
  tenantSlug,
  open,
  isCurrent,
  currentPageId,
  expanded,
  toggle,
  reveal,
  adding,
  setAdding,
}: {
  space: SpaceResponse;
  tenantSlug: string;
  open: boolean;
  isCurrent: boolean;
  currentPageId: string | undefined;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  reveal: (ids: Set<string>) => void;
  adding: Adding;
  setAdding: (a: Adding) => void;
}) {
  // The tree is fetched only once the space is opened; the space being read also polls.
  const { data, error, isPending } = useSpaceTree(space.id, { enabled: open, refetchOnFocus: true, poll: isCurrent });
  const nodes = data?.nodes;
  const items = nodes ? buildTree(nodes) : [];
  const canAdd = canCreatePages(space.myRole);

  // Opening a page reveals it: its parents open once per page, and the person can close them again.
  const revealedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!nodes || currentPageId === undefined || revealedFor.current === currentPageId) return;
    if (!nodes.some((n) => n.id === currentPageId)) return;
    revealedFor.current = currentPageId;
    const next = expandedFor(nodes, currentPageId, expanded);
    if (next.size !== expanded.size) reveal(next);
  }, [nodes, currentPageId, expanded, reveal]);

  return (
    <li>
      <div className="group flex items-center gap-0.5">
        <Chevron open={open} label={`${open ? 'Collapse' : 'Expand'} ${space.name}`} onToggle={() => toggle(space.id)} />
        <Link
          to="/w/$tenantSlug/s/$spaceSlug"
          params={{ tenantSlug, spaceSlug: space.slug }}
          className={`${ROW} min-w-0 flex-1`}
          activeProps={{ className: `${ROW_ACTIVE} min-w-0 flex-1` }}
          activeOptions={{ exact: true }}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-base text-muted">
            {space.kind === 'inbox' ? <InboxIcon /> : <BookIcon />}
          </span>
          <span className="truncate">{space.name}</span>
        </Link>
        {canAdd && (
          <button
            type="button"
            aria-label={`Add a page to ${space.name}`}
            title="Add a page"
            className={`${ICON_BUTTON} ${REVEAL}`}
            onClick={() => {
              if (!open) toggle(space.id);
              setAdding({ spaceId: space.id, parentId: null });
            }}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {open && (
        <ul className="flex flex-col gap-px">
          {isPending && <li className="px-2 py-1 pl-8 text-xs text-muted">Loading…</li>}
          {error && (
            <li role="alert" className="px-2 py-1 pl-8 text-xs text-danger">
              {errorMessage(error)}
            </li>
          )}
          {!isPending && !error && items.length === 0 && adding?.spaceId !== space.id && (
            <li className="px-2 py-1 pl-8 text-xs text-muted">No pages yet</li>
          )}
          {items.map((item) => (
            <PageNode
              key={item.node.id}
              item={item}
              depth={1}
              spaceId={space.id}
              tenantSlug={tenantSlug}
              canAdd={canAdd}
              expanded={expanded}
              toggle={toggle}
              adding={adding}
              setAdding={setAdding}
            />
          ))}
          {adding?.spaceId === space.id && adding.parentId === null && (
            <li>
              <NewPageRow spaceId={space.id} parentId={null} depth={1} onDone={() => setAdding(null)} />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** The Spaces part of the sidebar: every open space, each opening into its page tree. */
export function SpacesSection() {
  const { tenant } = useWorkspace();
  const { spaceSlug, pageId } = useParams({ strict: false });
  const { data: spaces = [] } = useSpaces();
  const { data: page } = usePage(pageId);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(tenant.id));
  const [adding, setAdding] = useState<Adding>(null);

  useEffect(() => saveExpanded(tenant.id, expanded), [tenant.id, expanded]);

  const open = spaces.filter((s) => s.archivedAt === null);
  // The space being read: the page's, or the one named in the address.
  const currentSpaceId = pageId !== undefined ? page?.spaceId : open.find((s) => s.slug === spaceSlug)?.id;

  // Going to a page (or a space) opens its space once per visit, so the page is never hidden in a closed one;
  // the person can close it again, and the next page they go to opens it once more.
  const openedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const visit = currentSpaceId === undefined ? undefined : `${currentSpaceId}:${pageId ?? ''}`;
    if (currentSpaceId === undefined || openedFor.current === visit) return;
    openedFor.current = visit;
    setExpanded((prev) => (prev.has(currentSpaceId) ? prev : new Set(prev).add(currentSpaceId)));
  }, [currentSpaceId, pageId]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  if (open.length === 0) return null;
  return (
    <>
      <h2 className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted">Spaces</h2>
      <ul className="flex flex-col gap-px">
        {open.map((space) => (
          <SpaceNode
            key={space.id}
            space={space}
            tenantSlug={tenant.slug}
            open={expanded.has(space.id)}
            isCurrent={space.id === currentSpaceId}
            currentPageId={pageId}
            expanded={expanded}
            toggle={toggle}
            reveal={setExpanded}
            adding={adding}
            setAdding={setAdding}
          />
        ))}
      </ul>
    </>
  );
}
