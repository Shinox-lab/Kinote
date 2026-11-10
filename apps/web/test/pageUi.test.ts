import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PAGE_WIDTH_KEY,
  PAGE_WIDTH_OPTIONS,
  closeHistory,
  getHistoryOpenFor,
  getHistoryTab,
  loadPageWidth,
  openHistory,
  pageWidthClass,
  savePageWidth,
  subscribeHistory,
} from '../src/lib/pageUi.js';

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

describe('page width', () => {
  test('default keeps the reading column, wide widens it, full uses the whole screen', () => {
    expect(pageWidthClass('default')).toBe('max-w-[660px]');
    expect(pageWidthClass('wide')).toBe('max-w-[960px]');
    expect(pageWidthClass('full')).toBe('max-w-none');
  });

  test('a missing width reads at the default width', () => {
    expect(pageWidthClass(undefined)).toBe('max-w-[660px]');
  });

  test('the menu offers the three widths in order', () => {
    expect(PAGE_WIDTH_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['default', 'Default'],
      ['wide', 'Wide'],
      ['full', 'Full'],
    ]);
  });
});

describe('remembered page width', () => {
  test('loads the stored width and defaults to the reading column', () => {
    expect(loadPageWidth({ getItem: (k) => (k === PAGE_WIDTH_KEY ? 'wide' : null) })).toBe('wide');
    expect(loadPageWidth({ getItem: () => null })).toBe('default');
    expect(loadPageWidth({ getItem: () => 'huge' })).toBe('default');
    expect(
      loadPageWidth({
        getItem: () => {
          throw new Error('blocked');
        },
      })
    ).toBe('default');
  });

  test('saves the width under its key and swallows a throwing storage', () => {
    const written: Record<string, string> = {};
    savePageWidth('full', { setItem: (k, v) => void (written[k] = v) });
    expect(written).toEqual({ [PAGE_WIDTH_KEY]: 'full' });
    expect(() =>
      savePageWidth('wide', {
        setItem: () => {
          throw new Error('quota');
        },
      })
    ).not.toThrow();
  });
});
