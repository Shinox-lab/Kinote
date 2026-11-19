import { describe, expect, test } from 'vitest';
import { pageSlug } from '../src/index.js';

describe('pageSlug', () => {
  test('lowercases, joins words with dashes and ends with the suffix', () => {
    expect(pageSlug('Q3 Report!', 'abcd1234')).toBe('q3-report-abcd1234');
  });

  test('an empty or symbol-only title becomes "page"', () => {
    expect(pageSlug('', 'abcd1234')).toBe('page-abcd1234');
    expect(pageSlug('!!!', 'abcd1234')).toBe('page-abcd1234');
  });

  test('keeps at most 60 characters of the title', () => {
    expect(pageSlug('a'.repeat(100), 'abcd1234')).toBe(`${'a'.repeat(60)}-abcd1234`);
  });
});
