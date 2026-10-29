import { describe, expect, it, vi } from 'vitest';
import { AppError, type SearchPassage } from '@kinote/contracts';
import {
  DeterministicAnswerProvider,
  NO_RELEVANT_ANSWER,
  OpenAIAnswerProvider,
  createAnswerProvider,
} from '../src/index.js';

const passage = (overrides: Partial<SearchPassage> = {}): SearchPassage => ({
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  versionId: 'version-1',
  versionNumber: 2,
  versionTitle: 'Handbook',
  spaceId: 'space-1',
  icon: null,
  text: 'Laptops arrive on the first day.',
  headingPath: ['Equipment'],
  blockIds: [],
  documentKind: 'page',
  pageFrom: null,
  pageTo: null,
  citeAs: 'Handbook (v2, updated 2026-10-25)',
  rrfScore: 0.5,
  ...overrides,
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(fetchImpl: typeof fetch) {
  return new OpenAIAnswerProvider({
    baseUrl: 'https://chat.example/v1/',
    apiKey: 'test-key',
    model: 'Qwen/Qwen3-8B',
    timeoutMs: 60_000,
    maxTokens: 800,
    fetchImpl,
  });
}

describe('OpenAIAnswerProvider', () => {
  it('posts a grounded prompt with the passage citation', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        choices: [{ message: { content: 'Laptops arrive on day one [Handbook (v2, updated 2026-10-25)].' } }],
      })
    ) as unknown as typeof fetch;

    const result = await provider(fetchImpl).answer({
      question: 'When do laptops arrive?',
      passages: [passage()],
    });

    expect(result).toEqual({
      answer: 'Laptops arrive on day one [Handbook (v2, updated 2026-10-25)].',
      foundRelevant: true,
    });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe('https://chat.example/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('Qwen/Qwen3-8B');
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(800);
    expect(body.stream).toBe(false);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/only the passages provided/i);
    expect(body.messages[0].content).toMatch(/ignore/i);
    expect(body.messages[0].content).toContain(NO_RELEVANT_ANSWER);
    expect(body.messages[1].content).toContain('When do laptops arrive?');
    expect(body.messages[1].content).toContain('Laptops arrive on the first day.');
    expect(body.messages[1].content).toContain('Handbook (v2, updated 2026-10-25)');
  });

  it('maps the exact no-answer sentence to foundRelevant false', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ choices: [{ message: { content: NO_RELEVANT_ANSWER } }] })
    ) as unknown as typeof fetch;

    await expect(
      provider(fetchImpl).answer({ question: 'Unknown?', passages: [passage()] })
    ).resolves.toEqual({ answer: NO_RELEVANT_ANSWER, foundRelevant: false });
  });

  it('maps empty content, non-2xx, timeout and malformed JSON to llm_unavailable', async () => {
    const empty = vi.fn(async () => response({ choices: [{ message: { content: '' } }] })) as unknown as typeof fetch;
    await expect(provider(empty).answer({ question: 'q', passages: [passage()] })).rejects.toMatchObject({
      code: 'llm_unavailable',
    });

    for (const status of [401, 429, 503]) {
      const down = vi.fn(async () => response({ error: 'nope' }, status)) as unknown as typeof fetch;
      await expect(provider(down).answer({ question: 'q', passages: [passage()] })).rejects.toMatchObject({
        code: 'llm_unavailable',
      });
    }

    const malformed = vi.fn(
      async () => new Response('not json', { status: 200 })
    ) as unknown as typeof fetch;
    await expect(provider(malformed).answer({ question: 'q', passages: [passage()] })).rejects.toMatchObject({
      code: 'llm_unavailable',
    });

    const timedOut = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    await expect(provider(timedOut).answer({ question: 'q', passages: [passage()] })).rejects.toMatchObject({
      code: 'llm_unavailable',
    });
  });

  it('does not leak the provider response body', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: 'DO-NOT-LEAK' }, 500)
    ) as unknown as typeof fetch;

    const err = await provider(fetchImpl)
      .answer({ question: 'q', passages: [passage()] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(String((err as Error).message)).not.toContain('DO-NOT-LEAK');
    expect(String((err as Error).cause)).not.toContain('DO-NOT-LEAK');
  });

  it('keeps the deterministic provider for local tests', async () => {
    const result = await new DeterministicAnswerProvider().answer({
      question: 'When?',
      passages: [passage()],
    });
    expect(result.foundRelevant).toBe(true);
    expect(result.answer).toContain('Laptops arrive on the first day.');
    expect(
      createAnswerProvider({
        ASK_PROVIDER: 'deterministic',
        ASK_TIMEOUT_MS: 60_000,
        ASK_MAX_TOKENS: 800,
      })
    ).toBeInstanceOf(DeterministicAnswerProvider);
  });
});
