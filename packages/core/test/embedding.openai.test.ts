import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@kinote/contracts';
import {
  EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
} from '../src/index.js';

const vector = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => seed / 10);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof OpenAIEmbeddingProvider>[0]> = {}
) {
  return new OpenAIEmbeddingProvider({
    baseUrl: 'https://models.example/v1/',
    apiKey: 'test-key',
    model: 'Qwen/Qwen3-Embedding-8B',
    batchSize: 64,
    timeoutMs: 30_000,
    fetchImpl,
    ...overrides,
  });
}

describe('OpenAIEmbeddingProvider', () => {
  it('posts the model, input and fixed 2560 dimensions with bearer auth', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: [
          { index: 0, embedding: vector(1) },
          { index: 1, embedding: vector(2) },
        ],
      })
    ) as unknown as typeof fetch;

    const out = await provider(fetchImpl).embed(['first', 'second']);

    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe('https://models.example/v1/embeddings');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'Qwen/Qwen3-Embedding-8B',
      input: ['first', 'second'],
      dimensions: 2560,
    });
  });

  it('batches requests and restores the response order by index', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return response({
        data: [
          { index: 1, embedding: vector(call * 2) },
          { index: 0, embedding: vector(call * 2 - 1) },
        ],
      });
    }) as unknown as typeof fetch;

    const out = await provider(fetchImpl, { batchSize: 2 }).embed(['a', 'b', 'c', 'd']);

    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(4);
    expect(out[0]?.[0]).toBeCloseTo(0.1);
    expect(out[1]?.[0]).toBeCloseTo(0.2);
    expect(out[2]?.[0]).toBeCloseTo(0.3);
    expect(out[3]?.[0]).toBeCloseTo(0.4);
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body)).input).toEqual(['a', 'b']);
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[1]![1]?.body)).input).toEqual(['c', 'd']);
  });

  it('adds the Qwen query instruction only to query calls', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ data: [{ index: 0, embedding: vector(1) }] })
    ) as unknown as typeof fetch;
    const p = provider(fetchImpl, {
      queryInstruction: 'Given a wiki search query, retrieve relevant passages',
    });

    await p.embed(['plain chunk']);
    await p.embed(['find this'], 'query');

    const documentBody = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]![1]?.body));
    const queryBody = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[1]![1]?.body));
    expect(documentBody.input).toEqual(['plain chunk']);
    expect(queryBody.input).toEqual([
      'Instruct: Given a wiki search query, retrieve relevant passages\nQuery: find this',
    ]);
  });

  it('rejects a wrong vector count without leaking the response body', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ data: [], secret: 'DO-NOT-LEAK' })
    ) as unknown as typeof fetch;

    const err = await provider(fetchImpl).embed(['one']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'embedding_unavailable' });
    expect(String((err as Error).message)).not.toContain('DO-NOT-LEAK');
    expect(String((err as Error).cause)).not.toContain('DO-NOT-LEAK');
  });

  it('rejects a vector with the wrong dimension', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ data: [{ index: 0, embedding: [1, 2, 3] }] })
    ) as unknown as typeof fetch;

    await expect(provider(fetchImpl).embed(['one'])).rejects.toMatchObject({
      code: 'embedding_unavailable',
    });
  });

  it('rejects 401, 429, malformed JSON, a timeout and a network failure as embedding_unavailable', async () => {
    for (const status of [401, 429, 503]) {
      const down = vi.fn(async () => response({ error: 'nope' }, status)) as unknown as typeof fetch;
      await expect(provider(down).embed(['one'])).rejects.toMatchObject({
        code: 'embedding_unavailable',
      });
    }

    const malformed = vi.fn(
      async () => new Response('not json', { status: 200 })
    ) as unknown as typeof fetch;
    await expect(provider(malformed).embed(['one'])).rejects.toMatchObject({
      code: 'embedding_unavailable',
    });

    const timedOut = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    await expect(provider(timedOut).embed(['one'])).rejects.toMatchObject({
      code: 'embedding_unavailable',
    });

    const broken = vi.fn(async () => {
      throw new Error('socket closed');
    }) as unknown as typeof fetch;
    await expect(provider(broken).embed(['one'])).rejects.toMatchObject({
      code: 'embedding_unavailable',
    });
  });

  it('builds the deterministic provider without an endpoint', () => {
    const p = createEmbeddingProvider({
      EMBEDDING_PROVIDER: 'deterministic',
      EMBEDDING_BATCH_SIZE: 64,
      EMBEDDING_TIMEOUT_MS: 30_000,
    });
    expect(p.model).toContain('deterministic');
    expect(p.dimensions).toBe(EMBEDDING_DIMENSIONS);
  });
});
