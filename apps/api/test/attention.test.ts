import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computePageBadge,
  pageAttention,
  LIVE_EDIT_WINDOW_SECONDS,
  type BadgeInput,
} from '../src/pages/badge.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

type Attention = 'failed' | 'review' | 'editing' | null;

interface Row {
  name: string;
  input: BadgeInput;
  badge: string;
  /** Attention when liveUpdatedAt is fresh (5 s ago). */
  fresh: Attention;
  /** Attention when liveUpdatedAt is stale (61 s ago). */
  stale: Attention;
}

function input(over: Partial<BadgeInput>): BadgeInput {
  return {
    liveChangedSinceSnapshot: false,
    agentChangedAt: null,
    spaceReviewRequired: false,
    latestVersion: null,
    indexedVersion: null,
    ...over,
  };
}

// Every outcome of computePageBadge, with the dot each one earns.
const TABLE: Row[] = [
  {
    name: 'withdrawn, unchanged',
    input: input({ latestVersion: { number: 2, status: 'withdrawn' } }),
    badge: 'Withdrawn',
    fresh: null,
    stale: null,
  },
  {
    name: 'failed, unchanged',
    input: input({ latestVersion: { number: 2, status: 'failed' } }),
    badge: 'Index failed',
    fresh: 'failed',
    stale: 'failed',
  },
  {
    name: 'failed, live changed (failed outranks editing)',
    input: input({ latestVersion: { number: 2, status: 'failed' }, liveChangedSinceSnapshot: true }),
    badge: 'Index failed',
    fresh: 'failed',
    stale: 'failed',
  },
  {
    name: 'indexing, unchanged',
    input: input({ latestVersion: { number: 2, status: 'indexing' } }),
    badge: 'Indexing…',
    fresh: null,
    stale: null,
  },
  {
    name: 'indexing, live changed',
    input: input({ latestVersion: { number: 2, status: 'indexing' }, liveChangedSinceSnapshot: true }),
    badge: 'Indexing…',
    fresh: 'editing',
    stale: null,
  },
  {
    name: 'pending review, unchanged',
    input: input({ latestVersion: { number: 3, status: 'pending_review' } }),
    badge: 'Saved · not indexed (awaiting approval)',
    fresh: 'review',
    stale: 'review',
  },
  {
    name: 'pending review, live changed (review outranks editing)',
    input: input({ latestVersion: { number: 3, status: 'pending_review' }, liveChangedSinceSnapshot: true }),
    badge: 'Saved · changed since v3, awaiting approval',
    fresh: 'review',
    stale: 'review',
  },
  {
    name: 'rejected, unchanged',
    input: input({ latestVersion: { number: 4, status: 'rejected' } }),
    badge: 'Not indexed · v4 rejected',
    fresh: null,
    stale: null,
  },
  {
    name: 'rejected, live changed, no review needed',
    input: input({ latestVersion: { number: 4, status: 'rejected' }, liveChangedSinceSnapshot: true }),
    badge: 'Saved · indexing soon',
    fresh: 'editing',
    stale: null,
  },
  {
    name: 'rejected, live changed, review required',
    input: input({
      latestVersion: { number: 4, status: 'rejected' },
      liveChangedSinceSnapshot: true,
      spaceReviewRequired: true,
    }),
    badge: 'Saved · not indexed (awaiting approval)',
    fresh: 'review',
    stale: 'review',
  },
  {
    name: 'withdrawn, live changed, no review needed',
    input: input({ latestVersion: { number: 2, status: 'withdrawn' }, liveChangedSinceSnapshot: true }),
    badge: 'Saved · indexing soon',
    fresh: 'editing',
    stale: null,
  },
  {
    name: 'live changed, agent changed, no review (R1: follows the space)',
    input: input({
      latestVersion: { number: 1, status: 'indexed' },
      indexedVersion: { number: 1 },
      liveChangedSinceSnapshot: true,
      agentChangedAt: ago(10),
    }),
    badge: 'Saved · indexing soon',
    fresh: 'editing',
    stale: null,
  },
  {
    name: 'live changed, no review',
    input: input({
      latestVersion: { number: 1, status: 'indexed' },
      indexedVersion: { number: 1 },
      liveChangedSinceSnapshot: true,
    }),
    badge: 'Saved · indexing soon',
    fresh: 'editing',
    stale: null,
  },
  {
    name: 'indexed, unchanged',
    input: input({ latestVersion: { number: 5, status: 'indexed' }, indexedVersion: { number: 5 } }),
    badge: 'Indexed · v5',
    fresh: null,
    stale: null,
  },
  {
    name: 'never indexed, no review',
    input: input({}),
    badge: 'Saved · indexing soon',
    fresh: null,
    stale: null,
  },
  {
    name: 'never indexed, space requires review',
    input: input({ spaceReviewRequired: true }),
    badge: 'Saved · not indexed (awaiting approval)',
    fresh: 'review',
    stale: 'review',
  },
  {
    name: 'never indexed, agent changed, no review (R1: follows the space)',
    input: input({ agentChangedAt: ago(100) }),
    badge: 'Saved · indexing soon',
    fresh: null,
    stale: null,
  },
];

describe('pageAttention', () => {
  test('the window is 60 seconds', () => {
    assert.equal(LIVE_EDIT_WINDOW_SECONDS, 60);
  });

  for (const row of TABLE) {
    test(`${row.name}: "${row.badge}"`, () => {
      assert.equal(computePageBadge(row.input), row.badge);
      assert.equal(pageAttention({ ...row.input, liveUpdatedAt: ago(5) }, NOW), row.fresh);
      assert.equal(pageAttention({ ...row.input, liveUpdatedAt: ago(61) }, NOW), row.stale);
    });
  }

  test('agrees with computePageBadge over the whole input space', () => {
    const statuses = [null, 'extracting', 'pending_review', 'indexing', 'indexed', 'superseded', 'rejected', 'withdrawn', 'failed', 'stored'];
    for (const status of statuses) {
      for (const live of [false, true]) {
        for (const agent of [null, ago(1)]) {
          for (const review of [false, true]) {
            for (const indexed of [null, { number: 1 }]) {
              const i = input({
                latestVersion: status ? { number: 2, status } : null,
                liveChangedSinceSnapshot: live,
                agentChangedAt: agent,
                spaceReviewRequired: review,
                indexedVersion: indexed,
              });
              const badge = computePageBadge(i);
              const dot = pageAttention({ ...i, liveUpdatedAt: ago(1) }, NOW);
              if (badge === 'Index failed') assert.equal(dot, 'failed', badge);
              else if (badge.includes('awaiting approval')) assert.equal(dot, 'review', badge);
              else if (live) assert.equal(dot, 'editing', badge);
              else assert.equal(dot, null, badge);
            }
          }
        }
      }
    }
  });

  test('the 60 s boundary: 60 s is editing, 61 s is null', () => {
    const base = input({ latestVersion: { number: 1, status: 'indexed' }, indexedVersion: { number: 1 }, liveChangedSinceSnapshot: true });
    assert.equal(pageAttention({ ...base, liveUpdatedAt: ago(60) }, NOW), 'editing');
    assert.equal(pageAttention({ ...base, liveUpdatedAt: ago(61) }, NOW), null);
  });

  test('a page opened but not changed is null', () => {
    const base = input({ latestVersion: { number: 1, status: 'indexed' }, indexedVersion: { number: 1 } });
    assert.equal(pageAttention({ ...base, liveUpdatedAt: ago(0) }, NOW), null);
    assert.equal(pageAttention({ ...base, liveUpdatedAt: NOW }, NOW), null);
  });
});
