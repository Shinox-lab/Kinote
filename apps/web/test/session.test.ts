import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearSession, loadSession, saveSession, type Session } from '../src/lib/session.js';

const SESSION: Session = {
  token: 'lws_abc',
  user: { id: '3f1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a11', name: 'Ada', email: 'ada@example.test' },
  tenantId: '9a1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a22',
  tenantSlug: 'acme',
};

/** A Storage stand-in backed by a Map. */
function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe('console session', () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('save, load and clear round trip', () => {
    expect(loadSession()).toBeNull();
    saveSession(SESSION);
    expect(loadSession()).toEqual(SESSION);
    clearSession();
    expect(loadSession()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  test('a session without a chosen tenant round trips with nulls', () => {
    const fresh: Session = { ...SESSION, tenantId: null, tenantSlug: null };
    saveSession(fresh);
    expect(loadSession()).toEqual(fresh);
  });

  test('stores only the token, the user and the last tenant', () => {
    saveSession({ ...SESSION, password: 'hunter2hunter2' } as Session);
    const [raw] = [...storage.map.values()];
    expect(raw).not.toContain('hunter2');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['tenantId', 'tenantSlug', 'token', 'user']);
  });

  test('every storage access is guarded: a throwing storage gives null and no exception', () => {
    const boom = () => {
      throw new Error('storage denied');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(loadSession()).toBeNull();
    expect(() => saveSession(SESSION)).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });

  test('a missing storage object gives null', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadSession()).toBeNull();
    expect(() => saveSession(SESSION)).not.toThrow();
    expect(() => clearSession()).not.toThrow();
  });

  test('malformed JSON gives null', () => {
    storage.setItem('living-wiki.session', '{not json');
    expect(loadSession()).toBeNull();
  });

  test.each([
    ['an array', []],
    ['a string', 'lws_abc'],
    ['null', null],
    ['no token', { ...SESSION, token: undefined }],
    ['an empty token', { ...SESSION, token: '' }],
    ['a numeric token', { ...SESSION, token: 42 }],
    ['no user', { ...SESSION, user: undefined }],
    ['a user without an email', { ...SESSION, user: { id: 'x', name: 'Ada' } }],
    ['a numeric tenant id', { ...SESSION, tenantId: 7 }],
    ['a tenant slug of the wrong type', { ...SESSION, tenantSlug: {} }],
  ])('a wrongly shaped value (%s) gives null', (_label, value) => {
    storage.setItem('living-wiki.session', JSON.stringify(value));
    expect(loadSession()).toBeNull();
  });
});
