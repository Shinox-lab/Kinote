import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tenants, usageEvents, withTenantTx } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import {
  DeterministicAnswerProvider,
  DeterministicEmbeddingProvider,
  DeterministicPlacementModel,
  OpenAIAnswerProvider,
  OpenAIEmbeddingProvider,
  chatJson,
  withUsageScope,
} from '../src/index.js';

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});

async function metered(fn: () => Promise<unknown>) {
  const tenantId = randomUUID();
  await withTenantTx(tenantId, (tx) => tx.insert(tenants).values({ id: tenantId, name: tenantId, slug: tenantId }));
  await withUsageScope({ tenantId, kind: 'index' }, null, async () => {
    await fn();
  });
  return withTenantTx(tenantId, (tx) => tx.select().from(usageEvents));
}

const json = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const vec = () => new Array(2560).fill(0.01);
const passage = { text: 'Leave is 20 days.', citeAs: 'HR §1', title: 'HR', documentKind: 'page', pageFrom: null, pageTo: null, headingPath: [] } as never;

describe('providers report model calls', () => {
  it('OpenAI embeddings read prompt_tokens, and estimate when it is missing', async () => {
    const withUsage = new OpenAIEmbeddingProvider({
      baseUrl: 'https://m.example/v1', model: 'emb', batchSize: 64, timeoutMs: 1000,
      fetchImpl: json({ data: [{ index: 0, embedding: vec() }], usage: { prompt_tokens: 7 } }) as typeof fetch,
    });
    const without = new OpenAIEmbeddingProvider({
      baseUrl: 'https://m.example/v1', model: 'emb', batchSize: 64, timeoutMs: 1000,
      fetchImpl: json({ data: [{ index: 0, embedding: vec() }] }) as typeof fetch,
    });
    const a = await metered(() => withUsage.embed(['hello world']));
    expect(a).toMatchObject([{ model: 'emb', inputTokens: 7, outputTokens: 0, estimated: false }]);
    const b = await metered(() => without.embed(['hello world!']));
    expect(b).toMatchObject([{ model: 'emb', inputTokens: 3, estimated: true }]);
  });

  it('the deterministic embedding reports estimated tokens under its model id', async () => {
    const rows = await metered(() => new DeterministicEmbeddingProvider().embed(['abcd', 'abcdefgh']));
    expect(rows).toMatchObject([{ model: 'kinote-deterministic-2560-v1', inputTokens: 3, estimated: true }]);
  });

  it('chatJson reports prompt and completion tokens', async () => {
    const rows = await metered(() =>
      chatJson(
        { baseUrl: 'https://m.example/v1', model: 'router', timeoutMs: 1000, maxTokens: 100,
          fetchImpl: json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 11, completion_tokens: 4 } }) as typeof fetch },
        { system: 's', user: 'u', schema: z.object({ ok: z.boolean() }) }
      )
    );
    expect(rows).toMatchObject([{ model: 'router', inputTokens: 11, outputTokens: 4, estimated: false }]);
  });

  it('OpenAI answers read usage', async () => {
    const provider = new OpenAIAnswerProvider({
      baseUrl: 'https://m.example/v1', model: 'asker', timeoutMs: 1000, maxTokens: 100,
      fetchImpl: json({ choices: [{ message: { content: 'An answer' } }], usage: { prompt_tokens: 50, completion_tokens: 9 } }) as typeof fetch,
    });
    const rows = await metered(() => provider.answer({ question: 'q', passages: [passage] }));
    expect(rows).toMatchObject([{ model: 'asker', inputTokens: 50, outputTokens: 9, estimated: false }]);
  });

  it('deterministic answers and placement report estimated tokens', async () => {
    const a = await metered(() => new DeterministicAnswerProvider().answer({ question: 'how much leave?', passages: [passage] }));
    expect(a).toMatchObject([{ model: 'deterministic-answer-v1', estimated: true }]);
    expect(a[0]!.inputTokens).toBeGreaterThan(0);
    expect(a[0]!.outputTokens).toBeGreaterThan(0);
    const p = await metered(() => new DeterministicPlacementModel().summarizePage({ title: 'T', outline: [], markdown: 'Some text here.' }));
    expect(p).toMatchObject([{ model: 'deterministic-placement-v1', estimated: true }]);
  });
});
