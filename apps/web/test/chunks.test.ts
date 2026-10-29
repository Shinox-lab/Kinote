import { describe, expect, test } from 'vitest';
import type { ExtractedSection } from '@kinote/contracts';
import { chunkSummary, previewLines } from '../src/lib/chunks.js';

const section = (text: string, over: Partial<ExtractedSection> = {}): ExtractedSection => ({
  headingPath: [],
  pageFrom: null,
  pageTo: null,
  kind: 'text',
  text,
  ...over,
});

describe('previewLines', () => {
  test('keeps the non-empty lines of every section, in order', () => {
    const out = previewLines([section('First line\n\n  \nSecond line'), section('Third')]);
    expect(out).toEqual({ lines: ['First line', 'Second line', 'Third'], truncated: false });
  });

  test('stops at the limit and says it was cut', () => {
    const many = section(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
    const out = previewLines([many], 40);
    expect(out.lines).toHaveLength(40);
    expect(out.lines[39]).toBe('line 40');
    expect(out.truncated).toBe(true);
  });

  test('exactly the limit is not truncated, and no text is no lines', () => {
    expect(previewLines([section('a\nb')], 2)).toEqual({ lines: ['a', 'b'], truncated: false });
    expect(previewLines([])).toEqual({ lines: [], truncated: false });
  });

  test('text is returned as it is, never as markup', () => {
    expect(previewLines([section('<img src=x onerror=alert(1)>')]).lines).toEqual(['<img src=x onerror=alert(1)>']);
  });
});

describe('chunkSummary', () => {
  const chunk = (over: Partial<{ pageFrom: number | null; pageTo: number | null; tokenCount: number; text: string }>) => ({
    pageFrom: null,
    pageTo: null,
    tokenCount: 10,
    text: 'one two three four five',
    ...over,
  });

  test('a page range, a single page, or just the size', () => {
    expect(chunkSummary(chunk({ pageFrom: 2, pageTo: 3 }))).toBe('Pages 2–3 · 5 words');
    expect(chunkSummary(chunk({ pageFrom: 4, pageTo: 4, text: 'a b' }))).toBe('Page 4 · 2 words');
    expect(chunkSummary(chunk({}))).toBe('5 words');
    expect(chunkSummary(chunk({ text: 'solo' }))).toBe('1 word');
  });

  test('a start without an end reads as one page', () => {
    expect(chunkSummary(chunk({ pageFrom: 7, pageTo: null }))).toBe('Page 7 · 5 words');
  });
});
