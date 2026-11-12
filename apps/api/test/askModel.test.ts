import { describe, expect, test } from 'vitest';
import {
  defaultAnswerProvider,
  defaultEmbeddingProvider,
  defaultPlacementModel,
  ModelProviders,
  ModelSettingsCache,
  type AnswerProvider,
} from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

// Ask answers with the workspace's model (tenant_limits.ask_model), else the deployment's.

const TOKEN = 'm'.repeat(40);
const seen: (string | null)[] = [];
const cache = new ModelSettingsCache(async () => null, {
  ASK_PROVIDER: 'openai',
  ASK_MODEL: 'deployment-model',
  ROUTER_PROVIDER: 'deterministic',
  ROUTER_MODEL: undefined,
  EMBEDDING_PROVIDER: 'deterministic',
  EMBEDDING_MODEL: undefined,
  MODEL_CREDIT_RATES: undefined,
});
const models = new ModelProviders(cache, {
  answer: (model): AnswerProvider => ({
    answer: (input) => {
      seen.push(model);
      return defaultAnswerProvider.answer(input);
    },
  }),
  embedding: () => defaultEmbeddingProvider,
  routing: () => defaultPlacementModel,
});

describe('ask model per workspace', () => {
  const app = buildTestApp({ models, controlPlaneTokens: [TOKEN] });
  useTestDb();

  async function workspaceWithPage(slug: string) {
    const ctx = await bootstrapTenant(app, { name: slug, slug });
    const space = await app.inject({ method: 'POST', url: '/api/v1/spaces', headers: ctx.headers, payload: { name: 'S', slug: 's', review_required: false } });
    const page = await app.inject({
      method: 'POST',
      url: '/api/v1/pages',
      headers: ctx.headers,
      payload: { space_id: space.json().id, title: 'Laptop policy', slug: 'laptop-policy', markdown: 'Laptops arrive on the first day.' },
    });
    await app.inject({ method: 'POST', url: `/api/v1/pages/${page.json().id}/snapshot`, headers: ctx.headers });
    await runPendingJobsForTenant(ctx.tenant.id, { embeddingProvider: defaultEmbeddingProvider });
    return ctx;
  }
  const ask = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/v1/ask', headers, payload: { question: 'When do laptops arrive?' } });

  test("ask uses the workspace's askModel, others the deployment default", async () => {
    const a = await workspaceWithPage('pro-co');
    const b = await workspaceWithPage('free-co');
    const put = await app.inject({
      method: 'PUT',
      url: `/internal/v1/tenants/${a.tenant.id}/limits`,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ plan: 'pro', seats: null, storageBytes: null, creditsPerMonth: null, indexCreditsPerMonth: null, askModel: 'pro' }),
    });
    expect(put.statusCode, put.body).toBe(200);
    seen.length = 0;
    expect((await ask(a.headers)).statusCode).toBe(200);
    expect((await ask(b.headers)).statusCode).toBe(200);
    expect(seen).toEqual(['pro', 'deployment-model']);
  });
});
