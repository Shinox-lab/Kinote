import * as Y from 'yjs';
import { DRAWINGS_MAP, drawingConfig, drawingText, storable, type DrawingElement } from '@kinote/contracts';
import { drawingBlockIds, liveElements, type BlockLike } from '@kinote/shared';

/** One drawing's element map in a page document, or undefined. */
function sceneOf(ydoc: Y.Doc, drawingId: string): Y.Map<unknown> | undefined {
  const scene = ydoc.getMap<unknown>(DRAWINGS_MAP).get(drawingId);
  return scene instanceof Y.Map ? (scene as Y.Map<unknown>) : undefined;
}

/**
 * A copy of `blocks` with every drawing block's `text` prop set to its
 * drawing's words (`drawingText`): what Markdown, the index, diffs and the
 * routing engine read. Only the copy is changed, never the live document.
 */
export function withDrawingText<T extends BlockLike>(blocks: T[], ydoc: Y.Doc): T[] {
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? { children: withDrawingText(b.children, ydoc) } : {};
    if (b.type !== drawingConfig.type) return { ...b, ...children };
    const drawingId = String(b.props?.drawingId ?? '');
    const text = drawingText(String(b.props?.title ?? ''), liveElements(drawingId ? sceneOf(ydoc, drawingId) : undefined));
    return { ...b, ...children, props: { ...b.props, text } };
  });
}

/**
 * The drawing scenes a version keeps: the live elements of every drawing a
 * block shows (Postgres-unstorable elements left out), or null when no
 * block shows a drawing. Scenes no block shows are never versioned.
 */
export function versionDrawings(blocks: BlockLike[], ydoc: Y.Doc): Record<string, DrawingElement[]> | null {
  const ids = [...drawingBlockIds(blocks).keys()];
  if (ids.length === 0) return null;
  return Object.fromEntries(ids.map((id) => [id, liveElements(sceneOf(ydoc, id)).filter(storable)]));
}

/** A version's blocks as the live document stores them: the snapshot's in-memory drawing `text` taken out. */
export function withoutDrawingText<T extends BlockLike>(blocks: T[]): T[] {
  return blocks.map((b) => {
    const children = Array.isArray(b.children) ? { children: withoutDrawingText(b.children) } : {};
    if (b.type !== drawingConfig.type || !b.props || !('text' in b.props)) return { ...b, ...children };
    const { text: _text, ...props } = b.props;
    return { ...b, ...children, props };
  });
}
