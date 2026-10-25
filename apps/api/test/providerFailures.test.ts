import { beforeEach, describe, expect, test } from 'vitest';
import { ERROR_SENTENCES } from '@living-wiki/contracts';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from '@living-wiki/core';
import { buildTestApp, bootstrapTenant, useTestDb } from './support/testkit.js';

const down: EmbeddingProvider = {
  model: 'down',
  dimensions: EMBEDDING_DIMENSIONS,
  async embed() {
    throw new Error('provider unavailable');
  },
};

const app = buildTestApp({ embeddingProvider: down });
useTestDb();

describe('query embedding failure', () => {
  let headers: Record<string, string>;

  beforeEach(async () => {
    const ctx = await bootstrapTenant(app, { name: 'Provider failures', slug: 'provider-failures' });
    headers = ctx.headers;
  });

  test('search answers 503 search_unavailable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/search',
      headers,
      payload: { query: 'anything' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'search_unavailable',
      message: ERROR_SENTENCES.search_unavailable,
    });
  });

  test('ask answers 503 search_unavailable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers,
      payload: { question: 'anything?' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'search_unavailable',
      message: ERROR_SENTENCES.search_unavailable,
    });
  });
});
