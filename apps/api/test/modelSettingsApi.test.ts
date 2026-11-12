import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, jobs, readModelSettings, withTenantTx } from '@kinote/db';
import { InfoSchema, ModelSettingsReplySchema } from '@kinote/contracts';
import {
  defaultAnswerProvider,
  defaultEmbeddingProvider,
  defaultPlacementModel,
  EMBEDDING_DIMENSIONS,
  ModelProviders,
  ModelSettingsCache,
  type EmbeddingProvider,
  type ModelEnv,
} from '@kinote/core';
import { runPendingJobsForTenant } from '../../worker/src/runner.js';
import { bootstrapTenant, buildTestApp, useTestDb } from './support/testkit.js';

// GET/PUT /internal/v1/model-settings: the control plane sets the deployment's models and rate table.

const TOKEN = 's'.repeat(40);
const cp = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const openaiEnv: ModelEnv = {
  ASK_PROVIDER: 'openai',
  ASK_MODEL: 'env-ask',
  ROUTER_PROVIDER: 'openai',
  ROUTER_MODEL: 'env-router',
  EMBEDDING_PROVIDER: 'openai',
  EMBEDDING_MODEL: 'kinote-deterministic-2560-v1',
  MODEL_CREDIT_RATES: undefined,
};
let probeWidth = EMBEDDING_DIMENSIONS;
/** Embeddings: the deterministic vectors, named after the model asked for; `narrow` answers 1024 dimensions. */
const embeddingFor = (model: string | null): EmbeddingProvider => ({
  model: model ?? 'none',
  get dimensions() {
    return probeWidth;
  },
  embed: async (texts) => {
    if (model === 'narrow') return texts.map(() => new Array(1024).fill(0));
    if (model === 'down') throw new Error('gateway down');
    return defaultEmbeddingProvider.embed(texts);
  },
});

function appWith(env: ModelEnv) {
  const cache = new ModelSettingsCache(() => readModelSettings(getDb()), env);
  const models = new ModelProviders(cache, {
    answer: () => defaultAnswerProvider,
    embedding: embeddingFor,
    routing: () => defaultPlacementModel,
  });
  return { app: buildTestApp({ models, controlPlaneTokens: [TOKEN] }), cache };
}

const none = { askModel: null, routerModel: null, embeddingModel: null, creditRates: null };

