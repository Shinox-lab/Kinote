import { describe, expect, test } from 'vitest';
import { computePageBadge, type BadgeInput } from '../src/pages/badge.js';

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
