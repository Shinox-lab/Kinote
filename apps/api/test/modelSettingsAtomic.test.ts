import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readModelSettings, getDb } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import { defaultAnswerProvider, defaultEmbeddingProvider, defaultPlacementModel, ModelProviders, ModelSettingsCache } from '@kinote/core';
import { buildTestApp } from './support/testkit.js';

// The settings row and the jobs it needs commit together: a failed queue step stores nothing, so the control
// plane's retry of the same body still queues the re-index.

const TOKEN = 'a'.repeat(40);
const cp = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

describe('model settings PUT is atomic', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.pglite.close();
  });

  test('a failed queue step stores nothing', async () => {
    const cache = new ModelSettingsCache(() => readModelSettings(getDb()), {
      ASK_PROVIDER: 'openai',
      ASK_MODEL: 'a',
      ROUTER_PROVIDER: 'openai',
      ROUTER_MODEL: 'r',
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: defaultEmbeddingProvider.model,
      MODEL_CREDIT_RATES: undefined,
    });
    const models = new ModelProviders(cache, {
      answer: () => defaultAnswerProvider,
      embedding: () => defaultEmbeddingProvider,
      routing: () => defaultPlacementModel,
    });
    const app = buildTestApp({ models, controlPlaneTokens: [TOKEN] });
    await testDb.pglite.exec('RESET ROLE; ALTER FUNCTION public.cp_queue_model_rebuild(text, boolean, boolean) RENAME TO gone; SET ROLE kinote_app;');
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/internal/v1/model-settings',
        headers: cp,
        payload: JSON.stringify({ askModel: null, routerModel: 'r2', embeddingModel: null, creditRates: null }),
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await testDb.pglite.exec('RESET ROLE; ALTER FUNCTION public.gone(text, boolean, boolean) RENAME TO cp_queue_model_rebuild; SET ROLE kinote_app;');
    }
    expect(await readModelSettings(getDb())).toBeNull();
    expect(cache.current().routerModel).toBe('r');
  });
});
