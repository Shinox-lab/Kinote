import { createContext, useContext } from 'react';
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { DefaultReactSuggestionItem } from '@blocknote/react';
import { DRAWING_HEIGHT, drawingConfig, type DrawingElement } from '@kinote/contracts';
import { createDrawing } from './binding.js';

// What the drawing block needs that isn't Excalidraw: its copy, its slash
// item, the duplicate check and the image rules. Excalidraw itself loads
// only in DrawingCanvas (lazy).

/** The exact notice when an image is pasted or dropped into a drawing (D10). */
export const IMAGE_REFUSED = "Images in drawings aren't supported yet. Add the image to the page instead.";
export const DRAWING_FULL = 'This drawing is full';
export const DRAWING_FAILED = "This drawing couldn't load";
export const DRAWING_REMOVED = 'This drawing was removed';

/** The page's live document and awareness, for drawing blocks (absent outside the live editor). */
export interface LiveDoc {
  ydoc: Y.Doc;
  awareness: HocuspocusProvider['awareness'];
}
export const LiveDocContext = createContext<LiveDoc | null>(null);
export const useLiveDoc = () => useContext(LiveDocContext);

/** A drawing's height in whole pixels, within DRAWING_HEIGHT (the default for anything unreadable). */
export function clampHeight(px: number): number {
  if (!Number.isFinite(px)) return DRAWING_HEIGHT.default;
  return Math.round(Math.min(DRAWING_HEIGHT.max, Math.max(DRAWING_HEIGHT.min, px)));
}

interface InsertingEditor {
  getTextCursorPosition(): { block: { id: string; content?: unknown } };
  insertBlocks(blocks: unknown[], reference: unknown, placement: 'after'): unknown[];
  replaceBlocks(remove: unknown[], insert: unknown[]): { insertedBlocks: unknown[] };
}

/** The slash menu's "Drawing": a new drawing block (an empty line becomes it), with its scene made here. */
export function drawingMenuItem(editor: InsertingEditor, ydoc: Y.Doc | null): DefaultReactSuggestionItem {
  return {
    title: 'Drawing',
    subtext: 'A diagram, sketch or whiteboard (Excalidraw)',
    aliases: ['drawing', 'draw', 'excalidraw', 'diagram', 'sketch', 'whiteboard', 'flow'],
    group: 'Basic blocks',
    onItemClick: () => {
      const drawingId = crypto.randomUUID();
      if (ydoc) createDrawing(ydoc, drawingId);
      const block = { type: drawingConfig.type, props: { drawingId, title: '', height: DRAWING_HEIGHT.default } };
      const here = editor.getTextCursorPosition().block;
      const empty = Array.isArray(here.content) && here.content.length === 0;
      if (empty) editor.replaceBlocks([here], [block]);
      else editor.insertBlocks([block], here, 'after');
    },
  };
}

interface DrawingBlockLike {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: DrawingBlockLike[];
}

/** Drawing blocks that show a drawing an earlier block already shows (a duplicate or a paste), in document order. */
export function duplicateDrawingIds(blocks: DrawingBlockLike[]): Array<{ blockId: string; drawingId: string }> {
  const seen = new Set<string>();
  const out: Array<{ blockId: string; drawingId: string }> = [];
  const walk = (list: DrawingBlockLike[]) => {
    for (const b of list) {
      const drawingId = b.type === drawingConfig.type ? b.props?.drawingId : undefined;
      if (typeof drawingId === 'string' && drawingId !== '') {
        if (seen.has(drawingId)) out.push({ blockId: b.id, drawingId });
        seen.add(drawingId);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** Whether a paste into a drawing carries an image file. */
export function isImagePaste(data: { files?: ArrayLike<{ type: string }> | null } | null | undefined): boolean {
  return Array.from(data?.files ?? []).some((f) => f.type.startsWith('image/'));
}

/** The scene with any live image element deleted (an image that reached the canvas anyway, e.g. dropped). */
export function withoutImages(elements: readonly DrawingElement[]): { elements: DrawingElement[]; removed: boolean } {
  let removed = false;
  const out = elements.map((e) => {
    if (e.type !== 'image' || e.isDeleted) return e;
    removed = true;
    return { ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) };
  });
  return { elements: out, removed };
}
