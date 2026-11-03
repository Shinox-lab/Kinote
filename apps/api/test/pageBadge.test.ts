import { describe, expect, test } from 'vitest';
import { computeFileBadge, computePageBadge, type BadgeInput, type FileBadgeInput } from '../src/pages/badge.js';

const input = (over: Partial<BadgeInput>): BadgeInput => ({
  liveChangedSinceSnapshot: false,
  agentChangedAt: null,
  spaceReviewRequired: false,
  latestVersion: { number: 2, status: 'indexing' },
  indexedVersion: { number: 1 },
  ...over,
});

describe('page badge', () => {
  test('paused indexing shows the limit reason', () => {
    const paused = 'Saved · not indexed (indexing limit reached)';
    expect(computePageBadge(input({ indexingPaused: true }))).toBe(paused);
    expect(computePageBadge(input({ indexingPaused: true, liveChangedSinceSnapshot: true, latestVersion: { number: 1, status: 'indexed' } }))).toBe(paused);
    expect(computePageBadge(input({ indexingPaused: false }))).toBe('Indexing…');
    expect(computePageBadge(input({}))).toBe('Indexing…');
  });

  test('paused indexing does not hide review, failure or an indexed page', () => {
    expect(computePageBadge(input({ indexingPaused: true, latestVersion: { number: 2, status: 'pending_review' } }))).toBe(
      'Saved · not indexed (awaiting approval)'
    );
    expect(computePageBadge(input({ indexingPaused: true, latestVersion: { number: 2, status: 'failed' } }))).toBe('Index failed');
    expect(computePageBadge(input({ indexingPaused: true, latestVersion: { number: 1, status: 'indexed' } }))).toBe('Indexed · v1');
  });
});

describe('file badge while indexing is held', () => {
  const file = (status: string, over: Partial<FileBadgeInput> = {}): FileBadgeInput => ({
    latestVersion: { number: 2, status, hasText: true },
    indexedVersion: null,
    sourceDeleted: false,
    placement: 'pinned',
    ...over,
  });

  test('a file waiting to be indexed says the limit was reached', () => {
    expect(computeFileBadge({ ...file('indexing'), indexingPaused: true })).toBe('Not indexed (indexing limit reached)');
    expect(computeFileBadge({ ...file('indexing', { indexedVersion: { number: 1 } }), indexingPaused: true })).toBe(
      'Indexed · v1, v2 waiting (indexing limit reached)'
    );
    expect(computeFileBadge(file('indexing'))).toBe('Indexing…');
    expect(computeFileBadge({ ...file('pending_review'), indexingPaused: true })).toBe('Not indexed (awaiting approval)');
  });
});