describe('model settings API', () => {
  const { app, cache } = appWith(openaiEnv);
  const deterministic = appWith({ ...openaiEnv, ASK_PROVIDER: 'deterministic', ASK_MODEL: undefined });
  useTestDb();

  const get = () => app.inject({ method: 'GET', url: '/internal/v1/model-settings', headers: cp });
  const put = (body: unknown, target = app) =>
    target.inject({ method: 'PUT', url: '/internal/v1/model-settings', headers: cp, payload: JSON.stringify(body) });

  async function indexedWorkspace(slug: string) {
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
  const operatorJobs = (tenantId: string) =>
    withTenantTx(tenantId, async (tx) =>
      (await tx.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, 'queued')))).filter(
        (j) => (j.payload as { operator?: boolean }).operator === true
      )
    );

  test('info lists model_settings', async () => {
    const info = InfoSchema.parse((await app.inject({ method: 'GET', url: '/internal/v1/info', headers: cp })).json());
    expect(info.features).toContain('model_settings');
  });

  test('GET answers stored nulls and the env values in effect, never an endpoint or key', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = ModelSettingsReplySchema.parse(res.json());
    expect(body.stored).toEqual(none);
    expect(body.effective).toMatchObject({ askModel: 'env-ask', routerModel: 'env-router', providers: { ask: 'openai' } });
    expect(body.reindex.pendingJobs).toBe(0);
    expect(res.body).not.toMatch(/apiKey|baseUrl|BASE_URL|API_KEY/);
  });

  test('PUT stores, GET reflects it, and this process uses it at once', async () => {
    const rates = { default: { input: 0.5, output: 2 }, models: { 'pro-model': { input: 1, output: 4 } } };
    const res = await put({ ...none, askModel: 'pro-model', creditRates: rates });
    expect(res.statusCode, res.body).toBe(200);
    expect(ModelSettingsReplySchema.parse(res.json()).stored).toMatchObject({ askModel: 'pro-model', creditRates: rates });
    expect(ModelSettingsReplySchema.parse((await get()).json()).effective.askModel).toBe('pro-model');
    expect(cache.current().askModel).toBe('pro-model');
  });

  test('a bad rate table is 422 invalid_model_settings on creditRates, nothing stored', async () => {
    const res = await put({ ...none, creditRates: { default: { input: -1, output: 0 }, models: {} } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'invalid_model_settings', field: 'creditRates' });
    expect(await readModelSettings(getDb())).toBeNull();
  });

  test('a model for a deterministic provider is 422 on that field', async () => {
    const res = await put({ ...none, askModel: 'gpt' }, deterministic.app);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'invalid_model_settings', field: 'askModel' });
  });

  test('an embedding model that fails the probe is 422 and the stored settings stay', async () => {
    expect((await put({ ...none, askModel: 'kept' })).statusCode).toBe(200);
    for (const embeddingModel of ['narrow', 'down']) {
      const res = await put({ ...none, askModel: 'other', embeddingModel });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'invalid_model_settings', field: 'embeddingModel' });
    }
    expect((await readModelSettings(getDb()))?.askModel).toBe('kept');
  });

  test('an embedding change queues free re-index jobs (each queues its own placement); the reply counts them', async () => {
    const w = await indexedWorkspace('embed-co');
    const res = await put({ ...none, embeddingModel: 'e2' });
    expect(res.statusCode, res.body).toBe(200);
    const body = ModelSettingsReplySchema.parse(res.json());
    expect(body.queued!.reindex).toBeGreaterThanOrEqual(1);
    expect(body.queued!.placement).toBe(0);
    const queued = await operatorJobs(w.tenant.id);
    expect(queued.map((j) => j.queue)).toContain('document.reindex');
    expect(ModelSettingsReplySchema.parse((await get()).json()).reindex.pendingJobs).toBe(queued.length);
  });

  test('a router change queues placement only', async () => {
    const w = await indexedWorkspace('router-co');
    const body = ModelSettingsReplySchema.parse((await put({ ...none, routerModel: 'r2' })).json());
    expect(body.queued).toMatchObject({ reindex: 0 });
    expect(body.queued!.placement).toBeGreaterThanOrEqual(1);
    expect((await operatorJobs(w.tenant.id)).map((j) => j.queue)).not.toContain('document.reindex');
  });

  test('an unchanged body queues nothing', async () => {
    const w = await indexedWorkspace('same-co');
    await put({ ...none, routerModel: 'r2', embeddingModel: 'e2' });
    await withTenantTx(w.tenant.id, (tx) => tx.delete(jobs).where(eq(jobs.tenantId, w.tenant.id)));
    const body = ModelSettingsReplySchema.parse((await put({ ...none, routerModel: 'r2', embeddingModel: 'e2' })).json());
    expect(body.queued).toEqual({ reindex: 0, placement: 0 });
    expect(await operatorJobs(w.tenant.id)).toHaveLength(0);
  });

  test('end to end: rates set through PUT make an Ask charge credits', async () => {
    const w = await indexedWorkspace('charge-co');
    const rates = { default: { input: 0, output: 0 }, models: { 'deterministic-answer-v1': { input: 1, output: 1 } } };
    expect((await put({ ...none, creditRates: rates })).statusCode).toBe(200);
    const ask = await app.inject({ method: 'POST', url: '/api/v1/ask', headers: w.headers, payload: { question: 'When do laptops arrive?' } });
    expect(ask.statusCode, ask.body).toBe(200);
    const usage = await app.inject({ method: 'GET', url: '/api/v1/usage', headers: w.headers });
    expect(usage.json().usedCredits).toBeGreaterThan(0);
  });

  test('an operator re-index queues its placement follow-ups as operator jobs; the PUT queues no second pass', async () => {
    const w = await indexedWorkspace('follow-co');
    const body = ModelSettingsReplySchema.parse((await put({ ...none, embeddingModel: 'e2' })).json());
    expect(body.queued).toMatchObject({ placement: 0 });
    expect(body.queued!.reindex).toBeGreaterThanOrEqual(1);
    await runPendingJobsForTenant(w.tenant.id, { embeddingProvider: embeddingFor('e2') });
    const followUps = await withTenantTx(w.tenant.id, async (tx) =>
      (await tx.select().from(jobs).where(eq(jobs.tenantId, w.tenant.id))).filter((j) => j.queue === 'version.card' || j.queue === 'version.entities')
    );
    expect(followUps.length).toBeGreaterThanOrEqual(1);
    for (const j of followUps) expect((j.payload as { operator?: boolean }).operator).toBe(true);
  });

  test('askModel on limits or defaults while ASK_PROVIDER is deterministic is 422', async () => {
    const ctx = await bootstrapTenant(deterministic.app, { name: 'Det', slug: 'det-co' });
    const limits = { plan: 'pro', seats: null, storageBytes: null, creditsPerMonth: null, indexCreditsPerMonth: null };
    const res = await deterministic.app.inject({
      method: 'PUT',
      url: `/internal/v1/tenants/${ctx.tenant.id}/limits`,
      headers: cp,
      payload: JSON.stringify({ ...limits, askModel: 'gpt' }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'invalid_model_settings', field: 'askModel' });
    const defaults = await deterministic.app.inject({
      method: 'PUT',
      url: '/internal/v1/defaults',
      headers: cp,
      payload: JSON.stringify({ ...limits, plan: 'free', maxFreePerOwner: null, askModel: 'gpt' }),
    });
    expect(defaults.statusCode).toBe(422);
    // Null (the deployment's model) is fine.
    const ok = await deterministic.app.inject({
      method: 'PUT',
      url: `/internal/v1/tenants/${ctx.tenant.id}/limits`,
      headers: cp,
      payload: JSON.stringify({ ...limits, askModel: null }),
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

