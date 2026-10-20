import type { SpaceRole, TreeNode } from '@living-wiki/contracts';

// Pure helpers behind the wiki screens: the page tree, author colours and names,
// and which controls a page shows. The badge text always comes from the server;
// nothing here derives a status from page content.

// --- Tree -----------------------------------------------------------------------

export interface TreeItem {
  node: TreeNode;
  children: TreeItem[];
}

/** Plain code-unit order: positions are fractional-index strings, which locale order would scramble. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function bySiblingOrder(a: TreeNode, b: TreeNode): number {
  return compare(a.position, b.position) || compare(a.title, b.title) || compare(a.id, b.id);
}

/**
 * The flat node list as a forest. Siblings are ordered by position, title, id; a node
 * whose parent is not in the list (hidden, archived) becomes a root, so nothing vanishes.
 */
export function buildTree(nodes: readonly TreeNode[]): TreeItem[] {
  const items = new Map<string, TreeItem>(nodes.map((node) => [node.id, { node, children: [] }]));
  const roots: TreeItem[] = [];
  for (const item of items.values()) {
    const parent = item.node.parentId === null ? undefined : items.get(item.node.parentId);
    (parent ? parent.children : roots).push(item);
  }
  const order = (list: TreeItem[]) => {
    list.sort((a, b) => bySiblingOrder(a.node, b.node));
    list.forEach((item) => order(item.children));
  };
  order(roots);
  return roots;
}

/** Ids of every node below `id` (not `id` itself): the parents a page may not be moved under. */
export function descendantIds(nodes: readonly TreeNode[], id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const n of nodes) {
      if (n.parentId === current && !found.has(n.id)) {
        found.add(n.id);
        queue.push(n.id);
      }
    }
  }
  return found;
}

/** What a status dot means, in words (the dot is colour, so the words are its accessible name). */
export function attentionLabel(attention: NonNullable<TreeNode['attention']>): string {
  switch (attention) {
    case 'failed':
      return 'Indexing failed';
    case 'review':
      return 'Waiting for review';
    case 'editing':
      return 'Edited just now';
  }
}

/** Whether a space role may add pages (the server decides; this only shows or hides the "+"). */
export function canCreatePages(role: SpaceRole | undefined): boolean {
  return role === 'editor' || role === 'reviewer' || role === 'admin';
}

/** The parents of `id`, from the root down (not `id` itself); empty for a root or an unknown id. */
export function ancestorIds(nodes: readonly TreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId !== null && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    chain.unshift(parentId);
    parentId = byId.get(parentId)!.parentId;
  }
  return chain;
}

/** The nodes to show open: what the person opened, plus the parents of the current page so it is never hidden. */
export function expandedFor(
  nodes: readonly TreeNode[],
  currentPageId: string | undefined,
  saved: ReadonlySet<string>
): Set<string> {
  const open = new Set(saved);
  if (currentPageId !== undefined) for (const id of ancestorIds(nodes, currentPageId)) open.add(id);
  return open;
}

// --- Authors --------------------------------------------------------------------

export interface AuthorColor {
  /** A CSS colour for text, borders and dots (a theme token, so it reads in light and dark). */
  accent: string;
  /** A soft wash of the same hue for backgrounds. */
  tint: string;
}

/** FNV-1a over UTF-16 code units: small, stable and well spread for ids. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The theme has this many author colours (--author-0 to --author-7, each with a -tint). */
const AUTHOR_SLOTS = 8;

/** A stable colour for an author id: the same id is the same theme token in every session, in light and dark. */
export function authorColor(authorId: string): AuthorColor {
  const slot = hash32(authorId) % AUTHOR_SLOTS;
  return { accent: `var(--author-${slot})`, tint: `var(--author-${slot}-tint)` };
}

export interface Author {
  type: 'user' | 'agent';
  id: string;
  /** The display name the server sent with the change (every role gets it). */
  name?: string;
}

export interface AuthorLabel {
  name: string;
  isAgent: boolean;
}

/**
 * What to show for the author of a change: the signed-in user is "You", then the
 * name the server sent, then a name from the members list; anyone else gets a
 * neutral name with a short id suffix.
 */
export function authorLabel(
  author: Author | undefined,
  names: ReadonlyMap<string, string>,
  selfId: string | null
): AuthorLabel {
  if (!author) return { name: 'Unknown author', isAgent: false };
  const isAgent = author.type === 'agent';
  if (!isAgent && author.id === selfId) return { name: 'You', isAgent };
  const known = author.name || names.get(author.id);
  if (known) return { name: known, isAgent };
  return { name: `${isAgent ? 'Agent' : 'Collaborator'} ${author.id.slice(-4)}`, isAgent };
}

