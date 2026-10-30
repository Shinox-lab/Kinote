import { describe, expect, test } from 'vitest';
import type { AskResponse } from '@kinote/contracts';
import { RECENT_MAX, addRecent, recentKey, removeRecent, type RecentSearch } from '../src/lib/recentSearches.js';

const answer = { answer: '22 days', citations: [], foundRelevant: true } as unknown as AskResponse;
const at = (n: number) => new Date(Date.UTC(2026, 9, 31, 9, n)).toISOString();

describe('recent searches', () => {
  test('the newest comes first', () => {
    let list: RecentSearch[] = [];
    list = addRecent(list, { q: 'vacation', space: '', at: at(1) });
    list = addRecent(list, { q: 'budget', space: '', at: at(2) });
    expect(list.map((r) => r.q)).toEqual(['budget', 'vacation']);
  });

  test('the same search in the same space moves to the top instead of repeating, ignoring case and spaces', () => {
    let list: RecentSearch[] = [];
    list = addRecent(list, { q: 'Vacation days', space: '', at: at(1) });
    list = addRecent(list, { q: 'budget', space: '', at: at(2) });
    list = addRecent(list, { q: '  vacation DAYS ', space: '', at: at(3) });
    expect(list.map((r) => [r.q, r.at])).toEqual([['vacation DAYS', at(3)], ['budget', at(2)]]);
  });

  test('the same words in another space are another search', () => {
    let list: RecentSearch[] = [];
    list = addRecent(list, { q: 'budget', space: '', at: at(1) });
    list = addRecent(list, { q: 'budget', space: 'space-1', at: at(2) });
    expect(list).toHaveLength(2);
  });

  test('running a search again keeps the answer it had, and a new answer replaces it', () => {
    let list: RecentSearch[] = [];
    list = addRecent(list, { q: 'vacation', space: '', at: at(1), answer });
    list = addRecent(list, { q: 'vacation', space: '', at: at(2) });
    expect(list[0]!.answer).toEqual(answer);
    const fresh = { ...answer, answer: '25 days' } as AskResponse;
    list = addRecent(list, { q: 'vacation', space: '', at: at(3), answer: fresh });
    expect(list[0]!.answer).toEqual(fresh);
  });

  test(`keeps at most ${RECENT_MAX}`, () => {
    let list: RecentSearch[] = [];
    for (let i = 0; i < RECENT_MAX + 3; i++) list = addRecent(list, { q: `q${i}`, space: '', at: at(i) });
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]!.q).toBe(`q${RECENT_MAX + 2}`);
  });

  test('one can be removed', () => {
    let list: RecentSearch[] = [];
    list = addRecent(list, { q: 'vacation', space: '', at: at(1) });
    list = addRecent(list, { q: 'budget', space: '', at: at(2) });
    expect(removeRecent(list, list[1]!).map((r) => r.q)).toEqual(['budget']);
  });

  test('each person keeps their own list in each workspace', () => {
    expect(recentKey('t-1', 'u-1')).not.toBe(recentKey('t-1', 'u-2'));
    expect(recentKey('t-1', 'u-1')).not.toBe(recentKey('t-2', 'u-1'));
  });
});
