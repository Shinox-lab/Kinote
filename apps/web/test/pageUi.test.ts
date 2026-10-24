import { afterEach, describe, expect, test, vi } from 'vitest';
import { closeHistory, getHistoryOpenFor, getHistoryTab, openHistory, subscribeHistory } from '../src/lib/pageUi.js';

afterEach(() => closeHistory());

describe('history drawer state', () => {
  test('is closed to begin with, opens for one page and closes', () => {
    expect(getHistoryOpenFor()).toBeNull();
    openHistory('page-1');
    expect(getHistoryOpenFor()).toBe('page-1');
    closeHistory();
    expect(getHistoryOpenFor()).toBeNull();
  });

  test('remembers the requested tab', () => {
    openHistory('page-1', 'changes');
    expect(getHistoryTab()).toBe('changes');
    openHistory('page-2');
    expect(getHistoryTab()).toBe('versions');
  });

  test('opening for another page replaces the first', () => {
    openHistory('page-1');
    openHistory('page-2');
    expect(getHistoryOpenFor()).toBe('page-2');
  });

  test('tells subscribers once per real change, and not after they unsubscribe', () => {
    const listener = vi.fn();
    const stop = subscribeHistory(listener);
    openHistory('page-1');
    openHistory('page-1');
    expect(listener).toHaveBeenCalledTimes(1);
    closeHistory();
    closeHistory();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    openHistory('page-3');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
