import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { MAX_DRAWING_ELEMENTS, drawingDiff, drawingText, newerElement, type DrawingElement } from '@kinote/contracts';
import { flattenBlocks } from '../src/blocks.js';
import { drawingBlockIds, liveElements } from '../src/drawings.js';
import { createServerEditor } from '../src/editorSchema.js';

const el = (id: string, over: Partial<DrawingElement> = {}): DrawingElement => ({
  id,
  index: `a${id}`,
  version: 1,
  versionNonce: 1,
  type: 'rectangle',
  ...over,
});

describe('the drawing element model', () => {
  it('newerElement keeps the higher version, then the lower versionNonce', () => {
    const a = el('x', { version: 3, versionNonce: 9 });
    const b = el('x', { version: 2, versionNonce: 1 });
    expect(newerElement(a, b)).toBe(a);
    expect(newerElement(b, a)).toBe(a);
    const c = el('x', { version: 3, versionNonce: 4 });
    expect(newerElement(a, c)).toBe(c);
    expect(newerElement(c, a)).toBe(c);
  });

  it('liveElements drops tombstones and invalid entries and orders by index', () => {
    const map = new Y.Doc().getMap<unknown>('d');
    map.set('b', el('b', { index: 'a2' }));
    map.set('a', el('a', { index: 'a1' }));
    map.set('gone', el('gone', { index: 'a0', isDeleted: true }));
    map.set('bad', { id: 'bad' });
    map.set('wrong', el('other', { index: 'a3' }));
    expect(liveElements(map).map((e) => e.id)).toEqual(['a', 'b']);
    expect(liveElements(undefined)).toEqual([]);
  });

  it('liveElements reads at most 5,000 elements', () => {
    const map = new Y.Doc().getMap<unknown>('d');
    for (let i = 0; i < MAX_DRAWING_ELEMENTS + 10; i++) {
      const id = `e${String(i).padStart(5, '0')}`;
      map.set(id, el(id, { index: `a${String(i).padStart(5, '0')}` }));
    }
    const live = liveElements(map);
    expect(live).toHaveLength(5000);
    expect(live[0]!.id).toBe('e00000');
  });

  it('drawingText lists the title then the words, at most 200 lines', () => {
    expect(drawingText('', [el('a', { type: 'text', text: '  Start \n here ' }), el('b'), el('c', { type: 'text', text: 'End' })])).toBe(
      'Drawing: Untitled drawing\nStart here\nEnd'
    );
    const many = Array.from({ length: 250 }, (_, i) => el(`t${i}`, { type: 'text', text: `word ${i}` }));
    const lines = drawingText('Flow', many).split('\n');
    expect(lines[0]).toBe('Drawing: Flow');
    expect(lines).toHaveLength(201);
  });

  it('drawingDiff counts added, changed and removed by id and version', () => {
    const before = [el('a'), el('b'), el('c')];
    const after = [el('a'), el('b', { version: 2 }), el('d'), el('e')];
    expect(drawingDiff(before, after)).toEqual({ added: 2, changed: 1, removed: 1 });
  });
});

describe('the drawing block on the server', () => {
  const editor = createServerEditor();
  const block = (props: Record<string, unknown>): any => ({ id: 'd1', type: 'drawing', props: { drawingId: 'g1', ...props }, children: [] });

  it('a drawing block converts to Markdown with its text', async () => {
    const md = await editor.blocksToMarkdownLossy([block({ title: 'Flow', text: 'Drawing: Flow\nStart\nEnd' })]);
    expect(md).toContain('Drawing: Flow');
    expect(md).toContain('Start');
    expect(md).toContain('End');
  });

  it('a drawing block survives the Yjs document', () => {
    const doc = editor.blocksToYDoc([block({ title: 'Flow', height: 600 })], 'document-store');
    const [b] = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(b).toMatchObject({ type: 'drawing', props: { drawingId: 'g1', title: 'Flow', height: 600 } });
  });

  it('flattenBlocks reads a drawing as its text, or its title', () => {
    expect(flattenBlocks([block({ title: 'Flow', text: 'Drawing: Flow\nStart' })])[0]!.text).toBe('Drawing: Flow\nStart');
    expect(flattenBlocks([block({ title: '' })])[0]!.text).toBe('Drawing: Untitled drawing');
  });

  it('drawingBlockIds maps drawing ids to their blocks, children included', () => {
    const blocks: any[] = [
      { id: 'p', type: 'paragraph', children: [{ id: 'd2', type: 'drawing', props: { drawingId: 'g2' }, children: [] }] },
      block({}),
    ];
    expect([...drawingBlockIds(blocks)]).toEqual([
      ['g2', 'd2'],
      ['g1', 'd1'],
    ]);
  });
});
