import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { DRAWINGS_MAP, UNTITLED_DRAWING, type DrawingElement } from '@kinote/contracts';
import {
  IMAGE_REFUSED,
  clampHeight,
  drawingMenuItem,
  duplicateDrawingIds,
  isImagePaste,
  withoutImages,
} from '../src/components/drawing/drawingRules.js';

const el = (id: string, over: Partial<DrawingElement> = {}): DrawingElement => ({ id, index: `a${id}`, version: 1, versionNonce: 1, type: 'rectangle', ...over });

describe('the drawing block', () => {
  test('the slash menu has a Drawing item that inserts a drawing block with a new id', () => {
    const doc = new Y.Doc();
    const inserted: any[] = [];
    const editor = {
      getTextCursorPosition: () => ({ block: { id: 'here', content: [{ type: 'text', text: 'x' }] } }),
      insertBlocks: (blocks: any[]) => {
        inserted.push(...blocks);
        return blocks;
      },
      replaceBlocks: () => ({ insertedBlocks: [] }),
    };
    const item = drawingMenuItem(editor as any, doc);
    expect(item.title).toBe('Drawing');
    item.onItemClick();
    item.onItemClick();
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ type: 'drawing', props: { title: '', height: 480 } });
    expect(inserted[0].props.drawingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted[0].props.drawingId).not.toBe(inserted[1].props.drawingId);
    // The scene is made once, by the client that inserted the block.
    expect(doc.getMap<Y.Map<unknown>>(DRAWINGS_MAP).get(inserted[0].props.drawingId)).toBeInstanceOf(Y.Map);
  });

  test('a duplicated drawing block gets its own drawing id', () => {
    const blocks: any[] = [
      { id: 'b1', type: 'drawing', props: { drawingId: 'g1' }, children: [] },
      { id: 'p', type: 'paragraph', children: [{ id: 'b2', type: 'drawing', props: { drawingId: 'g1' }, children: [] }] },
      { id: 'b3', type: 'drawing', props: { drawingId: 'g2' }, children: [] },
    ];
    expect(duplicateDrawingIds(blocks)).toEqual([{ blockId: 'b2', drawingId: 'g1' }]);
  });

  test('a pasted image is refused with the notice', () => {
    expect(IMAGE_REFUSED).toBe("Images in drawings aren't supported yet. Add the image to the page instead.");
    expect(isImagePaste({ files: [{ type: 'image/png' }] } as any)).toBe(true);
    expect(isImagePaste({ files: [{ type: 'text/plain' }] } as any)).toBe(false);
    expect(isImagePaste(null)).toBe(false);
    // An image that reaches the canvas anyway (dropped) is taken off it.
    const { elements, removed } = withoutImages([el('a'), el('img', { type: 'image' })]);
    expect(removed).toBe(true);
    expect(elements.find((e) => e.id === 'img')).toMatchObject({ isDeleted: true, version: 2 });
  });

  test('the title placeholder is Untitled drawing', () => {
    expect(UNTITLED_DRAWING).toBe('Untitled drawing');
  });

  test('the height stays between 240 and 1200', () => {
    expect(clampHeight(100)).toBe(240);
    expect(clampHeight(5000)).toBe(1200);
    expect(clampHeight(Number.NaN)).toBe(480);
    expect(clampHeight(600.4)).toBe(600);
  });

  test('Excalidraw is imported only by the lazy drawing modules', () => {
    const SRC = new URL('../src', import.meta.url).pathname;
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []
      );
    const offenders = files(SRC)
      .filter((f) => /from ['"]@excalidraw\/excalidraw|import\(['"]@excalidraw\/excalidraw/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => !['components/drawing/DrawingCanvas.tsx', 'components/drawing/DrawingPreview.tsx'].includes(f));
    expect(offenders).toEqual([]);
    const shell = readFileSync(join(SRC, 'components/drawing/DrawingBlock.tsx'), 'utf8');
    expect(shell).toMatch(/lazy\(\(\) => import\('\.\/DrawingCanvas\.js'\)\)/);
  });
});
