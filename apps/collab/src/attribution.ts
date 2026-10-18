import * as Y from 'yjs';
import { BLOCK_FRAGMENT } from './fragment.js';

/**
 * Which BlockNote blocks a Yjs transaction changed, and whether it changed the
 * page at all.
 *
 * A page's fragment is BlockNote's ProseMirror tree mirrored in Yjs:
 *
 *   XmlFragment(BLOCK_FRAGMENT)
 *     blockGroup
 *       blockContainer {id}
 *         <content element named by the block type, e.g. paragraph> > XmlText
 *         blockGroup?            (nested children, same shape again)
 *
 * The title lives in the `meta` map, outside the fragment.
 */

const BLOCK_CONTAINER = 'blockContainer';
const META = 'meta';

type AnyType = Y.AbstractType<any>;

function parentOf(type: AnyType): AnyType | null {
  const parent = type._item?.parent;
  return parent instanceof Y.AbstractType ? parent : null;
}

/** True when the type, or any type it sits in, has been deleted. */
function isDeleted(type: AnyType): boolean {
  for (let t: AnyType | null = type; t; t = parentOf(t)) {
    if (t._item?.deleted) return true;
  }
  return false;
}

/** The nearest `blockContainer` at or above `type`, or null (root, meta, ...). */
function nearestContainer(type: AnyType): Y.XmlElement | null {
  for (let t: AnyType | null = type; t; t = parentOf(t)) {
    if (t instanceof Y.XmlElement && t.nodeName === BLOCK_CONTAINER) return t;
  }
  return null;
}

function rootOf(type: AnyType): AnyType {
  let t = type;
  for (let p = parentOf(t); p; p = parentOf(t)) t = p;
  return t;
}

/** Adds the id of every live `blockContainer` in `type`'s subtree (itself included). */
function collectContainers(type: AnyType, ids: Set<string>): void {
  if (type instanceof Y.XmlElement && type.nodeName === BLOCK_CONTAINER) {
    const id = type.getAttribute('id');
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment) {
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement) collectContainers(child, ids);
    }
  }
}

/** Created by this transaction (Yjs leaves new types out of `tx.changed`). */
function isNew(tx: Y.Transaction, item: Y.Item): boolean {
  return item.id.clock >= (tx.beforeState.get(item.id.client) ?? 0);
}

/**
 * The ids of the blocks a transaction changed, each once, in no set order.
 *
 * - A change inside an existing type (text typed, a mark, an attribute, a
 *   child added to or removed from it) names the nearest `blockContainer`
 *   at or above it: editing a nested child names the child only.
 * - Types created in the transaction are not in `tx.changed`; their parent
 *   is. Each live container inside such a new subtree is named too, so a new
 *   block (or a whole replaced fragment) is attributed to whoever wrote it.
 * - A deleted block names nothing itself: removing a top-level block changes
 *   only the root `blockGroup` (no container above it); removing a nested
 *   child names its parent, whose content did change.
 */
export function changedBlockIds(tx: Y.Transaction): string[] {
  const ids = new Set<string>();
  for (const type of tx.changed.keys()) {
    if (isDeleted(type)) continue;
    const container = nearestContainer(type);
    if (container) {
      const id = container.getAttribute('id');
      if (typeof id === 'string' && id !== '') ids.add(id);
    }
    if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment) {
      for (let item = type._start; item; item = item.right) {
        if (item.deleted || !isNew(tx, item)) continue;
        if (item.content instanceof Y.ContentType) collectContainers(item.content.type, ids);
      }
    }
  }
  return [...ids];
}

/**
 * True when the transaction changed the page: its block fragment or its
 * `meta` map (the title). Other shared types of the document are not page
 * content and are not attributed.
 */
export function changesPage(tx: Y.Transaction): boolean {
  const fragment = tx.doc.share.get(BLOCK_FRAGMENT);
  const meta = tx.doc.share.get(META);
  for (const type of tx.changed.keys()) {
    const root = rootOf(type);
    if ((fragment && root === fragment) || (meta && root === meta)) return true;
  }
  return false;
}
