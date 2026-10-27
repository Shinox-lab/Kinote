import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** A block the routing engine changed from a document page: the chip says where it came from. */
export interface BlockSource {
  blockId: string;
  pageId: string;
  title: string;
}

const key = new PluginKey<BlockSource[]>('blockSources');

function chip(sources: BlockSource[], onOpen: (pageId: string) => void): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'block-source';
  el.contentEditable = 'false';
  const first = sources[0]!;
  el.textContent = `From: ${first.title}${sources.length > 1 ? ` +${sources.length - 1}` : ''}`;
  el.title = sources.map((s) => s.title).join(', ');
  // The click opens the source without moving the caret or selecting the block.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    e.preventDefault();
    onOpen(first.pageId);
  });
  return el;
}

function decorate(doc: PMNode, sources: BlockSource[], onOpen: (pageId: string) => void): DecorationSet {
  if (sources.length === 0) return DecorationSet.empty;
  const byBlock = new Map<string, BlockSource[]>();
  for (const s of sources) byBlock.set(s.blockId, [...(byBlock.get(s.blockId) ?? []), s]);
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true;
    const mine = byBlock.get(String(node.attrs.id));
    const content = node.firstChild;
    if (mine && content) {
      // The end of the block's own content, inside it: the chip sits after its last word.
      const at = pos + 1 + content.nodeSize - 1;
      const id = mine.map((s) => s.pageId).join(',');
      decorations.push(
        Decoration.widget(at, () => chip(mine, onOpen), { side: 1, ignoreSelection: true, key: `${node.attrs.id}:${id}` })
      );
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/** The chips on blocks; `setBlockSources` replaces what they show. */
export function blockSourcesExtension(onOpen: (pageId: string) => void) {
  return createExtension({
    key: 'blockSources',
    prosemirrorPlugins: [
      new Plugin<BlockSource[]>({
        key,
        state: {
          init: () => [],
          apply: (tr, prev) => (tr.getMeta(key) as BlockSource[] | undefined) ?? prev,
        },
        props: {
          decorations: (state) => decorate(state.doc, key.getState(state) ?? [], onOpen),
        },
      }),
    ],
  });
}

/** Shows `sources` as chips in the editor (an empty list removes them). */
export function setBlockSources(editor: { transact: (fn: (tr: any) => void) => void }, sources: BlockSource[]) {
  editor.transact((tr) => {
    tr.setMeta(key, sources);
    // A chip update is not an edit: keep it out of undo history.
    tr.setMeta('addToHistory', false);
  });
}
