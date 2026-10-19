import { describe, expect, test } from 'vitest';
import type { VersionSummary } from '@living-wiki/contracts';
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
  const names = new Map([[uuid(900), 'Dana']]);

  test('the signed-in user is You, a known name is used, others get a short id', () => {
    expect(versionWho(version(1), names, uuid(900))).toEqual({ name: 'You', isAgent: false });
    expect(versionWho(version(1), names, null)).toEqual({ name: 'Dana', isAgent: false });
    expect(versionWho(version(1, { createdBy: uuid(77) }), names, null)).toEqual({
      name: 'Collaborator 0077',
      isAgent: false,
    });
  });

  test('an agent is marked as an agent, a connector is named as one', () => {
    expect(versionWho(version(1, { createdByType: 'agent', createdBy: uuid(5) }), names, null)).toEqual({
      name: 'Agent 0005',
      isAgent: true,
    });
    expect(versionWho(version(1, { createdByType: 'connector' }), names, null)).toEqual({
      name: 'Connector',
      isAgent: false,
    });
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
