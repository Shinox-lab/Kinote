import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExtractedSection } from '@living-wiki/contracts';
import { chunkExtracted } from '../src/files/chunkExtracted.js';
import { parseCsv, readTextNative } from '../src/files/textNative.js';
import { DEFAULT_CHUNK_OPTIONS } from '../src/indexing/chunkPage.js';

const enc = (s: string) => new TextEncoder().encode(s);
const words = (n: number, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
const bodyOf = (text: string) => text.split('\n\n').slice(1).join('\n\n');
const text = (
  headingPath: string[],
  body: string,
  pageFrom: number | null = null,
  pageTo: number | null = pageFrom
): ExtractedSection => ({ headingPath, pageFrom, pageTo, kind: 'text', text: body });
const table = (headingPath: string[], body: string, page: number | null = null): ExtractedSection => ({
  headingPath, pageFrom: page, pageTo: page, kind: 'table', text: body,
});

describe('readTextNative', () => {
  it('reads a TXT file as one text section and drops a byte order mark', () => {
    const doc = readTextNative('txt', enc('﻿hello\n\nworld'));
    expect(doc).toEqual({
      pageCount: null,
      ocrUsed: false,
      sections: [{ headingPath: [], pageFrom: null, pageTo: null, kind: 'text', text: 'hello\n\nworld' }],
    });
  });

  it('gives an empty file no sections', () => {
    expect(readTextNative('txt', enc('  \n ')).sections).toEqual([]);
    expect(readTextNative('csv', enc('')).sections).toEqual([]);
  });

  it('splits Markdown at headings and ignores # inside a code fence', () => {
    const md = ['intro', '# A', 'text a', '## B', 'text b', '```', '# not a heading', '```', '# C', 'text c'].join('\n');
    const sections = readTextNative('md', enc(md)).sections;
    expect(sections.map((s) => [s.headingPath, s.text])).toEqual([
      [[], 'intro'],
      [['A'], 'text a'],
      [['A', 'B'], 'text b\n```\n# not a heading\n```'],
      [['C'], 'text c'],
    ]);
  });

  it('reads CSV as one table with cells joined by " | "', () => {
    const doc = readTextNative('csv', enc('name,note\n"Doe, J","line one\nline two"\n'));
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]).toMatchObject({ kind: 'table', headingPath: [] });
    // A line break inside a cell must not look like the end of a record: it reads as a space.
    expect(doc.sections[0]!.text).toBe('name | note\nDoe, J | line one line two');
  });

  it('keeps every CSV record on one line, however many line breaks its cells hold', () => {
    const doc = readTextNative('csv', enc('a,b\r\n"x\r\ny","p\n\nq"\n"z",w\n'));
    expect(doc.sections[0]!.text.split('\n')).toEqual(['a | b', 'x y | p q', 'z | w']);
  });
});

describe('parseCsv', () => {
  it('handles quotes, doubled quotes and newlines inside quotes', () => {
    expect(parseCsv('a,"b ""q"" c",d\r\n1,"x\ny",3\n')).toEqual([
      ['a', 'b "q" c', 'd'],
      ['1', 'x\ny', '3'],
    ]);
  });
});

