import { describe, expect, test } from 'vitest';
import type { VersionListItem, VersionSummary } from '@kinote/contracts';
import {
  defaultComparison,
  versionReasonLabel,
  versionStatusLabel,
  versionWho,
  whenLabel,
} from '../src/lib/history.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function version(number: number, over: Partial<VersionSummary> = {}): VersionSummary {
  return {
    id: uuid(number),
    number,
    status: 'indexed',
    reason: 'submit',
    createdByType: 'user',
    createdBy: uuid(900),
    createdAt: '2026-10-18T10:00:00.000Z',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    indexedAt: null,
    error: null,
    ...over,
  };
}

describe('labels', () => {
  test('every status and reason reads as words', () => {
    expect(versionStatusLabel('pending_review')).toBe('Awaiting review');
    expect(versionStatusLabel('indexed')).toBe('Indexed');
    expect(versionStatusLabel('failed')).toBe('Failed');
    expect(versionReasonLabel('quiet')).toBe('Autosaved');
    expect(versionReasonLabel('submit')).toBe('Submitted');
    expect(versionReasonLabel('restore')).toBe('Restored');
  });
});

describe('versionWho', () => {
  /** A version row as the list route sends it: the author's name comes with it. */
  const listed = (over: Partial<VersionListItem> = {}): VersionListItem => ({
    ...version(1),
    createdByName: 'Dana',
    ...over,
  });

  test('the signed-in user is You; anyone else is named by the server, never by an id fragment', () => {
    expect(versionWho(listed(), uuid(900))).toEqual({ name: 'You', isAgent: false });
    expect(versionWho(listed(), null)).toEqual({ name: 'Dana', isAgent: false });
    expect(versionWho(listed({ createdBy: uuid(77), createdByName: 'Former member' }), null)).toEqual({
      name: 'Former member',
      isAgent: false,
    });
  });

  test('an agent keeps its name and is marked; a connector is named by the server and is not an agent', () => {
    expect(versionWho(listed({ createdByType: 'agent', createdBy: uuid(5), createdByName: 'Support bot' }), null)).toEqual({
      name: 'Support bot',
      isAgent: true,
    });
    expect(versionWho(listed({ createdByType: 'connector', createdByName: 'System' }), null)).toEqual({
      name: 'System',
      isAgent: false,
    });
  });

  test('a user who is not the signed-in user is not You even when the ids look alike elsewhere', () => {
    expect(versionWho(listed({ createdByType: 'agent', createdBy: uuid(900), createdByName: 'Bot' }), uuid(900)).name).toBe('Bot');
  });
});

describe('whenLabel', () => {
  test('formats a timestamp and falls back to the text for one it cannot read', () => {
    expect(whenLabel('2026-10-18T10:00:00.000Z')).not.toBe('2026-10-18T10:00:00.000Z');
    expect(whenLabel('not a date')).toBe('not a date');
  });
});

describe('defaultComparison', () => {
  test('compares the second newest with the newest (the list is newest first)', () => {
    expect(defaultComparison([version(3), version(2), version(1)])).toEqual({ from: 2, to: 3 });
  });

  test('has nothing to compare for fewer than two versions', () => {
    expect(defaultComparison([version(1)])).toBeNull();
    expect(defaultComparison([])).toBeNull();
  });
});
