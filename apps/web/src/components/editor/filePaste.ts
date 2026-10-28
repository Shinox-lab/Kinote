import { getNearestBlockPos } from '@blocknote/core';
import { api, errorMessage } from '../../lib/api.js';
import type { EditorPlace } from './menus.js';
import type { WikiEditor } from './schema.js';

// Pasting a file into a page makes a real Living Wiki file under that page,
// then leaves a fileEmbed block pointing at it. The bytes never go in the
// page's Yjs document: the block holds a document id.

/** The files in a paste or drop (empty for everything else). */
export function filesOf(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

async function uploadIntoPage(file: File, place: EditorPlace) {
  const form = new FormData();
  form.set('file', file, file.name);
  form.set('space_id', place.spaceId);
  form.set('parent_id', place.pageId);
  return api.uploadFile(form);
}

/** The block a drop landed on and which side of it the file should go. */
export function dropTarget(
  editor: WikiEditor,
  at: { left: number; top: number }
): { reference: string; placement: 'before' | 'after' } | null {
  const pos = editor.prosemirrorView.posAtCoords(at);
  if (!pos) return null;
  const { node } = getNearestBlockPos(editor.prosemirrorView.state.doc, pos.pos);
  const id = String(node.attrs.id);
  const rect = editor.domElement?.querySelector(`[data-id="${id}"]`)?.getBoundingClientRect();
  return { reference: id, placement: rect && (rect.top + rect.bottom) / 2 > at.top ? 'before' : 'after' };
}

/**
 * Inserts a placeholder per file, then uploads the files in parallel and
 * fills each block with the stored document id. A failed upload leaves the
 * sentence in the block so the person sees what happened.
 */
export function insertFiles(
  editor: WikiEditor,
  files: File[],
  at: { reference: string; placement: 'before' | 'after' },
  place: EditorPlace,
  refresh: (...part: string[]) => void
): void {
  if (files.length === 0) return;
  const placeholders = files.map((file) => ({
    type: 'fileEmbed' as const,
    props: { name: file.name, documentId: '', error: '' },
  }));
  const reference = editor.getBlock(at.reference);
  if (!reference) return;

  let blocks;
  if (at.placement === 'after' && Array.isArray(reference.content) && reference.content.length === 0) {
    // The empty line the cursor was on is replaced by the first file.
    blocks = [editor.updateBlock(reference, placeholders[0]!), ...editor.insertBlocks(placeholders.slice(1), reference, 'after')];
  } else {
    blocks = editor.insertBlocks(placeholders, reference, at.placement);
  }

  for (const [i, file] of files.entries()) {
    const blockId = blocks[i]?.id;
    if (!blockId) continue;
    void (async () => {
      try {
        const out = await uploadIntoPage(file, place);
        const block = editor.getBlock(blockId);
        if (!block || block.type !== 'fileEmbed') return; // removed or changed while it uploaded
        editor.updateBlock(blockId, {
          type: 'fileEmbed',
          props: { documentId: out.document.id, name: out.document.title, error: '' },
        });
        for (const part of ['tree', 'reviews', 'updates']) void refresh(part);
      } catch (err) {
        const block = editor.getBlock(blockId);
        if (block?.type === 'fileEmbed') editor.updateBlock(blockId, { props: { error: errorMessage(err) } });
      }
    })();
  }
}
