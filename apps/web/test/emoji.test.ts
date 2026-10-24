import { describe, expect, test } from 'vitest';
import { PAGE_ICONS } from '../src/lib/emoji.js';

describe('the curated page icons', () => {
  test('48 unique entries, each one grapheme of at most 16 UTF-16 units', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    expect(PAGE_ICONS).toHaveLength(48);
    expect(new Set(PAGE_ICONS).size).toBe(48);
    for (const icon of PAGE_ICONS) {
      expect([...segmenter.segment(icon)]).toHaveLength(1);
      expect(icon.length).toBeLessThanOrEqual(16);
      expect(icon.trim()).toBe(icon);
    }
  });
});
