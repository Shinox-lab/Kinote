import { describe, expect, test } from 'vitest';
import { commentBody, commentText, parseCommentsSearch } from '../src/lib/comments.js';

describe('commentText', () => {
  test('paragraphs on lines, styled text and links flattened', () => {
    expect(
      commentText([
        { type: 'paragraph', content: [{ type: 'text', text: 'Hi ', styles: {} }, { type: 'text', text: 'there', styles: { bold: true } }] },
        { type: 'paragraph', content: [{ type: 'link', href: 'https://a.b', content: [{ type: 'text', text: 'see', styles: {} }] }] },
      ])
    ).toBe('Hi there\nsee');
  });
  test('nothing readable is empty', () => {
    expect(commentText(undefined)).toBe('');
    expect(commentText([{ type: 'paragraph', content: [] }])).toBe('');
  });
});

describe('commentBody', () => {
  test('one paragraph per line, blank lines dropped', () => {
    expect(commentBody('a\n\nb')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a', styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'b', styles: {} }] },
    ]);
  });
});

describe('parseCommentsSearch', () => {
  test('keeps comments=1 only', () => {
    expect(parseCommentsSearch({ comments: '1' })).toEqual({ comments: 1 });
    expect(parseCommentsSearch({ comments: 1 })).toEqual({ comments: 1 });
    expect(parseCommentsSearch({ comments: 'x' })).toEqual({});
  });
});
