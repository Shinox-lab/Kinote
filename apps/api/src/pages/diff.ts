import { flattenBlocks, type BlockLike, type FlatBlock } from '@living-wiki/shared';
import type { BlockDiffEntry } from '@living-wiki/contracts';

export type { BlockDiffEntry };

/** The last actor recorded for a block (a `block_activity` row). */
export interface BlockActivityLike {
  blockId: string;
  actorType: 'user' | 'agent';
  actorId: string;
}

function sameContent(a: FlatBlock, b: FlatBlock): boolean {
  return a.type === b.type && a.level === b.level && a.text === b.text;
}

/**
 * Block-level diff of two block lists, aligned by block id (nested children
 * are flattened in document order, see `flattenBlocks`).
 *
 * - The result follows `after`'s order. A block removed since `before` is
 *   placed right after its nearest predecessor in `before` that survives in
 *   `after` (first of all when no predecessor survives); removed blocks that
 *   share an anchor keep their `before` order.
 * - Position and nesting are not content: a pure reorder is all `unchanged`.
 *   A different text, type or heading level is `changed` (with `before` and
 *   `after` text); an id only in `after` is `added`, only in `before`
 *   `removed`. `unchanged` carries the `after` text.
 * - `author` comes from `activity` and is attached to `added` and `changed`
 *   blocks only.
 */
export function diffBlocks(
  before: BlockLike[],
  after: BlockLike[],
  activity: BlockActivityLike[]
): BlockDiffEntry[] {
  const flatBefore = flattenBlocks(before);
  const flatAfter = flattenBlocks(after);

  const beforeById = new Map<string, FlatBlock>();
  for (const b of flatBefore) if (!beforeById.has(b.id)) beforeById.set(b.id, b);
  const afterIds = new Set(flatAfter.map((b) => b.id));

  const actorById = new Map<string, BlockActivityLike>();
  for (const a of activity) if (!actorById.has(a.blockId)) actorById.set(a.blockId, a);
  const authorOf = (blockId: string): BlockDiffEntry['author'] => {
    const a = actorById.get(blockId);
    return a ? { type: a.actorType, id: a.actorId } : undefined;
  };

  // Removed blocks, grouped under the nearest surviving predecessor ('' = none).
  const removedAfter = new Map<string, FlatBlock[]>();
  let anchor = '';
  for (const b of flatBefore) {
    if (afterIds.has(b.id)) {
      anchor = b.id;
    } else {
      const group = removedAfter.get(anchor) ?? [];
      group.push(b);
      removedAfter.set(anchor, group);
    }
  }
  const removedEntries = (key: string): BlockDiffEntry[] =>
    (removedAfter.get(key) ?? []).map((b) => ({
      blockId: b.id,
      change: 'removed',
      type: b.type,
      ...(b.level !== undefined ? { level: b.level } : {}),
      depth: b.depth,
      before: b.text,
    }));

  const out: BlockDiffEntry[] = [...removedEntries('')];
  const seen = new Set<string>();
  for (const b of flatAfter) {
    if (seen.has(b.id)) continue; // a duplicated id is reported once
    seen.add(b.id);
    const old = beforeById.get(b.id);
    let entry: BlockDiffEntry;
    const shape = {
      type: b.type,
      ...(b.level !== undefined ? { level: b.level } : {}),
      depth: b.depth,
    };
    if (!old) {
      entry = { blockId: b.id, change: 'added', ...shape, after: b.text };
    } else if (sameContent(old, b)) {
      entry = { blockId: b.id, change: 'unchanged', ...shape, after: b.text };
    } else {
      entry = { blockId: b.id, change: 'changed', ...shape, before: old.text, after: b.text };
    }
    if (entry.change === 'added' || entry.change === 'changed') {
      const author = authorOf(b.id);
      if (author) entry.author = author;
    }
    out.push(entry, ...removedEntries(b.id));
  }
  return out;
}
