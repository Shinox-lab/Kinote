import { describe, expect, test } from 'vitest';
import {
  COLLAPSED_KEY,
  expandedKey,
  isCollapseShortcut,
  loadCollapsed,
  loadExpanded,
  saveCollapsed,
  saveExpanded,
} from '../src/lib/sidebar.js';

/** A Storage stand-in over a map. */
function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}
const throwing = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};

describe('collapsed state', () => {
  test('round-trips and defaults to open', () => {
    const s = store();
    expect(loadCollapsed(s)).toBe(false);
    saveCollapsed(true, s);
    expect(s.data.get(COLLAPSED_KEY)).toBe('1');
    expect(loadCollapsed(s)).toBe(true);
    saveCollapsed(false, s);
    expect(loadCollapsed(s)).toBe(false);
  });

  test('survives blocked storage', () => {
    expect(loadCollapsed(throwing)).toBe(false);
    expect(() => saveCollapsed(true, throwing)).not.toThrow();
  });
});

describe('expanded nodes', () => {
  const A = '3f1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a11';
  const B = '9a1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a22';

  test('round-trip per tenant and do not leak between tenants', () => {
    const s = store();
    saveExpanded(A, new Set(['x', 'y']), s);
    saveExpanded(B, new Set(['z']), s);
    expect(loadExpanded(A, s)).toEqual(new Set(['x', 'y']));
    expect(loadExpanded(B, s)).toEqual(new Set(['z']));
    expect(expandedKey(A)).not.toBe(expandedKey(B));
  });

  test('missing, malformed or wrongly shaped storage is an empty set', () => {
    expect(loadExpanded(A, store())).toEqual(new Set());
    expect(loadExpanded(A, store({ [expandedKey(A)]: '{not json' }))).toEqual(new Set());
    expect(loadExpanded(A, store({ [expandedKey(A)]: '{"a":1}' }))).toEqual(new Set());
    expect(loadExpanded(A, store({ [expandedKey(A)]: '[1,"ok",null]' }))).toEqual(new Set(['ok']));
    expect(loadExpanded(A, throwing)).toEqual(new Set());
    expect(() => saveExpanded(A, new Set(['x']), throwing)).not.toThrow();
  });
});

describe('isCollapseShortcut', () => {
  test('is Ctrl+\\ or Cmd+\\ and nothing else', () => {
    expect(isCollapseShortcut({ key: '\\', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isCollapseShortcut({ key: '\\', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isCollapseShortcut({ key: '\\', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isCollapseShortcut({ key: 'b', ctrlKey: true, metaKey: false })).toBe(false);
    expect(isCollapseShortcut({ key: '/', ctrlKey: true, metaKey: false })).toBe(false);
  });
});
