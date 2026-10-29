import { describe, expect, test } from 'vitest';
import type { PageDetails, VersionSummary } from '@kinote/contracts';
import { pageStatus, relativeTime, type PageStatusInput } from '../src/lib/pageStatus.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

function version(status: VersionSummary['status'], createdAt: string): VersionSummary {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    number: 1,
    status,
    reason: 'submit',
    createdByType: 'user',
    createdBy: '00000000-0000-4000-8000-000000000002',
    createdAt,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    indexedAt: null,
    error: null,
  };
}

function page(over: Partial<PageStatusInput> = {}): PageStatusInput {
  return {
    badge: 'Indexed · v1',
    liveChangedSinceSnapshot: false,
    latestVersion: version('indexed', '2026-10-24T09:00:00.000Z'),
    indexedVersion: version('indexed', '2026-10-24T09:00:00.000Z'),
    ...over,
  };
}

describe('pageStatus', () => {
  test('clean: the server badge, ok tone, the indexed time', () => {
    expect(pageStatus(page(), 0)).toEqual({
      state: 'clean',
      label: 'Indexed · v1',
      tone: 'ok',
      indexedAt: '2026-10-24T09:00:00.000Z',
    });
  });

  test('changed: the client counts the visible blocks', () => {
    const info = pageStatus(page({ badge: 'Saved · not indexed', liveChangedSinceSnapshot: true }), 3);
    expect(info).toMatchObject({ state: 'changed', label: '3 unindexed changes', tone: 'warn' });
    expect(pageStatus(page({ liveChangedSinceSnapshot: true }), 1).label).toBe('1 unindexed change');
    expect(pageStatus(page({ liveChangedSinceSnapshot: true }), 0).label).toBe('Unindexed changes');
  });

  test('in review wins over changed and uses the review tint', () => {
    const info = pageStatus(
      page({
        badge: 'Saved · not indexed (awaiting approval)',
        liveChangedSinceSnapshot: true,
        latestVersion: version('pending_review', '2026-10-24T11:00:00.000Z'),
      }),
      4
    );
    expect(info).toMatchObject({
      state: 'review',
      label: 'Saved · not indexed (awaiting approval)',
      tone: 'review',
    });
  });

  test('failed: bad tone, before the changed count', () => {
    const info = pageStatus(page({ badge: 'Index failed', liveChangedSinceSnapshot: true }), 1);
    expect(info).toMatchObject({ state: 'failed', label: 'Index failed', tone: 'bad' });
  });

  test('withdrawn, rejected, removed and stored pages stay muted', () => {
    for (const badge of [
      'Withdrawn',
      'Not indexed · v2 rejected',
      'Removed at source',
      'Stored · no searchable text',
    ]) {
      expect(pageStatus(page({ badge }), 0)).toMatchObject({ state: 'muted', tone: 'muted', label: badge });
    }
  });

  test('a saved page with no index yet is pending', () => {
    expect(pageStatus(page({ badge: 'Saved · not indexed', indexedVersion: null }), 0)).toMatchObject({
      state: 'pending',
      tone: 'pending',
      label: 'Saved · not indexed',
      indexedAt: null,
    });
  });
});

describe('relativeTime', () => {
  test('reads as a short age, then a date', () => {
    expect(relativeTime('2026-10-24T11:59:30.000Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-24T11:58:00.000Z', NOW)).toBe('2m ago');
    expect(relativeTime('2026-10-24T10:00:00.000Z', NOW)).toBe('2h ago');
    expect(relativeTime('2026-10-21T12:00:00.000Z', NOW)).toBe('3d ago');
    expect(relativeTime('2026-09-01T12:00:00.000Z', NOW)).toContain('Sep');
  });
});
