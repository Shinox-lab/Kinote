import { describe, expect, test } from 'vitest';
import type { BlockDiffEntry } from '@kinote/contracts';
import { changeLabel, changedEntries, diffCounts, diffSummary } from '../src/lib/diff.js';

const entry = (blockId: string, change: BlockDiffEntry['change']): BlockDiffEntry => ({ blockId, change, type: 'paragraph' });

const sample: BlockDiffEntry[] = [
  entry('a', 'added'),
  entry('b', 'unchanged'),
  entry('c', 'changed'),
  entry('d', 'added'),
  entry('e', 'removed'),
];

describe('diffCounts', () => {
  test('counts each kind of change and ignores unchanged blocks', () => {
    expect(diffCounts(sample)).toEqual({ added: 2, changed: 1, removed: 1 });
  });

  test('is all zero for an empty or untouched diff', () => {
    expect(diffCounts([])).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(diffCounts([entry('a', 'unchanged')])).toEqual({ added: 0, changed: 0, removed: 0 });
  });
});

describe('diffSummary', () => {
  test('lists the kinds that occur, in a fixed order', () => {
    expect(diffSummary(sample)).toBe('2 added · 1 changed · 1 removed');
    expect(diffSummary([entry('a', 'removed'), entry('b', 'added')])).toBe('1 added · 1 removed');
  });

  test('says so when nothing changed', () => {
    expect(diffSummary([])).toBe('No block changes');
    expect(diffSummary([entry('a', 'unchanged')])).toBe('No block changes');
  });
});

describe('changedEntries', () => {
  test('keeps the changes in their original order and drops unchanged blocks', () => {
    expect(changedEntries(sample).map((e) => e.blockId)).toEqual(['a', 'c', 'd', 'e']);
  });
});

describe('changeLabel', () => {
  test('is a word, so a change never relies on colour', () => {
    expect(changeLabel('added')).toBe('Added');
    expect(changeLabel('changed')).toBe('Changed');
    expect(changeLabel('removed')).toBe('Removed');
  });
});
