import * as Y from 'yjs';
import { createServerEditor } from '@living-wiki/shared';
import { AppError } from '@living-wiki/contracts';
import { blockFullText, type BlockLike } from '@living-wiki/shared';
import { BLOCK_FRAGMENT } from './fragment.js';

/**
 * One change to a page's top-level blocks. Nested children travel with their
 * parent; ops never address them.
 * - `insert_after`: `after` null inserts at the start.
 * - `replace`: the first new block keeps `blockId`, so citations and
 *   activity stay attached to it, and keeps the old block's nested children
 *   (a replace changes one block, never what sits under it).
 * - `expectedText` (replace, remove): the block's text with its children
 *   (`blockFullText`) when the caller planned the op; anything else means
 *   someone changed it since, and nothing is applied (`block_changed`).
 */
export type BlockOp =
  | { op: 'insert_after'; after: string | null; blocks: unknown[] }
  | { op: 'replace'; blockId: string; blocks: unknown[]; expectedText?: string }
  | { op: 'remove'; blockId: string; expectedText?: string };

const BLOCK_CONTAINER = 'blockContainer';
const BLOCK_GROUP = 'blockGroup';

const blockNote = createServerEditor();

/** The fragment's top-level blockGroup, or null on a page that has never had content. */
function rootGroup(fragment: Y.XmlFragment): Y.XmlElement | null {
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === BLOCK_GROUP) return child;
  }
  return null;
}

function indexOf(group: Y.XmlElement, blockId: string): number {
  return group
    .toArray()
    .findIndex((c) => c instanceof Y.XmlElement && c.nodeName === BLOCK_CONTAINER && c.getAttribute('id') === blockId);
}

/** BlockNote blocks as detached `blockContainer`s, ready to insert. */
function containers(blocks: unknown[]): Y.XmlElement[] {
  const scratch = new Y.Doc().getXmlFragment(BLOCK_FRAGMENT);
  blockNote.blocksToYXmlFragment(blocks as any, scratch);
  const group = rootGroup(scratch);
  if (!group) return [];
  return group.toArray().map((c) => (c as Y.XmlElement).clone());
}

/**
 * Applies `ops` in order to a page fragment. Every addressed block is checked
 * first: one missing id throws `block_not_found` before anything changes.
 * Call it inside one Yjs transaction so the ops land as one change.
 */
export function applyBlockOps(fragment: Y.XmlFragment, ops: BlockOp[]): void {
  let group = rootGroup(fragment);
  const ids = new Set(
    group
      ? group
          .toArray()
          .filter((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === BLOCK_CONTAINER)
          .map((c) => c.getAttribute('id'))
      : []
  );
  // Ops apply in order, so a later op may address a block an earlier one added.
  for (const op of ops) {
    const target = op.op === 'insert_after' ? op.after : op.blockId;
    if (target !== null && !ids.has(target)) throw new AppError('block_not_found');
    if (op.op === 'remove') ids.delete(op.blockId);
    else for (const b of op.blocks) ids.add((b as { id?: string }).id);
  }
  if (ops.some((op) => op.op !== 'insert_after' && op.expectedText !== undefined)) {
    const current = new Map(
      (blockNote.yXmlFragmentToBlocks(fragment) as BlockLike[]).map((b) => [b.id, blockFullText(b)])
    );
    for (const op of ops) {
      if (op.op === 'insert_after' || op.expectedText === undefined) continue;
      // A block an earlier op of this call added has no planned text to compare.
      if (current.has(op.blockId) && current.get(op.blockId) !== op.expectedText) {
        throw new AppError('block_changed');
      }
    }
  }
  const prepared = ops.map((op) => (op.op === 'remove' ? [] : containers(op.blocks)));

  ops.forEach((op, i) => {
    const fresh = prepared[i]!;
    if (!group) {
      // An empty page: the first insert brings the blockGroup itself.
      blockNote.blocksToYXmlFragment((op as { blocks: unknown[] }).blocks as any, fragment);
      group = rootGroup(fragment);
      return;
    }
    if (op.op === 'insert_after') {
      const at = op.after === null ? 0 : indexOf(group, op.after) + 1;
      group.insert(at, fresh);
    } else if (op.op === 'replace') {
      const at = indexOf(group, op.blockId);
      const old = group.get(at) as Y.XmlElement;
      const children = old
        .toArray()
        .find((c): c is Y.XmlElement => c instanceof Y.XmlElement && c.nodeName === BLOCK_GROUP);
      const first = fresh[0];
      if (first) {
        first.setAttribute('id', op.blockId);
        const hasOwn = first.toArray().some((c) => c instanceof Y.XmlElement && c.nodeName === BLOCK_GROUP);
        if (children && !hasOwn) first.push([children.clone()]);
      }
      group.delete(at, 1);
      group.insert(at, fresh);
    } else {
      group.delete(indexOf(group, op.blockId), 1);
    }
  });
}
