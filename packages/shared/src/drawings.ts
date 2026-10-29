import { drawingConfig, liveElementsOf, type DrawingElement } from '@kinote/contracts';
import type { BlockLike } from './blocks.js';

/** The live elements of one drawing's element map (a `Y.Map`, or anything with `entries()`); none when absent. */
export function liveElements(map: { entries(): Iterable<[string, unknown]> } | undefined): DrawingElement[] {
  return map ? liveElementsOf(map.entries()) : [];
}

/** drawingId → the id of the block showing it, children included (the first block wins). */
export function drawingBlockIds(blocks: BlockLike[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: BlockLike[]) => {
    for (const b of list) {
      const drawingId = b.type === drawingConfig.type ? b.props?.drawingId : undefined;
      if (typeof drawingId === 'string' && drawingId !== '' && !out.has(drawingId)) out.set(drawingId, b.id);
      if (Array.isArray(b.children)) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}
