import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { flattenBlocks } from '../src/blocks.js';
import { createServerEditor, groupMentionsOf, mentionsOf, pageLinksOf, restorePageLinks } from '../src/editorSchema.js';

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

  it('keeps a pasted file embed through the Yjs document and writes it as a link to the file', async () => {
    const embed = {
      id: 'f1',
      type: 'fileEmbed',
      props: { documentId: ID, name: 'Report.pdf', error: '' },
    };
    const doc = editor.blocksToYDoc([embed] as any, 'document-store');
    expect(editor.yDocToBlocks(doc, 'document-store')[0]).toMatchObject(embed);
    const md = await editor.blocksToMarkdownLossy([embed] as any);
    expect(md.trim()).toBe(`[Report.pdf](/p/${ID})`);
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

/** The first text node of a page fragment. */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    const found = child instanceof Y.XmlElement ? firstText(child) : undefined;
    if (found) return found;
  }
  return undefined;
}

describe('comment marks', () => {
  it('a page with a comment mark still reads in full', () => {
    const doc = editor.blocksToYDoc([{ type: 'paragraph', content: 'Hello world' } as any], 'document-store');
    firstText(doc.getXmlFragment('document-store'))!.format(0, 5, { comment: { threadId: 't1', orphan: false } });
    const blocks = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(flattenBlocks(blocks).map((b) => b.text)).toEqual(['Hello world']);
  });
});

describe('mentions', () => {
  const USER = '7d1c9a52-3b44-4e2a-9f10-5c6d7e8f9a0b';
  const mentionBlock = (): any => ({
    id: 'm1',
    type: 'paragraph',
    content: ['Ask ', { type: 'mention', props: { userId: USER, name: 'Ed Editor' } }, ' today'],
  });

  it('keeps a mention through the Yjs document and reads it as @name', () => {
    const doc = editor.blocksToYDoc([mentionBlock()], 'document-store');
    const blocks = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(blocks[0].content[1]).toEqual({ type: 'mention', props: { userId: USER, name: 'Ed Editor' } });
    expect(flattenBlocks(blocks)[0]!.text).toBe('Ask @Ed Editor today');
  });

  it('survives the Markdown round trip', async () => {
    const md = await editor.blocksToMarkdownLossy([mentionBlock()]);
    expect(md.trim()).toBe(`Ask [@Ed Editor](/u/${USER}) today`);
    const [b] = restorePageLinks((await editor.tryParseMarkdownToBlocks(md)) as any) as any[];
    expect(b.content[1]).toEqual({ type: 'mention', props: { userId: USER, name: 'Ed Editor' } });
  });

  it('lists who is mentioned in which block, once each', () => {
    const b = mentionBlock();
    b.content.push(b.content[1]);
    expect(mentionsOf([b])).toEqual([{ blockId: 'm1', userId: USER }]);
  });
});

describe('group mentions', () => {
  const GROUP = '2b6f0c1d-8e9a-4b3c-a1d2-e3f4a5b6c7d8';
  const groupBlock = (): any => ({
    id: 'g1',
    type: 'paragraph',
    content: ['Over to ', { type: 'groupMention', props: { groupId: GROUP, name: 'Design' } }, ' for review'],
  });

  it('keeps a group mention through the Yjs document and reads it as @name', () => {
    const doc = editor.blocksToYDoc([groupBlock()], 'document-store');
    const blocks = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(blocks[0].content[1]).toEqual({ type: 'groupMention', props: { groupId: GROUP, name: 'Design' } });
    expect(flattenBlocks(blocks)[0]!.text).toBe('Over to @Design for review');
  });

  it('survives the Markdown round trip as a /g/ link', async () => {
    const md = await editor.blocksToMarkdownLossy([groupBlock()]);
    expect(md.trim()).toBe(`Over to [@Design](/g/${GROUP}) for review`);
    const [b] = restorePageLinks((await editor.tryParseMarkdownToBlocks(md)) as any) as any[];
    expect(b.content[1]).toEqual({ type: 'groupMention', props: { groupId: GROUP, name: 'Design' } });
  });

  it('lists which groups are mentioned in which block, once each, and not as people', () => {
    const b = groupBlock();
    b.content.push(b.content[1]);
    expect(groupMentionsOf([b])).toEqual([{ blockId: 'g1', groupId: GROUP }]);
    expect(mentionsOf([b])).toEqual([]);
  });
});

describe('callouts', () => {
  it('a callout keeps its emoji and text through the Yjs document', () => {
    const doc = editor.blocksToYDoc([{ type: 'callout', props: { emoji: '⚠️' }, content: 'Mind the gap' } as any], 'document-store');
    const [b] = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(b).toMatchObject({ type: 'callout', props: { emoji: '⚠️' } });
    expect(flattenBlocks([b])[0]!.text).toBe('Mind the gap');
  });

  it('reads as its emoji and text in Markdown', async () => {
    const md = await editor.blocksToMarkdownLossy([{ type: 'callout', props: { emoji: '💡' }, content: 'Tip here' } as any]);
    expect(md).toContain('💡');
    expect(md).toContain('Tip here');
  });
});

describe('collection views', () => {
  const view = (): any => ({ type: 'collectionView', props: { collectionId: ID, title: 'Clients', views: '[{"id":"v1","layout":"board"}]' } });

  it('a view block keeps its collection and settings through the Yjs document', () => {
    const doc = editor.blocksToYDoc([view()], 'document-store');
    const [b] = editor.yDocToBlocks(doc, 'document-store') as any[];
    expect(b).toMatchObject({ type: 'collectionView', props: { collectionId: ID, title: 'Clients', views: '[{"id":"v1","layout":"board"}]' } });
  });

  it('reads as one line linking the collection, never its title (a reader of this page may not be able to read it)', async () => {
    const md = await editor.blocksToMarkdownLossy([view()]);
    expect(md.trim()).toBe(`Collection view: [collection](/p/${ID})`);
    expect(md).not.toContain('Clients');
    expect(flattenBlocks([view()])[0]!.text).toBe('Collection view');
  });
});