describe('chunkExtracted', () => {
  it('puts short paragraphs under one heading in one chunk, with the title and heading path', () => {
    const chunks = chunkExtracted('Handbook', [text(['Leave'], 'One.\n\nTwo.', 1)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('# Handbook > Leave\n\nOne.\n\nTwo.');
    expect(chunks[0]).toMatchObject({ ordinal: 0, headingPath: ['Leave'], blockIds: [], pageFrom: 1, pageTo: 1 });
    expect(chunks[0]!.contentHash).toBe(createHash('sha256').update(chunks[0]!.text, 'utf8').digest('hex'));
    expect(chunks[0]!.tokenCount).toBe(wc(chunks[0]!.text));
  });

  it('uses just the title when a section has no heading path', () => {
    expect(chunkExtracted('Doc', [text([], 'body')])[0]!.text).toBe('# Doc\n\nbody');
  });

  it('starts a new chunk when the heading path changes', () => {
    const chunks = chunkExtracted('D', [text(['A'], 'a'), text(['B'], 'b')]);
    expect(chunks.map((c) => c.headingPath)).toEqual([['A'], ['B']]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
  });

  it('joins consecutive sections with the same path on the same page', () => {
    const chunks = chunkExtracted('D', [text(['A'], 'first', 2), text(['A'], 'second', 2)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageFrom: 2, pageTo: 2 });
  });

  it('starts a new chunk at a page change, so a citation names one page', () => {
    const chunks = chunkExtracted('D', [text(['A'], 'first', 2), text(['A'], 'second', 3)]);
    expect(chunks.map((c) => [c.pageFrom, c.pageTo])).toEqual([[2, 2], [3, 3]]);
  });

  it('keeps the span of a section that itself covers two pages', () => {
    const chunks = chunkExtracted('D', [text(['A'], 'runs over', 2, 3)]);
    expect(chunks[0]).toMatchObject({ pageFrom: 2, pageTo: 3 });
  });

  it('leaves pages null when no section has one', () => {
    const [chunk] = chunkExtracted('D', [text([], 'x')]);
    expect(chunk).toMatchObject({ pageFrom: null, pageTo: null });
  });

  it('splits a very long paragraph: nothing over maxWords, no word lost', () => {
    const para = words(1500);
    const chunks = chunkExtracted('D', [text([], para)]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(wc(bodyOf(c.text))).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxWords);
    expect(chunks.map((c) => bodyOf(c.text)).join(' ')).toBe(para);
  });

  it('keeps a small table whole and in its own chunk', () => {
    const t = 'Grade | Days\nA | 5\nB | 3';
    const chunks = chunkExtracted('D', [text(['Pay'], 'intro'), table(['Pay'], t, 2)]);
    expect(chunks).toHaveLength(2);
    expect(bodyOf(chunks[1]!.text)).toBe(t);
    expect(chunks[1]).toMatchObject({ pageFrom: 2, pageTo: 2 });
  });

  it('splits a table over the limit by rows and repeats the header line in every chunk', () => {
    const header = 'Name | Note';
    const rows = Array.from({ length: 40 }, (_, i) => `row${i} | ${words(20, `r${i}x`)}`);
    const chunks = chunkExtracted('D', [table([], [header, ...rows].join('\n'))]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bodyOf(c.text).split('\n')[0]).toBe(header);
      expect(wc(bodyOf(c.text))).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxWords);
    }
    const seen = chunks.flatMap((c) => bodyOf(c.text).split('\n').slice(1));
    expect(seen).toEqual(rows);
  });

  it('splits one row that is over the limit and keeps the header line on every piece', () => {
    const header = 'Name | Note';
    const long = `big | ${words(1500, 'w')}`;
    const chunks = chunkExtracted('D', [table([], [header, 'small | one', long, 'last | row'].join('\n'))]);
    const bodies = chunks.map((c) => bodyOf(c.text));
    for (const b of bodies) expect(b.split('\n')[0]).toBe(header);
    for (const c of chunks) expect(wc(bodyOf(c.text))).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxWords);
    const text = bodies.map((b) => b.split('\n').slice(1).join(' ')).join(' ');
    expect(text.split(/\s+/).filter((w) => /^w\d*/.test(w)).length).toBeGreaterThanOrEqual(1500);
    expect(bodies.some((b) => b.includes('last | row'))).toBe(true);
    expect(bodies.some((b) => b.includes('small | one'))).toBe(true);
  });

  it('drops blank sections and never makes a chunk with an empty body', () => {
    expect(chunkExtracted('D', [text(['A'], '  \n\n '), text(['B'], '')])).toEqual([]);
  });
});
