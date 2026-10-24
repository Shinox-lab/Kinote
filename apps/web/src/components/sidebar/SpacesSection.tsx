import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { SpaceResponse } from '@living-wiki/contracts';
import { useUploads } from '../../lib/useUploads.js';
import { loadExpanded, saveExpanded } from '../../lib/sidebar.js';
import { useFile, usePage, useRefresh, useSpaceTree, useSpaces, useWorkspace } from '../../lib/queries.js';
import { buildTree, canCreatePages, expandedFor, type TreeItem } from '../../lib/wiki.js';
import { api, errorMessage } from '../../lib/api.js';
import { canAdminister } from '../../lib/console.js';
import { BookIcon, ChevronDownIcon, ChevronRightIcon, FileIcon, InboxIcon, PageIcon, PlusIcon } from '../icons.js';
import { AddMenu } from '../AddMenu.js';
import { DocumentLink } from '../DocumentLink.js';
import { AttentionDot } from './AttentionDot.js';
import { ContextMenu, ContextMenuItem } from './ContextMenu.js';
import { NewPageRow } from './NewPageRow.js';
import { NewSpaceRow } from './NewSpaceRow.js';
import { TitleInput } from './TitleInput.js';
import { ROW, ROW_ACTIVE } from './NavRow.js';

/** Where "+" was pressed: a space (top level) or a page (a child). */
type Adding = { spaceId: string; parentId: string | null } | null;

/** The row being renamed, and the name it has now. */
type Renaming = { id: string; kind: 'page' | 'file'; title: string } | null;

/** The row whose menu is open, and where the pointer was. */
type Menu = { id: string; kind: 'page' | 'file'; title: string; canRename: boolean; x: number; y: number } | null;

/** What is being dragged: a page or a file. */
interface Dragged {
  id: string;
  kind: 'page' | 'file';
}

/** The mime type the drag carries; the browser only lets the console read its own. */
const DRAG_TYPE = 'application/x-living-wiki-node';

const INDENT_PX = 12;
const ICON_BUTTON =
  'flex size-5 shrink-0 items-center justify-center rounded text-sm text-muted hover:bg-active';
/** Shown on row hover or when focus is inside the row, so it stays reachable by keyboard. */
const REVEAL =
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

