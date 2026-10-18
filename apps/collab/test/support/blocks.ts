import type * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';

/** The XmlFragment that holds a page's BlockNote blocks (see apps/collab/src/server.ts). */
export const BLOCK_FRAGMENT = 'document-store';

const editor = ServerBlockNoteEditor.create();

/** The simplified block shape tests write: `{ id, type, text, level? }`. */
export interface SimpleBlock {
  id: string;
  type: string;
  text?: string;
  level?: number;
  markdown?: string;
}

function normalizeBlock(block: any): any {
  if (!block || block.content) return block;
  const text = block.text != null ? String(block.text) : '';
  return {
    id: block.id,
    type: block.type,
    ...(block.type === 'heading' && block.level ? { props: { level: block.level } } : {}),
    content: text ? [{ type: 'text', styles: {}, text }] : [],
  };
}

/** Reads the BlockNote blocks currently in a page Y.Doc. */
export function readBlocks(doc: Y.Doc): any[] {
  return editor.yXmlFragmentToBlocks(doc.getXmlFragment(BLOCK_FRAGMENT)) as any[];
}

/**
 * Replaces the page's blocks with `blocks` (simplified or real BlockNote
 * blocks) in one Yjs transaction on `doc`. On a websocket client's doc this
 * is a client edit; inside a direct session's `transact` it is a server edit.
 */
export function writeBlocks(doc: Y.Doc, blocks: Array<SimpleBlock | any>): void {
  const frag = doc.getXmlFragment(BLOCK_FRAGMENT);
  const valid = blocks.map(normalizeBlock);
  doc.transact(() => {
    editor.blocksToYXmlFragment(valid as any, frag);
  });
}

/** The page fragment serialized, for "does the doc contain this text" checks. */
export function fragmentText(doc: Y.Doc): string {
  return doc.getXmlFragment(BLOCK_FRAGMENT).toString();
}
