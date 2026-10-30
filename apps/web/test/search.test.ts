import { describe, expect, test } from 'vitest';
import type { AskCitation } from '@kinote/contracts';
import { answerSegments, headingLine, parseSearchSearch, queryAllows } from '../src/lib/search.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const cite = (n: number, citeAs: string): AskCitation => ({
  citeAs,
  documentId: uuid(n),
  versionId: uuid(100 + n),
  versionNumber: n,
  chunkId: uuid(200 + n),
  blockIds: [],
  documentKind: 'page',
  documentTitle: 'Leave policy',
  spaceId: uuid(300 + n),
  pageFrom: null,
  pageTo: null,
  quote: 'q',
});

const a = cite(1, 'Leave policy (v3, updated 2026-10-18)');
const b = cite(2, 'Onboarding (v1, updated 2026-10-01)');

describe('answerSegments', () => {
  test('turns a [citeAs] marker into a citation segment and keeps the text around it', () => {
    expect(answerSegments(`Take 20 days [${a.citeAs}] off.`, [a])).toEqual([
      { type: 'text', text: 'Take 20 days ' },
      { type: 'citation', citation: a },
      { type: 'text', text: ' off.' },
    ]);
  });

  test('maps several markers, in the order they appear', () => {
    const segments = answerSegments(`One [${b.citeAs}] two [${a.citeAs}] [${b.citeAs}]`, [a, b]);
    expect(segments.filter((s) => s.type === 'citation').map((s) => (s as { citation: AskCitation }).citation.documentId)).toEqual([
      b.documentId,
      a.documentId,
      b.documentId,
    ]);
  });

  test('leaves a marker that matches no citation as plain text', () => {
    expect(answerSegments('See [Unknown (v1)] here', [a])).toEqual([{ type: 'text', text: 'See [Unknown (v1)] here' }]);
  });

  test('an answer without markers is one text segment, and an empty answer has none', () => {
    expect(answerSegments('No relevant information.', [])).toEqual([{ type: 'text', text: 'No relevant information.' }]);
    expect(answerSegments('', [a])).toEqual([]);
  });

  test('never treats answer text as markup', () => {
    expect(answerSegments('<b>hi</b>', [])).toEqual([{ type: 'text', text: '<b>hi</b>' }]);
  });
});

describe('headingLine', () => {
  test('joins a heading path and is empty without one', () => {
    expect(headingLine(['Policies', 'Leave'])).toBe('Policies › Leave');
    expect(headingLine([])).toBe('');
  });
});

describe('queryAllows', () => {
  test('an empty or blank query allows neither action', () => {
    expect(queryAllows('')).toEqual({ search: false, ask: false });
    expect(queryAllows('   \n')).toEqual({ search: false, ask: false });
  });

  test('search takes up to 500 characters and Ask up to 1000, counted after trimming', () => {
    expect(queryAllows('x')).toEqual({ search: true, ask: true });
    expect(queryAllows(` ${'x'.repeat(500)} `)).toEqual({ search: true, ask: true });
    expect(queryAllows('x'.repeat(501))).toEqual({ search: false, ask: true });
    expect(queryAllows('x'.repeat(1000))).toEqual({ search: false, ask: true });
    expect(queryAllows('x'.repeat(1001))).toEqual({ search: false, ask: false });
  });
});

describe('the ask param', () => {
  test('ask=1 keeps the answer wanted across navigation', () => {
    expect(parseSearchSearch({ q: 'vacation', ask: '1' })).toEqual({ q: 'vacation', ask: true });
    expect(parseSearchSearch({ q: 'vacation', ask: 1 })).toEqual({ q: 'vacation', ask: true });
    expect(parseSearchSearch({ q: 'vacation', ask: true })).toEqual({ q: 'vacation', ask: true });
  });

  test('without a query, or with any other value, there is no ask', () => {
    expect(parseSearchSearch({ ask: '1' })).toEqual({});
    expect(parseSearchSearch({ q: 'vacation', ask: 'yes' })).toEqual({ q: 'vacation' });
  });
});