/** What the drag carries, if it is ours. */
function readDragged(e: DragEvent): Dragged | null {
  const raw = e.dataTransfer.getData(DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Dragged;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** True while a document of ours is over the row. */
function carriesNode(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(DRAG_TYPE);
}

/** What the tree does with a right-click, a drag and a rename. */
interface TreeActions {
  /** The row being renamed, if any. */
  renaming: Renaming;
  /** Starts a rename, or cancels it (null). */
  setRenaming: (r: Renaming) => void;
  /** Saves a new name for a row. */
  saveRename: (node: Dragged & { title: string }) => void;
  /** Opens the row's menu where the pointer was. */
  openMenu: (e: MouseEvent, node: Dragged & { title: string; canRename: boolean }) => void;
  /** Moves the dragged document under (or into) the target. */
  drop: (e: DragEvent, target: { spaceId: string; parentId: string | null }) => void;
}

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
  actions,
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
  actions: TreeActions;
}) {
  const { node, children } = item;
  const { enqueue } = useUploads();
  const open = expanded.has(node.id);
  const hasChildren = children.length > 0;
  const renaming = actions.renaming?.id === node.id;
  // Only a page can hold children, so only a page row takes a drop.
  const takesDrop = node.kind === 'page';
  return (
    <li>
      <div
        className="group flex items-center gap-0.5"
        style={{ paddingLeft: `${depth * INDENT_PX}px` }}
        onDragOver={(e) => {
          if (!takesDrop || !carriesNode(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          // A file row takes no drop: the page stays where it is.
          e.stopPropagation();
          if (!takesDrop) return;
          actions.drop(e, { spaceId, parentId: node.id });
        }}
      >
        {hasChildren ? (
          <Chevron open={open} label={`${open ? 'Collapse' : 'Expand'} ${node.title}`} onToggle={() => toggle(node.id)} />
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        {renaming ? (
          <TitleInput
            title={actions.renaming!.title}
            onSave={(title) => actions.saveRename({ id: node.id, kind: node.kind, title })}
            onCancel={() => actions.setRenaming(null)}
          />
        ) : (
          <DocumentLink
            tenantSlug={tenantSlug}
            kind={node.kind}
            id={node.id}
            className={`${ROW} min-w-0 flex-1`}
            activeClassName={`${ROW_ACTIVE} min-w-0 flex-1`}
            draggable={canAdd}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: node.id, kind: node.kind }));
              e.dataTransfer.effectAllowed = 'move';
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              actions.openMenu(e, { id: node.id, kind: node.kind, title: node.title, canRename: canAdd });
            }}
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-base text-muted">
              {node.kind === 'file' ? (
                <FileIcon />
              ) : node.icon ? (
                <span aria-hidden="true">{node.icon}</span>
              ) : (
                <PageIcon />
              )}
            </span>
            <span className="truncate">{node.title}</span>
            <span className="ml-auto flex items-center">
              <AttentionDot attention={node.attention} />
            </span>
          </DocumentLink>
        )}
        {canAdd && node.kind === 'page' && !renaming && (
          <AddMenu
            label={node.title}
            className={`${ICON_BUTTON} ${REVEAL}`}
            onNewPage={() => {
              if (!open) toggle(node.id);
              setAdding({ spaceId, parentId: node.id });
            }}
            onFiles={(picked) => {
              if (!open) toggle(node.id);
              enqueue(picked, { spaceId, parentId: node.id });
            }}
          />
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
              actions={actions}
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
  active,
  isCurrent,
  currentPageId,
  expanded,
  toggle,
  reveal,
  adding,
  setAdding,
  actions,
}: {
  space: SpaceResponse;
  tenantSlug: string;
  open: boolean;
  /** The space's own screen is open. */
  active: boolean;
  isCurrent: boolean;
  currentPageId: string | undefined;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  reveal: (ids: Set<string>) => void;
  adding: Adding;
  setAdding: (a: Adding) => void;
  actions: TreeActions;
}) {
  // The tree is fetched only once the space is opened; the space being read also polls.
  const { data, error, isPending } = useSpaceTree(space.id, { enabled: open, refetchOnFocus: true, poll: isCurrent });
  const nodes = data?.nodes;
  const { enqueue } = useUploads();
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
      <div
        className="group flex items-center gap-0.5"
        onDragOver={(e) => {
          if (!carriesNode(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => actions.drop(e, { spaceId: space.id, parentId: null })}
      >
        {/* The space row is a toggle, not a link: it opens and closes the tree. */}
        <button
          type="button"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${space.name}`}
          aria-expanded={open}
          onClick={() => toggle(space.id)}
          className={`${ROW} min-w-0 flex-1 ${active ? ROW_ACTIVE : ''}`}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-base text-muted" aria-hidden="true">
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
          <span className="flex size-5 shrink-0 items-center justify-center text-base text-muted" aria-hidden="true">
            {space.kind === 'inbox' ? <InboxIcon /> : <BookIcon />}
          </span>
          <span className="truncate">{space.name}</span>
        </button>
        {canAdd && (
          <AddMenu
            label={space.name}
            className={`${ICON_BUTTON} ${REVEAL}`}
            onNewPage={() => {
              if (!open) toggle(space.id);
              setAdding({ spaceId: space.id, parentId: null });
            }}
            onFiles={(picked) => {
              if (!open) toggle(space.id);
              enqueue(picked, { spaceId: space.id, parentId: null });
            }}
          />
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
              actions={actions}
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
  const { tenant, role } = useWorkspace();
  const { spaceSlug, pageId, fileId } = useParams({ strict: false });
  const { data: spaces = [] } = useSpaces();
  const { data: page } = usePage(pageId);
  const { data: file } = useFile(fileId);
  const refresh = useRefresh();
  // The document being read, a page or a file: its space opens and its row is revealed.
  const currentDocId = pageId ?? fileId;
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(tenant.id));
  const [adding, setAdding] = useState<Adding>(null);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);

  useEffect(() => saveExpanded(tenant.id, expanded), [tenant.id, expanded]);

  const open = spaces.filter((s) => s.archivedAt === null);
  // The space being read: the page's, or the one named in the address.
  const currentSpaceId =
    pageId !== undefined ? page?.spaceId : fileId !== undefined ? file?.spaceId : open.find((s) => s.slug === spaceSlug)?.id;

  // Going to a page (or a space) opens its space once per visit, so the page is never hidden in a closed one;
  // the person can close it again, and the next page they go to opens it once more.
  const openedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const visit = currentSpaceId === undefined ? undefined : `${currentSpaceId}:${currentDocId ?? ''}`;
    if (currentSpaceId === undefined || openedFor.current === visit) return;
    openedFor.current = visit;
    setExpanded((prev) => (prev.has(currentSpaceId) ? prev : new Set(prev).add(currentSpaceId)));
  }, [currentSpaceId, currentDocId]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const move = useMutation({
    mutationFn: (target: Dragged & { spaceId: string; parentId: string | null }) => {
      const body = { target_space_id: target.spaceId, target_parent_id: target.parentId };
      return target.kind === 'page' ? api.movePage(target.id, body) : api.moveFile(target.id, body);
    },
    onSuccess: () => {
      void refresh('tree');
    },
  });

  const rename = useMutation({
    mutationFn: (node: { id: string; kind: 'page' | 'file'; title: string }) =>
      node.kind === 'page' ? api.renamePage(node.id, node.title) : api.renameFile(node.id, node.title),
    onSuccess: (_res, node) => {
      void refresh('tree');
      void refresh(node.kind === 'page' ? 'page' : 'file');
    },
  });

  const actions: TreeActions = {
    renaming,
    setRenaming,
    saveRename: (node) => {
      setRenaming(null);
      rename.mutate(node);
    },
    openMenu: (e, node) => {
      const at = e.currentTarget as HTMLElement | null;
      const box = at?.getBoundingClientRect();
      setMenu({
        ...node,
        // A keyboard menu (the Menu key) has no pointer position: the row's own place is used.
        x: e.clientX || (box?.left ?? 0),
        y: e.clientY || (box?.bottom ?? 0),
      });
    },
    drop: (e, target) => {
      if (!carriesNode(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const dragged = readDragged(e);
      if (!dragged) return;
      move.mutate({ ...dragged, ...target });
    },
  };

  if (open.length === 0) return null;
  return (
    <>
      <div className="flex items-center justify-between px-2 pb-1 pt-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Spaces</h2>
        {canAdminister(role) && !creatingSpace && (
          <button
            type="button"
            aria-label="New space"
            title="New space"
            className={ICON_BUTTON}
            onClick={() => setCreatingSpace(true)}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {(move.error ?? rename.error) && (
        <p role="alert" className="px-2 pb-1 text-xs text-danger">
          {errorMessage(move.error ?? rename.error)}
        </p>
      )}
      <ul className="flex flex-col gap-px">
        {creatingSpace && (
          <li className="px-2 py-1">
            <NewSpaceRow
              onDone={(spaceId) => {
                setCreatingSpace(false);
                if (spaceId) setExpanded((prev) => new Set(prev).add(spaceId));
              }}
            />
          </li>
        )}
        {open.map((space) => (
          <SpaceNode
            key={space.id}
            space={space}
            tenantSlug={tenant.slug}
            open={expanded.has(space.id)}
            active={space.slug === spaceSlug}
            isCurrent={space.id === currentSpaceId}
            currentPageId={currentDocId}
            expanded={expanded}
            toggle={toggle}
            reveal={setExpanded}
            adding={adding}
            setAdding={setAdding}
            actions={actions}
          />
        ))}
      </ul>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={menu.title} onClose={() => setMenu(null)}>
          {menu.canRename && (
            <ContextMenuItem
              label="Rename"
              onSelect={() => {
                setRenaming({ id: menu.id, kind: menu.kind, title: menu.title });
                setMenu(null);
              }}
            />
          )}
        </ContextMenu>
      )}
    </>
  );
}
