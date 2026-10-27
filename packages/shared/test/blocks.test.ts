import { describe, expect, it } from 'vitest';
import { createServerEditor } from '../src/editorSchema.js';
import { flattenBlocks } from '../src/blocks.js';

const editor = createServerEditor();
const parse = (md: string) => editor.tryParseMarkdownToBlocks(md);

describe('flattenBlocks', () => {
  it('flattens headings (with level) and paragraphs in document order', async () => {
    const blocks = await parse('# A\n\npara\n\n### C');
    expect(flattenBlocks(blocks)).toEqual([
      { id: blocks[0].id, type: 'heading', level: 1, text: 'A', depth: 0 },
      { id: blocks[1].id, type: 'paragraph', text: 'para', depth: 0 },
      { id: blocks[2].id, type: 'heading', level: 3, text: 'C', depth: 0 },
    ]);
  });

  it('flattens styled text and links to plain text', async () => {
    const [b] = await parse('x **bold** _it_ [lnk](http://a.b) y');
    expect(flattenBlocks([b])[0].text).toBe('x bold it lnk y');
  });

  it('includes children depth-first at depth + 1', async () => {
    const blocks = await parse('- one\n  - nested\n    - deeper\n- two');
    const flat = flattenBlocks(blocks);
    expect(flat.map((f) => [f.text, f.depth])).toEqual([
      ['one', 0],
      ['nested', 1],
      ['deeper', 2],
      ['two', 0],
    ]);
    expect(flat[1].id).toBe((blocks[0].children as { id: string }[])[0].id);
  });

  it('turns a table into one block with rows on lines and cells joined by " | "', async () => {
    const blocks = await parse('| a | b |\n|---|---|\n| c | d |');
    const flat = flattenBlocks(blocks);
    expect(flat).toHaveLength(1);
    expect(flat[0].type).toBe('table');
    expect(flat[0].text).toBe('a | b\nc | d');
  });

  it('accepts bare inline arrays as table cells', () => {
    const flat = flattenBlocks([
      {
        id: 't',
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          rows: [{ cells: [[{ type: 'text', text: 'a', styles: {} }], [{ type: 'text', text: 'b', styles: {} }]] }],
        },
        children: [],
      },
    ]);
    expect(flat[0].text).toBe('a | b');
  });

  it('uses inline text of unknown inline and block types, empty otherwise', () => {
    const flat = flattenBlocks([
      {
        id: 'm',
        type: 'custom',
        props: {},
        content: [
          { type: 'text', text: 'hi ', styles: {} },
          { type: 'mention', props: { user: 'x' }, content: [{ type: 'text', text: '@bob', styles: {} }] },
          { type: 'weird', text: ' there' },
        ],
        children: [],
      },
      { id: 'i', type: 'image', props: { url: 'u' }, children: [] },
      { id: 'n', type: 'x', props: {}, content: undefined, children: [] },
    ]);
    expect(flat.map((f) => f.text)).toEqual(['hi @bob there', '', '']);
    expect(flat[0].level).toBeUndefined();
  });
});
