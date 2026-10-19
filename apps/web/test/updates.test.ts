import { describe, expect, test } from 'vitest';
import type { UpdateItem } from '@living-wiki/contracts';
import { relativeTime, updateSentence } from '../src/lib/updates.js';

const ME = '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a77';

function item(over: Omit<Partial<UpdateItem>, 'actor'> & { actor?: Partial<UpdateItem['actor']> } = {}): UpdateItem {
  const { actor, ...rest } = over;
  return {
    versionId: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a44',
    number: 2,
    status: 'indexed',
    reason: 'submit',
    createdAt: '2026-10-19T10:00:00.000Z',
    document: {
      id: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a55',
      title: 'Leave policy',
      kind: 'page' as const,
      spaceId: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a66',
      spaceName: 'Handbook',
    },
    actor: { type: 'user', id: '9a1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a99', name: 'Aisha', ...actor },
    ...rest,
  };
}

describe('updateSentence', () => {
  test('words every status, with the version number and the page title', () => {
    expect(updateSentence(item({ status: 'pending_review' }), ME)).toEqual({
      who: 'Aisha',
      what: 'proposed a change to Leave policy',
    });
    expect(updateSentence(item({ status: 'indexed' }), ME)).toEqual({
      who: 'Aisha',
      what: 'published v2 of Leave policy',
    });
    expect(updateSentence(item({ status: 'rejected' }), ME).what).toBe('had v2 of Leave policy rejected');
    expect(updateSentence(item({ status: 'withdrawn' }), ME).what).toBe('had v2 of Leave policy withdrawn');
    expect(updateSentence(item({ status: 'failed' }), ME).what).toBe('had v2 of Leave policy fail to index');
  });

  test("the viewer's own versions read as You", () => {
    expect(updateSentence(item({ actor: { id: ME, name: 'Aisha' } }), ME).who).toBe('You');
    expect(updateSentence(item({ actor: { id: ME } }), null).who).toBe('Aisha');
  });

  test('an agent keeps its name and a connector reads as System', () => {
    expect(updateSentence(item({ actor: { type: 'agent', id: 'a1', name: 'Support bot' } }), ME).who).toBe('Support bot');
    expect(updateSentence(item({ actor: { type: 'system', id: null, name: 'System' } }), ME).who).toBe('System');
  });

  test('a system actor is never mistaken for the viewer', () => {
    expect(updateSentence(item({ actor: { type: 'system', id: null, name: 'System' } }), null).who).toBe('System');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  test('just now below a minute, then minutes, hours and days', () => {
    expect(relativeTime(ago(0), now)).toBe('just now');
    expect(relativeTime(ago(59 * S), now)).toBe('just now');
    expect(relativeTime(ago(60 * S), now)).toBe('1m');
    expect(relativeTime(ago(59 * M), now)).toBe('59m');
    expect(relativeTime(ago(60 * M), now)).toBe('1h');
    expect(relativeTime(ago(23 * H + 59 * M), now)).toBe('23h');
    expect(relativeTime(ago(24 * H), now)).toBe('1d');
    expect(relativeTime(ago(6 * D), now)).toBe('6d');
  });

  test('a week or more is a short date, and a time in the future is just now', () => {
    expect(relativeTime(ago(8 * D), now, 'en-US', 'UTC')).toBe('Oct 11');
    expect(relativeTime(ago(-5 * M), now)).toBe('just now');
  });

  test('an unreadable time is an empty string, never "NaN"', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});
