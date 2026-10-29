import { beforeEach, describe, expect, test } from 'vitest';
import { ERROR_SENTENCES } from '@kinote/contracts';
import {
  EMBEDDING_DIMENSIONS,
  defaultEmbeddingProvider,
  type AnswerProvider,
  type EmbeddingProvider,
} from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { buildTestApp, bootstrapTenant, useTestDb } from './support/testkit.js';

const downstream: AnswerProvider = {
  async answer() {
    throw new Error('chat model down');
  },
};

let answerCalls = 0;
const counting: AnswerProvider = {
  async answer({ passages }) {
    answerCalls += 1;
    return { answer: `count ${passages.length}`, foundRelevant: true };
  },
};

const embeddingDown: EmbeddingProvider = {
  model: 'down',
  dimensions: EMBEDDING_DIMENSIONS,
  async embed() {
    throw new Error('embedding down');
  },
};

const failingApp = buildTestApp({ answerProvider: downstream });
const countingApp = buildTestApp({ answerProvider: counting });
const embeddingApp = buildTestApp({ embeddingProvider: embeddingDown, answerProvider: counting });
useTestDb();

async function indexedPage(
  app: ReturnType<typeof buildTestApp>,
  headers: Record<string, string>,
  tenant: string
) {
  const spaceRes = await app.inject({
    method: 'POST',
    url: '/api/v1/spaces',
    headers,
    payload: { name: 'Ask space', slug: 'ask-space', review_required: false },
  });
  expect(spaceRes.statusCode).toBe(201);
  const spaceId = spaceRes.json().id as string;
  const pageRes = await app.inject({
    method: 'POST',
    url: '/api/v1/pages',
    headers,
    payload: {
      space_id: spaceId,
      title: 'Laptop policy',
      slug: 'laptop-policy',
      markdown: 'Laptops arrive on the first day.',
    },
  });
  expect(pageRes.statusCode).toBe(201);
  const pageId = pageRes.json().id as string;
  const snap = await app.inject({
    method: 'POST',
    url: `/api/v1/pages/${pageId}/snapshot`,
    headers,
  });
  expect(snap.statusCode).toBe(201);
  await runPendingJobsForTenant(tenant, { embeddingProvider: defaultEmbeddingProvider });
}

let tenantId: string;
let headers: Record<string, string>;

beforeEach(async () => {
  answerCalls = 0;
  const ctx = await bootstrapTenant(failingApp, { name: 'Ask failures', slug: 'ask-failures' });
  tenantId = ctx.tenant.id;
  headers = ctx.headers;
});

describe('Ask failures', () => {
  test('a model failure is 503 llm_unavailable', async () => {
    await indexedPage(failingApp, headers, tenantId);
    const res = await failingApp.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers,
      payload: { question: 'When do laptops arrive?' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'llm_unavailable',
      message: ERROR_SENTENCES.llm_unavailable,
    });
  });

  test('no passages never calls the answer provider', async () => {
    const ctx = await bootstrapTenant(countingApp, { name: 'Empty', slug: 'empty' });
    const res = await countingApp.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: ctx.headers,
      payload: { question: 'Anything?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().foundRelevant).toBe(false);
    expect(answerCalls).toBe(0);
  });

  test('an embedding failure is 503 search_unavailable and never reaches the model', async () => {
    const ctx = await bootstrapTenant(embeddingApp, { name: 'Embedding down', slug: 'embedding-down' });
    const res = await embeddingApp.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: ctx.headers,
      payload: { question: 'Anything?' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('search_unavailable');
    expect(answerCalls).toBe(0);
  });

  test('a slow model does not hold the database transaction', async () => {
    let started!: () => void;
    let release!: () => void;
    const providerStarted = new Promise<void>((resolve) => (started = resolve));
    const modelDone = new Promise<void>((resolve) => (release = resolve));
    const slow: AnswerProvider = {
      async answer() {
        started();
        await modelDone;
        return { answer: 'done', foundRelevant: true };
      },
    };
    const slowApp = buildTestApp({ answerProvider: slow });
    const ctx = await bootstrapTenant(slowApp, { name: 'Slow model', slug: 'slow-model' });
    await indexedPage(slowApp, ctx.headers, ctx.tenant.id);

    const askPromise = slowApp.inject({
      method: 'POST',
      url: '/api/v1/ask',
      headers: ctx.headers,
      payload: { question: 'When do laptops arrive?' },
    });
    await providerStarted;

    const spaces = await Promise.race([
      slowApp.inject({ method: 'GET', url: '/api/v1/spaces', headers: ctx.headers }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('database was blocked by the model call')), 1000)
      ),
    ]);
    expect(spaces.statusCode).toBe(200);

    release();
    expect((await askPromise).statusCode).toBe(200);
  });
});
