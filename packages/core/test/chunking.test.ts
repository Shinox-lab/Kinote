import { describe, expect, it } from 'vitest';
import { chunkPageBlocks, DEFAULT_CHUNK_OPTIONS } from '../src/indexing/chunkPage.js';
import { blocksFromMarkdown, type RealBlock } from './fixtures/realBlocks.js';

const words = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const bodyOf = (chunkText: string) => chunkText.split('\n\n').slice(1).join('\n\n');
const flatIds = (blocks: RealBlock[]): string[] =>
  blocks.flatMap((b) => [b.id, ...flatIds(b.children as RealBlock[])]);

describe('chunkPageBlocks with real BlockNote blocks', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_CHUNK_OPTIONS).toEqual({ targetWords: 350, maxWords: 600 });
  });

  it('splits at headings, keeps the heading path and the real block ids', async () => {
    const blocks = await blocksFromMarkdown('# Alpha\n\npara a\n\n## Beta\n\npara b');
    expect(blocks).toHaveLength(4);
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(chunks[0].headingPath).toEqual(['Alpha']);
    expect(chunks[1].headingPath).toEqual(['Alpha', 'Beta']);
    expect(chunks[0].blockIds).toEqual([blocks[0].id, blocks[1].id]);
    expect(chunks[1].blockIds).toEqual([blocks[2].id, blocks[3].id]);
    expect(chunks[0].text).toBe('# Doc > Alpha\n\nAlpha\n\npara a');
    expect(chunks[1].text).toBe('# Doc > Alpha > Beta\n\nBeta\n\npara b');
    expect(chunks[0].blockIds).not.toContain('block-1');
  });

  it('computes tokenCount and a sha-256 contentHash of the text', async () => {
    const [c] = chunkPageBlocks('Doc', await blocksFromMarkdown('# A\n\nhello world'));
    expect(c.tokenCount).toBe(wordCount(c.text));
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resets the heading stack by level', async () => {
    const blocks = await blocksFromMarkdown(
      '# One\n\na\n\n### Deep\n\nb\n\n# Two\n\nc\n\n## Sub\n\nd'
    );
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ['One'],
      ['One', 'Deep'],
      ['Two'],
      ['Two', 'Sub'],
    ]);
  });

  it('puts content before the first heading in a chunk whose text is just the title header', async () => {
    const blocks = await blocksFromMarkdown('intro\n\n# H\n\nbody');
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].headingPath).toEqual([]);
    expect(chunks[0].text).toBe('# Doc\n\nintro');
  });

  it('flattens styled and linked inline text', async () => {
    const blocks = await blocksFromMarkdown('para **bold** [link](http://x.y) end');
    const [c] = chunkPageBlocks('Doc', blocks);
    expect(bodyOf(c.text)).toBe('para bold link end');
  });

  it('includes nested list items with their own ids', async () => {
    const blocks = await blocksFromMarkdown('# L\n\n- one\n  - nested\n- two');
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(1);
    const nestedId = (blocks[1].children as RealBlock[])[0].id;
    expect(nestedId).toBeTruthy();
    expect(chunks[0].blockIds).toEqual(flatIds(blocks));
    expect(chunks[0].blockIds).toContain(nestedId);
    expect(chunks[0].text).toContain('nested');
  });

  it('contributes a table as one block whose text contains "a | b"', async () => {
    const blocks = await blocksFromMarkdown('# T\n\n| a | b |\n|---|---|\n| c | d |');
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('a | b');
    expect(chunks[0].text).toContain('c | d');
    expect(chunks[0].blockIds).toEqual(flatIds(blocks));
  });

  it('continues a long section in new chunks between blocks, never splitting a paragraph', async () => {
    const paras = Array.from({ length: 15 }, (_, i) => words(100, `p${i}w`));
    const blocks = await blocksFromMarkdown(`# Long\n\n${paras.join('\n\n')}`);
    const chunks = chunkPageBlocks('Doc', blocks);
    // heading + 3 paragraphs (301 words <= 350), then 3 per chunk: 5 chunks
    expect(chunks).toHaveLength(5);
    expect(chunks.map((c) => c.blockIds.length)).toEqual([4, 3, 3, 3, 3]);
    for (const c of chunks) {
      expect(wordCount(bodyOf(c.text))).toBeLessThanOrEqual(600);
      expect(c.headingPath).toEqual(['Long']);
      expect(c.text.startsWith('# Doc > Long\n\n')).toBe(true);
    }
    for (const p of paras) {
      expect(chunks.filter((c) => c.text.includes(p))).toHaveLength(1);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    // every block id appears exactly once across the chunks
    expect(chunks.flatMap((c) => c.blockIds)).toEqual(flatIds(blocks));
  });

  it('never splits a single oversized paragraph and keeps it alone', async () => {
    const big = words(900, 'big');
    const blocks = await blocksFromMarkdown(big);
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain(big);

    const mixed = await blocksFromMarkdown(`small one\n\n${big}\n\nsmall two`);
    const mchunks = chunkPageBlocks('Doc', mixed);
    expect(mchunks).toHaveLength(3);
    expect(mchunks[1].blockIds).toEqual([mixed[1].id]);
  });

  describe('heading path is an ancestor stack', () => {
    const paths = async (md: string) =>
      chunkPageBlocks('Doc', await blocksFromMarkdown(md)).map((c) => c.headingPath);

    it('sibling h2s with no h1 are siblings', async () => {
      expect(await paths('## A\n\nx\n\n## B\n\ny')).toEqual([['A'], ['B']]);
    });
    it('h1, h3, h3: second h3 replaces the first', async () => {
      expect(await paths('# A\n\nx\n\n### B\n\ny\n\n### C\n\nz')).toEqual([
        ['A'],
        ['A', 'B'],
        ['A', 'C'],
      ]);
    });
    it('a document opening with h2 then h3', async () => {
      expect(await paths('## A\n\nx\n\n### B\n\ny')).toEqual([['A'], ['A', 'B']]);
    });
    it('h1, h2, h3, h2: the second h2 pops h3 and replaces the first h2', async () => {
      expect(await paths('# A\n\nx\n\n## B\n\ny\n\n### C\n\nz\n\n## D\n\nw')).toEqual([
        ['A'],
        ['A', 'B'],
        ['A', 'B', 'C'],
        ['A', 'D'],
      ]);
    });
    it('h1, h1: the second h1 replaces the first', async () => {
      const blocks = await blocksFromMarkdown('# A\n\n# B');
      const chunks = chunkPageBlocks('Doc', blocks);
      expect(chunks.map((c) => c.headingPath)).toEqual([['A'], ['B']]);
      expect(chunks.map((c) => c.blockIds)).toEqual([[blocks[0].id], [blocks[1].id]]);
    });
  });

  it('keeps a heading with a following oversized paragraph in one chunk', async () => {
    const big = words(900, 'big');
    const blocks = await blocksFromMarkdown(`# H\n\n${big}`);
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].blockIds).toEqual([blocks[0].id, blocks[1].id]);
    expect(chunks[0].text).toBe(`# Doc > H\n\nH\n\n${big}`);

    // later blocks still do not join the oversized block
    const more = await blocksFromMarkdown(`# H\n\n${big}\n\nafter`);
    expect(chunkPageBlocks('Doc', more).map((c) => c.blockIds)).toEqual([
      [more[0].id, more[1].id],
      [more[2].id],
    ]);
  });

  it('merges a bare heading into the chunk of the deeper heading that follows it', async () => {
    const blocks = await blocksFromMarkdown('# T\n\n## S\n\nsmall');
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual(['T', 'S']);
    expect(chunks[0].blockIds).toEqual(blocks.map((b) => b.id));
    expect(chunks[0].text).toBe('# Doc > T > S\n\nT\n\nS\n\nsmall');
  });

  it('indexes a heading-only page as one chunk containing the heading text', async () => {
    const blocks = await blocksFromMarkdown('# Only Heading');
    const chunks = chunkPageBlocks('Doc', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Only Heading');
    expect(chunks[0].headingPath).toEqual(['Only Heading']);
    expect(chunks[0].blockIds).toEqual([blocks[0].id]);
  });

  it('returns no chunks for a blank page', async () => {
    expect(chunkPageBlocks('Doc', await blocksFromMarkdown(''))).toEqual([]);
    expect(chunkPageBlocks('Doc', await blocksFromMarkdown('   \n\n  '))).toEqual([]);
    expect(chunkPageBlocks('Doc', [])).toEqual([]);
  });

  it('editing one paragraph changes the hash of only the chunk containing it', async () => {
    const section = (h: string, tail: string) => `## ${h}\n\n${words(40, h)} ${tail}`;
    const build = (tail: string) =>
      blocksFromMarkdown(
        ['# Top\n\nintro', section('S1', 'x'), section('S2', tail), section('S3', 'x')].join('\n\n')
      );
    const a = chunkPageBlocks('Doc', await build('before'));
    const b = chunkPageBlocks('Doc', await build('after'));
    expect(a).toHaveLength(b.length);
    const changed = a.map((c, i) => c.contentHash !== b[i].contentHash);
    expect(changed).toEqual([false, false, true, false]);
    expect(a[0].text).toBe(b[0].text);
  });
});
