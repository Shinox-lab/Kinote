import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ERROR_SENTENCES, VersionSummarySchema } from '@living-wiki/contracts';
import { ApiError, api, errorSentence, request, setApiBase, setSession } from '../src/lib/api.js';

const TENANT = '3f1c2b0e-6d2c-4a52-9c83-8f1f7c2b1a11';

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
    setApiBase('');
    setSession({ token: 'tok-123', tenantId: TENANT });
  });
  afterEach(() => {
    setSession(null);
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

  test('sends neither header without a session, and prefixes the API base', async () => {
    setSession(null);
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

  test('errorSentence gives the contract sentence, or a generic one that never contains the code', () => {
    expect(errorSentence('space_not_found')).toBe(ERROR_SENTENCES.space_not_found);
    const generic = errorSentence('nope');
    expect(generic.length).toBeGreaterThan(0);
    expect(generic).not.toContain('nope');
  });
});
