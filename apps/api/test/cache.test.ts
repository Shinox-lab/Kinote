import { describe, expect, test } from 'vitest';
import { TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  test('returns a value until its ttl, then drops it', () => {
    let now = 1_000;
    const cache = new TtlCache<string>({ ttlMs: 50, now: () => now });
    cache.set('a', 'value');

    expect(cache.get('a')).toBe('value');
    now += 49;
    expect(cache.get('a')).toBe('value');
    now += 1;
    expect(cache.get('a')).toBeUndefined();
  });

  test('delete and deletePrefix remove entries', () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000 });
    cache.set('t1:s1:live', 1);
    cache.set('t1:s2:live', 2);
    cache.set('t2:s1:live', 3);

    cache.delete('t1:s1:live');
    expect(cache.get('t1:s1:live')).toBeUndefined();

    cache.deletePrefix('t1:');
    expect(cache.get('t1:s2:live')).toBeUndefined();
    expect(cache.get('t2:s1:live')).toBe(3);
  });

  test('evicts the oldest entry when full', () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });
});
