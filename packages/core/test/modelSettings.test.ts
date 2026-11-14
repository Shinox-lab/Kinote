import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readModelSettings, writeModelSettings } from '@kinote/db';
import { createTestDb, type TestDb } from '@kinote/db/testing';
import type { ModelSettingsInput } from '@kinote/contracts';
import { effectiveModelSettings, ModelSettingsCache, type ModelEnv } from '../src/index.js';

const env: ModelEnv = {
  ASK_PROVIDER: 'openai',
  ASK_MODEL: 'x',
  ROUTER_PROVIDER: 'openai',
  ROUTER_MODEL: 'r',
  EMBEDDING_PROVIDER: 'openai',
  EMBEDDING_MODEL: 'e',
  MODEL_CREDIT_RATES: '{"default":{"input":1,"output":1}}',
};
const none: ModelSettingsInput = { askModel: null, routerModel: null, embeddingModel: null, creditRates: null };

describe('effective model settings', () => {
  it('falls back to env per field', () => {
    const eff = effectiveModelSettings({ ...none, askModel: 'a' }, env);
    expect(eff.askModel).toBe('a');
    expect(eff.routerModel).toBe('r');
    expect(eff.embeddingModel).toBe('e');
    expect(eff.providers).toEqual({ ask: 'openai', router: 'openai', embedding: 'openai' });
  });

  it('stored rates win over MODEL_CREDIT_RATES', () => {
    const rates = { default: { input: 2, output: 3 }, models: { m: { input: 1, output: 1 } } };
    expect(effectiveModelSettings({ ...none, creditRates: rates }, env).creditRates).toEqual(rates);
    expect(effectiveModelSettings(null, env).creditRates).toEqual({ default: { input: 1, output: 1 }, models: {} });
  });

  it('cache starts from env and keeps the last value when a load throws', async () => {
    const load = vi.fn<() => Promise<ModelSettingsInput | null>>();
    load.mockResolvedValueOnce({ ...none, askModel: 'first' }).mockRejectedValueOnce(new Error('db down'));
    const cache = new ModelSettingsCache(load, env);
    expect(cache.current().askModel).toBe('x');
    await cache.refresh();
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cache.refresh();
    warn.mockRestore();
    expect(cache.current().askModel).toBe('first');
  });
});

describe('stored model settings', () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  beforeEach(async () => {
    await testDb.reset();
  });
  afterAll(async () => {
    await testDb.pglite.close();
  });

  it('write then read round-trips; nothing stored reads null', async () => {
    expect(await readModelSettings(testDb.db)).toBeNull();
    const value = { askModel: 'a', routerModel: null, embeddingModel: 'e2', creditRates: { default: { input: 0.5, output: 1 }, models: {} } };
    await writeModelSettings(testDb.db, value);
    expect(await readModelSettings(testDb.db)).toEqual(value);
  });
});
