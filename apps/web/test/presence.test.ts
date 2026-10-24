import { describe, expect, test } from 'vitest';
import { initials, presencePeople, presenceStrip, presenceTint } from '../src/lib/presence.js';

describe('presencePeople', () => {
  test('reads the id/name we set, falls back to BlockNote\'s user, dedupes and excludes the self', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { lwUser: { id: 'ada', name: 'Ada' }, user: { name: 'Ada' } }],
      [2, { lwUser: { id: 'bea', name: 'Bea' } }],
      [3, { lwUser: { id: 'ada', name: 'Ada' } }],
      [4, { user: { name: 'Legacy' } }],
    ]);
    expect(presencePeople(states, 'ada')).toEqual([
      expect.objectContaining({ id: 'bea', name: 'Bea' }),
      expect.objectContaining({ id: 'client-4', name: 'Legacy' }),
    ]);
    expect(presencePeople(states, 'ada')).toHaveLength(2);
  });

  test('shows three faces and counts the rest', () => {
    const people = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id, ...presenceTint(id) }));
    const { shown, more } = presenceStrip(people);
    expect(shown.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(more).toBe(2);
    expect(presenceStrip([]).more).toBe(0);
  });

  test('a person keeps the same tint, from the six design slots', () => {
    const one = presenceTint('bea');
    expect(presenceTint('bea')).toEqual(one);
    expect(one.accent).toMatch(/^var\(--author-[0-5]\)$/);
    expect(one.tint).toMatch(/^var\(--author-[0-5]-tint\)$/);
  });
});

describe('initials', () => {
  test('first letters of the first two words', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Bea')).toBe('B');
    expect(initials('  ')).toBe('?');
    expect(initials(undefined)).toBe('?');
  });
});