/** An id inside a double-quoted CSS attribute selector: backslash, quote and line breaks escaped. */
function cssString(text: string): string {
  return text.replace(/[\\"]/g, '\\$&').replace(/\r?\n/g, '\\a ');
}

/**
 * The entries worth showing as changes: not the unchanged ones, and not a blank
 * added block (the editor always keeps an empty block at the end of a page).
 */
export function visibleChanges<T extends { change: string; after?: string }>(entries: readonly T[]): T[] {
  return entries.filter((e) => e.change !== 'unchanged' && !(e.change === 'added' && (e.after ?? '').trim() === ''));
}

/**
 * CSS that washes each added or changed block of the page in its author's colour
 * (a left rule and a tint), matching the colours of the changes list. BlockNote
 * puts the block id in `data-id`. Blocks with no recorded author get a neutral wash.
 */
export function blockHighlightCss(
  entries: ReadonlyArray<{ blockId: string; change: string; after?: string; author?: { id: string } }>
): string {
  return visibleChanges(entries)
    .filter((e) => e.change === 'added' || e.change === 'changed')
    .map((e) => {
      const color = e.author ? authorColor(e.author.id) : { accent: 'var(--muted)', tint: 'var(--hover)' };
      return (
        `[data-id="${cssString(e.blockId)}"] > .bn-block > .bn-block-content ` +
        `{ box-shadow: inset 3px 0 0 ${color.accent}; background: ${color.tint}; border-radius: 3px; padding-left: 8px; }`
      );
    })
    .join('\n');
}

// --- Badge and controls ---------------------------------------------------------

export type BadgeTone = 'ok' | 'danger' | 'muted' | 'pending';

/** Colour for a server badge. Only styling: what the badge means is the server's call. */
export function badgeTone(badge: string): BadgeTone {
  if (badge === 'Index failed' || badge === 'Extraction failed') return 'danger';
  if (badge.startsWith('Indexed ·')) return 'ok';
  if (
    badge === 'Withdrawn' ||
    badge === 'Removed at source' ||
    badge === 'Stored · no searchable text' ||
    badge.startsWith('Not indexed ·')
  ) {
    return 'muted';
  }
  return 'pending';
}

/**
 * True while the server will move the page on by itself (the worker is indexing it, or
 * the quiet period before indexing is running), so the page is worth fetching again soon.
 * Only decides when to look again: what the badge says is still the server's.
 */
export function badgeSettles(badge: string): boolean {
  return (
    badge === 'Indexing…' ||
    badge === 'Saved · indexing soon' ||
    badge === 'Reading text…' ||
    // A file whose newer version is being read or indexed while an older one answers search.
    (badge.startsWith('Indexed ·') && (badge.endsWith(' being read') || badge.endsWith(' indexing')))
  );
}

/** How often a page whose badge is still settling is fetched again. */
export const PAGE_POLL_MS = 3000;
/** Longest a page is polled while its badge keeps settling (a stopped worker never settles it). */
export const PAGE_POLL_MAX_MS = 120_000;

/**
 * The page's next poll: every PAGE_POLL_MS while `badge` settles, for at most
 * PAGE_POLL_MAX_MS of continuous settling counted from `since` (when settling
 * was first seen; null when it was not). A badge that is not settling stops
 * polling and clears `since`. Returns the new `since` with the interval.
 */
export function pagePoll(
  since: number | null,
  badge: string | undefined,
  now: number
): { since: number | null; interval: number | false } {
  if (badge === undefined || !badgeSettles(badge)) return { since: null, interval: false };
  const start = since ?? now;
  return { since: start, interval: now - start < PAGE_POLL_MAX_MS ? PAGE_POLL_MS : false };
}

export interface PageControlsInput {
  /** The server's badge for the page. */
  badge: string;
  /** The actor's role on the page's space; null when unknown. */
  role: SpaceRole | null;
  reviewRequired: boolean;
  /** The page or its space is archived. */
  archived: boolean;
}

export interface PageControls {
  /** Label of the one snapshot button; null when the actor may not snapshot. */
  primary: 'Index now' | 'Submit for review' | null;
  retry: boolean;
  restoreIndexed: boolean;
  move: boolean;
  withdraw: boolean;
  archive: boolean;
  restorePage: boolean;
  /** Restoring an older version as a new change (editor, live page). */
  restoreVersion: boolean;
}

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, reviewer: 2, admin: 3 };

/**
 * Which controls to show. The server enforces every one of these again; hiding is
 * only so a person is not offered what would be refused. Roles mirror the routes:
 * snapshot, retry, restore (of a page version too) and move need editor, withdraw reviewer, archive and
 * restoring an archived page admin.
 */
export function pageControls({ badge, role, reviewRequired, archived }: PageControlsInput): PageControls {
  const rank = role === null ? -1 : RANK[role];
  const live = !archived;
  const editor = live && rank >= RANK.editor;
  return {
    primary: editor ? (reviewRequired ? 'Submit for review' : 'Index now') : null,
    retry: editor && badge === 'Index failed',
    restoreIndexed: editor && badge.startsWith('Not indexed ·'),
    move: editor,
    withdraw: live && rank >= RANK.reviewer,
    archive: live && rank >= RANK.admin,
    restorePage: archived && rank >= RANK.admin,
    restoreVersion: editor,
  };
}
