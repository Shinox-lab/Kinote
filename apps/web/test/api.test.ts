import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ERROR_SENTENCES, VersionSummarySchema } from '@living-wiki/contracts';
import {
  ApiError,
  api,
  errorMessage,
  errorSentence,
  isUnauthenticated,
  request,
  setApiBase,
} from '../src/lib/api.js';
import { clearSession, saveSession } from '../src/lib/session.js';

const TENANT = '3f1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a11';

/** localStorage stand-in: the api client reads the session from storage, as the console does. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
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

function signInAs(token: string, tenantId: string | null): void {
  saveSession({
    token,
    user: { id: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a33', name: 'Ada', email: 'ada@example.test' },
    tenantId,
    tenantSlug: tenantId ? 'acme' : null,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('web api client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', memoryStorage());
    setApiBase('');
    signInAs('tok-123', TENANT);
  });
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  test('sends the bearer token and tenant id, and parses the reply with the schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const out = await request('/api/v1/ping', z.object({ ok: z.boolean() }));
    expect(out).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/ping');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
    expect(headers.get('x-tenant-id')).toBe(TENANT);
    expect(headers.has('content-type')).toBe(false);
  });

  test('sets the JSON content type when there is a body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await request('/api/v1/ping', z.object({ ok: z.boolean() }), {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('content-type')).toBe('application/json');
  });

  test('a multipart body gets no content-type of its own, so the browser can add the boundary', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const form = new FormData();
    form.set('file', new Blob(['x']), 'x.txt');
    await request('/api/v1/files', z.object({ ok: z.boolean() }), { method: 'POST', body: form });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.has('content-type')).toBe(false);
  });

  test('a file that is too big is an ApiError with its sentence', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'file_too_large' }, 413));
    const err = await request('/api/v1/files', z.unknown(), { method: 'POST', body: new FormData() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('file_too_large');
    expect((err as ApiError).status).toBe(413);
  });

  test('sends neither header without a session, and prefixes the API base', async () => {
    clearSession();
    setApiBase('https://api.example.test');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await request('/api/v1/ping', z.object({ ok: z.boolean() }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/v1/ping');
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-tenant-id')).toBe(false);
  });

  test('an error body becomes an ApiError carrying the contract sentence', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'space_not_found', message: 'ignored' }, 404));
    const err = await request('/api/v1/spaces/x', z.unknown()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('space_not_found');
    expect((err as ApiError).message).toBe(ERROR_SENTENCES.space_not_found);
  });

  test('an unknown error code or an unreadable error body still gives a sentence without the code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'brand_new_code' }, 409));
    const unknown = await request('/x', z.unknown()).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ApiError);
    expect((unknown as ApiError).message).not.toContain('brand_new_code');

    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    const html = await request('/x', z.unknown()).catch((e: unknown) => e);
    expect(html).toBeInstanceOf(ApiError);
    expect((html as ApiError).message).not.toContain('<html>');
  });

  test('a rejected fetch becomes an ApiError with a plain sentence, never the raw error text', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch http://127.0.0.1:8787/api/v1/x'));
    const err = await request('/api/v1/x', z.unknown()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const message = (err as ApiError).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('Failed to fetch');
    expect(message).not.toContain('127.0.0.1');
    expect(message).not.toContain('network_error');
    expect(errorMessage(err)).toBe(message);
  });

  test('the session is read from storage on every request, so a sign-out takes effect at once', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    signInAs('tok-456', null);
    await request('/api/v1/ping', z.object({ ok: z.boolean() }));
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-456');
    expect(headers.has('x-tenant-id')).toBe(false);
  });

  test('errorMessage and isUnauthenticated classify thrown values', () => {
    expect(errorMessage(new ApiError('forbidden', 403))).toBe(ERROR_SENTENCES.forbidden);
    const unknown = errorMessage(new Error('secret internals'));
    expect(unknown).not.toContain('secret');
    expect(isUnauthenticated(new ApiError('unauthenticated', 401))).toBe(true);
    expect(isUnauthenticated(new ApiError('invalid_credentials', 401))).toBe(false);
    expect(isUnauthenticated(new Error('x'))).toBe(false);
  });

  test('a reply that fails the schema throws and does not echo the value', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'SECRET-VALUE', number: 'SECRET-NUMBER' }));
    const err = await request('/api/v1/versions/x', VersionSummarySchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).message).not.toContain('SECRET');
  });

  test('a 204 answers undefined', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.signOut()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });

  test('wrappers send snake_case bodies to the route paths', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nodes: [] }));
    await api.spaceTree('s1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/spaces/s1/tree');

    fetchMock.mockResolvedValue(jsonResponse([]));
    await api.compareVersions('p1', 2, 5);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/pages/p1/compare?from=2&to=5');

    fetchMock.mockResolvedValue(jsonResponse({ passages: [] }));
    await api.search({ query: 'laptops', space_ids: ['a'] });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/search');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      query: 'laptops',
      space_ids: ['a'],
    });
  });

  test('updates asks for the limit and parses the feed, rejecting a malformed reply', async () => {
    const item = {
      versionId: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a44',
      number: 2,
      status: 'indexed',
      reason: 'submit',
      createdAt: '2026-10-19T10:00:00.000Z',
      document: {
        id: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a55',
        title: 'Leave policy',
        kind: 'page',
        spaceId: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a66',
        spaceName: 'Handbook',
      },
      actor: { type: 'user', id: '8d1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a77', name: 'Aisha' },
    };
    // A fresh Response per call: a body can be read only once.
    fetchMock.mockImplementation(async () => jsonResponse([item]));
    await expect(api.updates(5)).resolves.toEqual([item]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/updates?limit=5');

    await api.updates();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/updates?limit=8');

    fetchMock.mockImplementation(async () => jsonResponse([{ ...item, status: 'superseded' }]));
    await expect(api.updates()).rejects.toThrow();
  });

  test('errorSentence gives the contract sentence, or a generic one that never contains the code', () => {
    expect(errorSentence('space_not_found')).toBe(ERROR_SENTENCES.space_not_found);
    const generic = errorSentence('nope');
    expect(generic.length).toBeGreaterThan(0);
    expect(generic).not.toContain('nope');
  });
});
