import { describe, expect, it } from 'vitest';
import { flattenBlocks } from '../src/blocks.js';
import { createServerEditor, pageLinksOf, restorePageLinks } from '../src/editorSchema.js';

const editor = createServerEditor();
const ID = '0b6f3b5e-9c2a-4f43-8d0e-2f1b8f7c1a11';
const linkBlock = (): any => ({
  type: 'paragraph',
  content: ['See ', { type: 'pageLink', props: { documentId: ID, title: 'Client - George' } }, ' now'],
});

describe('the wiki editor schema', () => {
  it('keeps a page link through the Yjs document', () => {
    const doc = editor.blocksToYDoc([linkBlock()], 'document-store');
    const [b] = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(b.content[1]).toEqual({ type: 'pageLink', props: { documentId: ID, title: 'Client - George' } });
  });

  it('reads a page link as its title in plain text', () => {
    const doc = editor.blocksToYDoc([linkBlock()], 'document-store');
    expect(flattenBlocks(editor.yDocToBlocks(doc, 'document-store') as any)[0]!.text).toBe('See Client - George now');
  });

  it('writes a page link to Markdown as a link to the page', async () => {
    const md = await editor.blocksToMarkdownLossy([linkBlock()]);
    expect(md.trim()).toBe(`See [Client - George](/p/${ID}) now`);
  });

  it('turns those Markdown links back into page links', async () => {
    const parsed = await editor.tryParseMarkdownToBlocks(`See [Client - George](/p/${ID}) and [web](https://a.b)`);
    const [b] = restorePageLinks(parsed as any) as any[];
    expect(b.content[1]).toEqual({ type: 'pageLink', props: { documentId: ID, title: 'Client - George' } });
    expect(b.content[3]).toMatchObject({ type: 'link', href: 'https://a.b' });
  });

  it.each(['a]b', '[x', 'x](evil)', '<b>hi</b>', '*star*', 'back\\slash'])('a title with Markdown punctuation (%s) survives the round trip', async (title) => {
    const md = await editor.blocksToMarkdownLossy([
      { type: 'paragraph', content: ['See ', { type: 'pageLink', props: { documentId: ID, title } }] },
    ] as any);
    const [b] = restorePageLinks((await editor.tryParseMarkdownToBlocks(md)) as any) as any[];
    expect(b.content.find((c: any) => c.type === 'pageLink')).toEqual({ type: 'pageLink', props: { documentId: ID, title } });
  });

  it('lists the page links of blocks, nested ones included, once per block and target', () => {
    const child = { id: 'c1', type: 'paragraph', content: [{ type: 'pageLink', props: { documentId: ID.toUpperCase(), title: 'x' } }], children: [] };
    const blocks = [
      { id: 'b1', type: 'paragraph', content: [linkBlock().content[1], linkBlock().content[1]], children: [child] },
    ];
    expect(pageLinksOf(blocks)).toEqual([
      { blockId: 'b1', targetId: ID },
      { blockId: 'c1', targetId: ID },
    ]);
  });
});
