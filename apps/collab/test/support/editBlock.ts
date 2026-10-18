import * as Y from 'yjs';
import { BLOCK_FRAGMENT } from '../../src/fragment.js';

/** The `blockContainer` element with `id` in the page fragment, or null. */
export function findBlockContainer(doc: Y.Doc, blockId: string): Y.XmlElement | null {
  const visit = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'blockContainer' && child.getAttribute('id') === blockId) return child;
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(doc.getXmlFragment(BLOCK_FRAGMENT));
}

/**
 * Appends `text` to a block's inline content, editing the Yjs fragment
 * directly the way a BlockNote client's y-prosemirror binding does: the
 * block's `blockContainer` holds its content element (named by the block
 * type, e.g. `paragraph`) whose `Y.XmlText` gets the insert. One transaction.
 */
export function editBlockText(doc: Y.Doc, blockId: string, text: string): void {
  const container = findBlockContainer(doc, blockId);
  if (!container) throw new Error(`no block ${blockId} in the document`);
  const content = container.toArray().find((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  if (!content || content.nodeName === 'blockGroup') {
    throw new Error(`block ${blockId} has no inline content element`);
  }
  doc.transact(() => {
    let inline = content.toArray().find((c): c is Y.XmlText => c instanceof Y.XmlText);
    if (!inline) {
      inline = new Y.XmlText();
      content.insert(0, [inline]);
    }
    inline.insert(inline.length, text);
  });
}

/** Deletes a block (and its children) from the fragment, in one transaction. */
export function deleteBlock(doc: Y.Doc, blockId: string): void {
  const container = findBlockContainer(doc, blockId);
  if (!container) throw new Error(`no block ${blockId} in the document`);
  const group = container.parent as Y.XmlElement;
  const index = group.toArray().indexOf(container);
  doc.transact(() => group.delete(index, 1));
}
